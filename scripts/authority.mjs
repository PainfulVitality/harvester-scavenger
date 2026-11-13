import { matchingTool, checkKey } from "./tools.mjs";
import { ID, availability, defaultState, evaluateHarvest, remainingHarvests } from "./rules.mjs";
import { isHarvest, isDefeated, usesLootWording, readHarvest, removeHarvest, saveRules, writeState } from "./store.mjs";
import { nodeText } from "./wording.mjs";
import { collectRewards, deliverRewards, lookup, postReceipt, rewardPreview, revealedItem } from "./rewards.mjs";
import { canConfigure, distanceWarning, gridDistance, inRange, interactionDistance } from "./interaction.mjs";

const leases = new Map();
const operations = new Map();
const appearanceUpdates = new Map();
let appearanceRevision = 0;
const leaseDuration = 5 * 60 * 1000;
let socket;

class HarvestError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new HarvestError(message);
}

async function runExclusive(key, operation) {
  const prior = operations.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  operations.set(key, current);
  try {
    return await current;
  } finally {
    if (operations.get(key) === current) operations.delete(key);
  }
}

function leaseFor(uuid) {
  const lease = leases.get(uuid);
  if (lease && lease.expires > Date.now()) return lease;
  leases.delete(uuid);
  return null;
}

async function resolveTarget(uuid, user) {
  const token = await lookup(uuid, "Token");
  requireCondition(isHarvest(token), "This token is no longer a harvest.");
  requireCondition(user.isGM || (!token.hidden && !token.isSecret && user.viewedScene === token.parent.id),
    "This harvest is unavailable on your current scene.");
  return token;
}

async function resolveHarvester(uuid, user, target, distance = Infinity) {
  const document = await fromUuid(uuid);
  let token = document?.documentName === "Token" ? document : null;
  const actor = token?.actor ?? (document?.documentName === "Actor" && !document.pack ? document : null);
  requireCondition(actor?.testUserPermission(user, "OWNER")
    && (!token || token.parent.id === target.parent.id)
    && actor.uuid !== target.actor?.uuid && !isHarvest(token),
  "Choose one of your own characters to harvest with.");
  if (!token) {
    token = target.parent.tokens.filter(candidate => candidate.actor?.uuid === actor.uuid && !candidate.hidden
      && !isHarvest(candidate)).sort((first, second) => gridDistance(first, target) - gridDistance(second, target))[0] ?? null;
  }
  requireCondition(user.isGM || distance === Infinity || (token && !token.hidden && inRange(token, target, distance, user)),
    distanceWarning(distance, usesLootWording(target)));
  return { actor, token };
}

function nodeStatus(rules, state, token) {
  return rules.defeatedOnly && !isDefeated(token) ? "blocked" : availability(rules, state);
}

function requireDefeated(rules, token) {
  requireCondition(!rules.defeatedOnly || isDefeated(token), nodeText("Harvest is available only at 0 hit points or fewer.", rules.lootMode));
}

function summary(rules, state, token) {
  const remaining = remainingHarvests(rules, state);
  return {
    name: rules.name || token.name,
    img: token.actor?.img ?? token.texture.src,
    mode: rules.mode, key: checkKey(rules), dc: rules.dc,
    status: nodeStatus(rules, state, token), defeatedOnly: Boolean(rules.defeatedOnly), lootMode: Boolean(rules.lootMode), harvestLimit: rules.harvestLimit, harvests: state.harvests,
    failures: state.failures, remaining: Number.isFinite(remaining) ? remaining : null,
    lastOutcome: state.lastOutcome ?? (state.failures ? "failure" : null),
    distance: interactionDistance(rules) === Infinity ? 0 : interactionDistance(rules),
    busy: Boolean(leaseFor(token.uuid))
  };
}

async function view(token, user) {
  const { rules, state } = await readHarvest(token);
  const distance = interactionDistance(rules);
  requireCondition(canConfigure(token, user) || distance === Infinity || token.parent.tokens.some(candidate =>
    candidate.actor?.testUserPermission(user, "OWNER") && !candidate.hidden && !isHarvest(candidate)
    && candidate.actor.uuid !== token.actor?.uuid && inRange(candidate, token, distance, user)), distanceWarning(distance, rules.lootMode));
  const description = document.createElement("template");
  description.innerHTML = rules.description;
  description.content.querySelectorAll("section.secret:not(.revealed)").forEach(secret => secret.remove());
  return { ...summary(rules, state, token), description: description.innerHTML, ...await rewardPreview(rules) };
}

