import { ID, defaultRules, defaultState, normalizeRules } from "./rules.mjs";

const PACK_NAME = "harvester-scavenger-data";
const PACK_ID = `world.${PACK_NAME}`;
export const DEFAULT_RECIPE = "defaultRecipe";
const OWNERSHIP = { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "NONE", GAMEMASTER: "OWNER" };
let packCreation;

async function getPack(create = false) {
  if (!game.user.isGM) throw new Error("Only a GM can read harvest configuration.");
  const existing = game.packs.get(PACK_ID);
  if (existing || !create) return existing;
  packCreation ??= foundry.documents.collections.CompendiumCollection.createCompendium({
    name: PACK_NAME, label: "Harvester & Scavenger Data", type: "JournalEntry", ownership: OWNERSHIP
  }).finally(() => { packCreation = undefined; });
  return packCreation;
}

async function createRecord(pack, name, flags) {
  const record = await CONFIG.JournalEntry.documentClass.create({
    name, flags: { [ID]: flags }
  }, { pack: pack.collection });
  if (!record) throw new Error("Could not save the harvest record.");
  return record;
}

async function findState(pack, token) {
  const index = await pack.getIndex();
  for (const entry of index.filter(entry => entry.name === token.uuid)) {
    // Progress updates stay on the writing GM; fetch current data for reconnects and GM handoffs.
    const [record] = await pack.getDocuments({ _id: entry._id });
    if (record) pack.set(record.id, record);
    if (record?.getFlag(ID, "state")) return record;
  }
  return null;
}

export function isHarvest(subject) {
  return Boolean(subject && getRecipeId(subject) && recipeDocument(subject)?.getFlag(ID, "enabled") !== false);
}

export function requiresDefeat(subject) {
  return Boolean(recipeDocument(subject)?.getFlag(ID, "defeatedOnly"));
}

export function usesLootWording(subject) {
  const saved = recipeDocument(subject)?.getFlag(ID, "lootMode");
  return saved === undefined ? requiresDefeat(subject) : Boolean(saved);
}

export function isDefeated(subject) {
  const actor = subject?.documentName === "Actor" ? subject : subject?.actor;
  const hp = actor?.system?.attributes?.hp?.value;
  return typeof hp === "number" && Number.isFinite(hp) && hp <= 0;
}

export function canInteractHarvest(subject) {
  return isHarvest(subject) && (!requiresDefeat(subject) || isDefeated(subject));
}

function recipeDocument(subject) {
  return subject?.documentName === "Actor" ? subject.prototypeToken : subject;
}

export function getRecipeId(subject) {
  return subject ? recipeDocument(subject)?.getFlag(ID, "recipe") : game.settings.get(ID, DEFAULT_RECIPE);
}

export async function readHarvest(subject = null) {
  const id = getRecipeId(subject);
  if (!id) {
    const rules = subject ? (await readHarvest()).rules : defaultRules();
    return { rules, state: defaultState(), enabled: false };
  }
  const pack = await getPack();
  if (!pack) throw new Error("The harvest data compendium is missing.");
  const [recipe, stateRecord] = await Promise.all([
    pack.getDocument(id), subject?.documentName === "Token" ? findState(pack, subject) : null
  ]);
  const rules = recipe?.getFlag(ID, "rules");
  if (!rules) throw new Error("The saved harvest configuration is missing.");
  return { rules: normalizeRules(rules), state: stateRecord?.getFlag(ID, "state") ?? defaultState(), stateRecord, recipe: id,
    enabled: isHarvest(subject) };
}

async function setRecipeId(subject, id, enabled, rules = {}) {
  if (!subject) {
    await game.settings.set(ID, DEFAULT_RECIPE, id);
    return;
  }
  const document = recipeDocument(subject);
  const flags = id ? { recipe: id, enabled, defeatedOnly: Boolean(rules.defeatedOnly), lootMode: Boolean(rules.lootMode) }
    : { "-=recipe": null, "-=enabled": null, "-=defeatedOnly": null, "-=lootMode": null };
  const updated = await document.update({ flags: { [ID]: flags } });
  if (!updated) throw new Error("Could not update the harvest configuration.");
}

export async function saveRules(subject, rules, { enabled = true } = {}) {
  rules = normalizeRules(rules);
  const pack = await getPack(true);
  const oldRecipe = getRecipeId(subject);
  const recipe = await createRecord(pack, subject ? rules.name || subject.name : "World Harvest Defaults", { rules });
  try {
    await setRecipeId(subject, recipe.id, enabled, rules);
  } catch (error) {
    await removeUnusedRecipe(pack, recipe.id);
    throw error;
  }
  await removeUnusedRecipe(pack, oldRecipe);
}

async function removeUnusedRecipe(pack, id) {
  if (!id || getRecipeId() === id || game.actors.some(actor => getRecipeId(actor) === id)
    || game.scenes.some(scene => scene.tokens.some(token => getRecipeId(token) === id))) return;
  try {
    await (await pack.getDocument(id))?.delete();
  } catch (error) {
    console.warn(`${ID} | Could not remove an unused harvest recipe`, error);
  }
}

export async function removeHarvest(subject) {
  const id = getRecipeId(subject);
  if (!id) return;
  await setRecipeId(subject, "");
  await cleanHarvestRecords(subject, id);
}

export async function cleanDeletedHarvest(subject) {
  const id = getRecipeId(subject);
  if (id) await cleanHarvestRecords(subject, id);
}

async function cleanHarvestRecords(subject, id) {
  try {
    const pack = await getPack();
    if (!pack) return;
    if (subject?.documentName === "Token") await (await findState(pack, subject))?.delete();
    await removeUnusedRecipe(pack, id);
  } catch (error) {
    console.warn(`${ID} | Could not remove the harvest records`, error);
  }
}

export async function writeState(token, state, record) {
  if (!record) {
    await createRecord(await getPack(true), token.uuid, { state });
    return;
  }
  // Foundry returns no document for an unchanged update; repeated Reset/Unlock is valid.
  if (foundry.utils.isEmpty(foundry.utils.diffObject(record.getFlag(ID, "state"), state))) return;
  // Foundry 14 tries to update uncached compendium documents before loading them on other clients.
  // Public window/appearance updates use our authenticated socket channel instead.
  if (!await record.update({ flags: { [ID]: { state } } }, { broadcast: false })) {
    throw new Error("Could not update the harvest state.");
  }
}
