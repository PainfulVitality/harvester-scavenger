import { ID } from "./rules.mjs";

export async function lookup(uuid, type) {
  if (typeof uuid !== "string" || !uuid) return null;
  const document = await fromUuid(uuid);
  return document?.documentName === type ? document : null;
}

export async function referenceRows(entries, type) {
  return Promise.all(entries.map(async entry => {
    const document = await lookup(entry.uuid, type);
    return { ...entry, name: document?.name ?? "Missing document", img: document?.img, missing: !document,
      quantityLabel: entry.randomQuantity ? `${entry.minQuantity}–${entry.maxQuantity}` : String(entry.quantity) };
  }));
}

export async function rewardPreview(rules) {
  const unknown = { unknown: true, name: "Unknown reward" };
  const hasItems = rules.base.items.length > 0;
  const hasTables = rules.base.tables.length > 0;
  const items = rules.revealItems ? await referenceRows(rules.base.items, "Item")
    : hasItems || !hasTables ? [unknown] : [];
  const tables = rules.revealTables ? await Promise.all(rules.base.tables.map(async entry => {
    const table = await lookup(entry.uuid, "RollTable");
    if (!table) return null;
    return {
      name: table.name, quantity: entry.quantity,
      results: await Promise.all(table.results.map(async result => ({
        name: result.name, range: result.range[0] === result.range[1] ? result.range[0] : result.range.join("–"),
        previewKey: await lookup(result.documentUuid, "Item") ? `table:${rules.base.tables.indexOf(entry)}:${result.id}` : null
      })))
    };
  })) : hasTables ? [unknown] : [];
  return { items: items.map(({ name, img, quantityLabel, unknown, missing }, index) => ({ name, img, quantityLabel, unknown,
    previewKey: !unknown && !missing ? `item:${index}` : null })),
    tables: tables.filter(Boolean) };
}

export async function revealedItem(rules, key) {
  if (typeof key !== "string") return null;
  const item = /^item:(\d+)$/.exec(key);
  if (item && rules.revealItems) return lookup(rules.base.items[Number(item[1])]?.uuid, "Item");
  const result = /^table:(\d+):([a-zA-Z0-9]+)$/.exec(key);
  if (!result || !rules.revealTables) return null;
  const table = await lookup(rules.base.tables[Number(result[1])]?.uuid, "RollTable");
  return lookup(table?.results.get(result[2])?.documentUuid, "Item");
}

export async function itemQuantity(entry) {
  if (!entry.randomQuantity) return entry.quantity;
  const min = entry.minQuantity;
  const max = entry.maxQuantity;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) {
    throw new Error("The item quantity range is invalid.");
  }
  if (min === max) return min;
  const roll = await new Roll(`1d${max - min + 1} + ${min - 1}`).evaluate();
  return roll.total;
}

export async function collectRewards(sources, multiplier) {
  const items = new Map();
  async function add(uuid, quantity, required) {
    const item = await lookup(uuid, "Item");
    if (!item) {
      if (required) throw new Error(`A configured Item is missing (${uuid}).`);
      return;
    }
    const previous = items.get(item.uuid);
    const total = (previous?.quantity ?? 0) + quantity * multiplier;
    if (!Number.isSafeInteger(total)) throw new Error("The combined reward quantity exceeds Foundry’s numeric range.");
    items.set(item.uuid, { item, quantity: total });
  }

  for (const source of sources) {
    for (const entry of source.items) {
      const quantity = await itemQuantity(entry);
      if (quantity > 0) await add(entry.uuid, quantity, true);
    }
    for (const { uuid, quantity } of source.tables) {
      const table = await lookup(uuid, "RollTable");
      if (!table) throw new Error(`A configured Roll Table is missing (${uuid}).`);
      for (let draw = 0; draw < quantity; draw++) {
        const { results } = await table.roll();
        for (const result of results) {
          if (result.documentUuid) await add(result.documentUuid, 1, false);
        }
      }
    }
  }
  return [...items.values()];
}

export { grantInventory as deliverRewards } from "./inventory.mjs";

export async function postReceipt(token, name, actor, actorToken, outcome, items, usedMacro, user, rollMessage, lootMode = false) {
  const verb = lootMode ? "loot" : "harvest";
  const past = lootMode ? "looted" : "harvested";
  const message = {
    failure: `${actor.name} failed to ${verb} ${name}.`,
    mishap: `${actor.name} triggered a ${verb} mishap at ${name}.`,
    critical: `${actor.name} critically ${past} ${name}.`,
    success: `${actor.name} ${past} ${name}.`
  }[outcome];
  const content = await foundry.applications.handlebars.renderTemplate(
    `modules/${ID}/templates/receipt.hbs`, {
      source: { name, img: token.actor?.img ?? token.texture.src },
      actor: { name: actor.name, img: actor.img }, message, items, effectOccurred: usedMacro, outcome,
      empty: !items.length && !usedMacro && outcome !== "failure"
    }
  );
  const privateRoll = rollMessage?.whisper?.length || rollMessage?.blind;
  const whisper = privateRoll
    ? [...new Set([...rollMessage.whisper, ...game.users.filter(user => user.isGM).map(user => user.id), ...(!rollMessage.blind ? [user.id] : [])])]
    : [];
  return CONFIG.ChatMessage.documentClass.create({
    speaker: CONFIG.ChatMessage.documentClass.getSpeaker({ actor, token: actorToken }),
    content, whisper, blind: rollMessage?.blind ?? false
  });
}