async function begin(token, user, { actorUuid }) {
  requireCondition(!leaseFor(token.uuid), "Someone is already harvesting this token.");
  const { rules, state, recipe } = await readHarvest(token);
  requireDefeated(rules, token);
  const harvester = await resolveHarvester(actorUuid, user, token, interactionDistance(rules));
  requireCondition(rules.mode !== "tool" || matchingTool(harvester.actor, rules.tool),
    "The selected character needs the required tool in their inventory.");
  const status = availability(rules, state);
  requireCondition(status === "ready", status === "locked"
    ? "This harvest is locked until the GM unlocks it." : "This harvest is depleted.");
  const nonce = foundry.utils.randomID();
  const lease = { nonce, user: user.id, actorUuid, recipe, expires: Date.now() + leaseDuration };
  leases.set(token.uuid, lease);
  setTimeout(() => {
    if (leases.get(token.uuid) !== lease) return;
    leases.delete(token.uuid);
    broadcast(token.uuid);
  }, leaseDuration);
  broadcast(token.uuid);
  return { nonce, mode: rules.mode, key: checkKey(rules), dc: rules.dc };
}

function readRoll(messageId, user, lease, harvester, rules) {
  const message = game.messages.get(messageId);
  const mark = message?.getFlag(ID, "check");
  const roll = message?.rolls[0];
  const kept = roll?.d20?.results.find(result => result.active && !result.discarded)?.result;
  requireCondition(message?.author?.id === user.id && message.type === "check"
    && mark?.nonce === lease.nonce && mark?.actorUuid === harvester.actor.uuid
    && message.speaker?.actor === harvester.actor.id
    && (!harvester.token || message.speaker?.token === harvester.token.id)
    && message.system?.[rules.mode === "skill" ? "skill" : rules.mode === "tool" ? "tool" : "ability"] === (checkKey(rules))
    && Number.isFinite(roll?.total) && Number.isInteger(kept) && kept >= 1 && kept <= 20,
  "The D&D check could not be verified. Please try again.");
  return { message, total: roll.total, natural: kept };
}

async function executeMacro(macro, node, harvester, user, outcome) {
  const speaker = CONFIG.ChatMessage.documentClass.getSpeaker({ actor: harvester.actor, token: harvester.token });
  return macro.execute({
    speaker, actor: harvester.actor, token: harvester.token?.object ?? null,
    harvest: { node, token: harvester.token, user, ...outcome }
  });
}

function playOutcomeSound(lootMode, success) {
  const src = `modules/${ID}/assets/${lootMode ? "loot" : "harvest"}${success ? "Success" : "Failure"}.mp3`;
  const volume = lootMode ? 0.5 : success ? 0.65 : 0.35;
  try {
    // The active GM broadcasts once using Foundry's normal interface-sound channel.
    // Do not await autoplay permission: a muted/locked client must not delay rewards.
    const playback = foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false, channel: "interface" }, true);
    playback?.catch?.(error => console.warn(`${ID} | Could not play outcome sound`, error));
  } catch (error) {
    console.warn(`${ID} | Could not play outcome sound`, error);
  }
}

async function finish(token, user, lease, messageId) {
  const { rules, state, stateRecord, recipe } = await readHarvest(token);
  requireDefeated(rules, token);
  requireCondition(recipe === lease.recipe && availability(rules, state) === "ready",
    "The GM changed this harvest. Please try again.");
  const harvester = await resolveHarvester(lease.actorUuid, user, token, interactionDistance(rules));
  requireCondition(rules.mode !== "tool" || matchingTool(harvester.actor, rules.tool),
    "The required tool is no longer in your inventory.");
  const roll = rules.mode === "free" ? null : readRoll(messageId, user, lease, harvester, rules);
  const result = evaluateHarvest(rules, state, roll, game.settings.get(ID, "doubleCritical"),
    game.settings.get(ID, "automaticFailure"));
  let rewards = [];
  let macro;
  if (result.success) {
    try {
      if (rules.macro) {
        macro = await lookup(rules.macro, "Macro");
        if (!macro?.canExecute) throw new Error("The configured macro is missing or cannot run.");
        if (rules.macroClient === "player" && !user.isGM) {
          requireCondition(macro.testUserPermission(user, "LIMITED")
            && (!macro.compendium || macro.compendium.testUserPermission(user, "OBSERVER")),
          "The GM needs to check this harvest before you can continue.");
        }
      }
      rewards = await collectRewards(result.sources, result.multiplier);
    } catch (error) {
      if (error instanceof HarvestError) throw error;
      console.error(`${ID} | Could not prepare rewards for ${token.name}`, error);
      ui.notifications.error(`Could not prepare harvest rewards for ${token.name}. See the console for details.`);
      throw new HarvestError("The GM needs to check this harvest’s rewards.");
    }
  }

  await writeState(token, result.next, stateRecord);
  let items = [];
  let effectOccurred = false;
  let warning;
  try {
    items = await runExclusive(`inventory:${harvester.actor.uuid}`, () =>
      deliverRewards(rewards, harvester.actor, lease.nonce));
    if (macro) {
      const outcome = { outcome: result.outcome, total: result.total, natural: result.natural };
      if (rules.macroClient === "player" && !user.isSelf) {
        if (roll?.message.blind) {
          outcome.total = null;
          outcome.natural = null;
        }
        const ran = await socket.executeAsUser("runMacro", user.id, macro.uuid, token.uuid, lease.actorUuid, outcome);
        if (!ran) throw new Error("The harvesting client could not execute the configured macro.");
      } else {
        await executeMacro(macro, token, harvester, user, outcome);
      }
      effectOccurred = true;
    }
  } catch (error) {
    console.error(`${ID} | Harvest recorded but reward delivery failed for ${token.name}`, error);
    ui.notifications.error(`Harvest recorded for ${token.name}. Review reward delivery before resetting it.`);
    warning = "Harvest recorded. Ask the GM to review reward delivery.";
  }

  try {
    await postReceipt(token, rules.name || token.name, harvester.actor, harvester.token, result.outcome, items,
      effectOccurred, user, roll?.message, rules.lootMode);
  } catch (error) {
    console.error(`${ID} | Could not post the harvest receipt`, error);
    warning = "Harvest recorded. The chat receipt could not be posted.";
  }
  playOutcomeSound(rules.lootMode, result.success);
  return {
    outcome: result.outcome, total: roll?.message.whisper?.length || roll?.message.blind ? null : result.total,
    warning, ...summary(rules, result.next, token)
  };
}

async function configuration(action, uuid, data, user) {
  const subject = await fromUuid(uuid);
  requireCondition(["Actor", "Token"].includes(subject?.documentName) && !subject.pack && canConfigure(subject, user),
    "Only the owner or a GM can configure this harvest.");
  const current = await readHarvest(subject);
  if (action === "configuration.save") {
    const rules = foundry.utils.deepClone(data.rules);
    requireCondition(foundry.utils.isPlainObject(rules), "The harvest settings are invalid.");
    if (!user.isGM) {
      rules.macro = current.rules.macro;
      rules.macroClient = current.rules.macroClient;
      const sources = rules => [rules.base, rules.mishap, rules.criticalRewards, ...rules.thresholds];
      const prior = new Set(sources(current.rules).flatMap(source => [...source.items, ...source.tables]).map(entry => entry.uuid));
      for (const source of sources(rules)) {
        for (const [field, type] of [["items", "Item"], ["tables", "RollTable"]]) {
          for (const entry of source[field]) {
            if (prior.has(entry.uuid)) continue;
            const document = await lookup(entry.uuid, type);
            requireCondition(document?.testUserPermission(user, "LIMITED")
              && (!document.compendium || document.compendium.testUserPermission(user, "OBSERVER")),
            "You need permission to use the selected reward document.");
          }
        }
      }
    }
    if (subject.documentName === "Token") await configureNode(subject, "save", rules, { enabled: Boolean(data.enabled) });
    else await saveRules(subject, rules, { enabled: Boolean(data.enabled) });
    return null;
  }
  const rules = foundry.utils.deepClone(current.rules);
  if (!user.isGM) {
    rules.macro = null;
    rules.macroClient = "gm";
  }
  return { rules, state: current.state, enabled: current.enabled };
}

async function handle(action, uuid, data, user) {
  let lootMode = false;
  try {
    requireCondition(game.users.activeGM?.isSelf && user?.active, "An active GM is required to harvest.");
    if (action === "configuration" || action === "configuration.save") {
      return { ok: true, value: await configuration(action, uuid, data, user) };
    }
    const token = await resolveTarget(uuid, user);
    lootMode = usesLootWording(token);
    if (action === "appearance") {
      const { rules, state } = await readHarvest(token);
      return { ok: true, value: nodeStatus(rules, state, token) };
    }
    if (action === "view") return { ok: true, value: await view(token, user) };
    if (action === "inspect") {
      await view(token, user); // Apply the same scene, visibility and distance checks as the open window.
      const { rules } = await readHarvest(token);
      requireDefeated(rules, token);
      const item = await revealedItem(rules, data.reference);
      requireCondition(item, "This reward is not available for inspection.");
      return { ok: true, value: { uuid: item.uuid, item: item.toObject() } };
    }
    if (action === "unlock") {
      requireCondition(user.isGM, "Only a GM can unlock a harvest.");
      await configureNode(token, "unlock");
      return { ok: true, value: await view(token, user) };
    }
    const value = await runExclusive(uuid, async () => {
      if (action === "begin") return begin(token, user, data);
      const lease = leaseFor(uuid);
      if (action === "cancel") {
        if (lease?.nonce === data.nonce && lease.user === user.id) {
          leases.delete(uuid);
          broadcast(uuid);
        }
        return null;
      }
      requireCondition(action === "finish" && lease?.nonce === data.nonce && lease.user === user.id,
        "This harvest attempt expired. Please try again.");
      try {
        return await finish(token, user, lease, data.messageId);
      } finally {
        leases.delete(uuid);
        broadcast(uuid);
      }
    });
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof HarvestError)) console.error(`${ID} | Harvest request failed`, error);
    return { ok: false, message: nodeText(error instanceof HarvestError ? error.message
      : "The harvest could not be completed. Ask the GM to check the console.", lootMode) };
  }
}

export function initializeAuthority(onRefresh) {
  socket = globalThis.socketlib.registerModule(ID);
  socket.register("request", function (action, uuid, data) {
    return handle(action, uuid, data, game.users.get(this.socketdata.userId));
  });
  socket.register("refresh", function (uuid, status) {
    if (game.users.get(this.socketdata.userId)?.isGM) onRefresh(uuid, status);
  });
  socket.register("runMacro", async function (macroUuid, nodeUuid, actorUuid, outcome) {
    if (!game.users.get(this.socketdata.userId)?.isGM) return false;
    try {
      const node = await resolveTarget(nodeUuid, game.user);
      const harvester = await resolveHarvester(actorUuid, game.user, node);
      const macro = await lookup(macroUuid, "Macro");
      if (!macro?.canExecute) return false;
      await executeMacro(macro, node, harvester, game.user, outcome);
      return true;
    } catch (error) {
      console.error(`${ID} | Could not run the harvest macro`, error);
      return false;
    }
  });
}

async function broadcast(uuid) {
  const revision = ++appearanceRevision;
  appearanceUpdates.set(uuid, revision);
  try {
    const token = await lookup(uuid, "Token");
    let status = null;
    if (isHarvest(token)) {
      const { rules, state } = await readHarvest(token);
      status = nodeStatus(rules, state, token);
    }
    if (appearanceUpdates.get(uuid) === revision) await socket?.executeForEveryone("refresh", uuid, status);
  } catch (error) {
    console.error(`${ID} | Could not refresh harvest appearance`, error);
  } finally {
    if (appearanceUpdates.get(uuid) === revision) appearanceUpdates.delete(uuid);
  }
}

export async function request(action, token, data = {}) {
  const gm = game.users.activeGM;
  if (!gm) throw new HarvestError("An active GM is required to harvest.");
  const response = gm.isSelf
    ? await handle(action, token.uuid, data, game.user)
    : await socket.executeAsUser("request", gm.id, action, token.uuid, data);
  if (!response.ok) throw new HarvestError(response.message);
  return response.value;
}

export async function configureNode(token, action, rules, options) {
  requireCondition(game.user.isGM, "Only a GM can configure a harvest.");
  await runExclusive(token.uuid, async () => {
    if (action === "save") await saveRules(token, rules, options);
    else if (action === "remove") await removeHarvest(token);
    else {
      const { state, stateRecord } = await readHarvest(token);
      const next = action === "reset" ? defaultState() : { ...state, failures: 0, locked: false, lastOutcome: null };
      await writeState(token, next, stateRecord);
    }
    leases.delete(token.uuid);
  });
  broadcast(token.uuid);
}
