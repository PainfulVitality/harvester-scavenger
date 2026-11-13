import { request } from "./authority.mjs";
import { ID } from "./rules.mjs";
import { isHarvest, canInteractHarvest } from "./store.mjs";

const statuses = new Map();
const pending = new Map();
const originalBorders = new WeakMap();
const validStatuses = new Set(["ready", "locked", "depleted", "blocked"]);

export function getHarvestStatus(document) {
  if (!isHarvest(document)) return null;
  return canInteractHarvest(document) ? statuses.get(document.uuid) ?? "ready" : "blocked";
}

function applyAppearance(token) {
  if (!token?.mesh || token.destroyed) return;
  const enabled = isHarvest(token.document);
  if (!enabled && !originalBorders.has(token)) return;

  const status = getHarvestStatus(token.document);
  // Derive from the document every time: hover and other refreshes must not compound the fade.
  token.mesh.alpha = token.alpha * token.document.alpha * (status === "depleted" ? 0.5 : 1);
  const tint = foundry.utils.Color.from(token.document.texture.tint ?? 0xFFFFFF);
  token.mesh.tint = status === "locked" ? Number(tint.multiply(foundry.utils.Color.from(0xFF8585))) : Number(tint);
  if (enabled) {
    if (!originalBorders.has(token)) originalBorders.set(token, token.border.renderable);
    token.border.renderable = token.controlled;
  } else {
    token.border.renderable = originalBorders.get(token);
    originalBorders.delete(token);
    statuses.delete(token.document.uuid);
  }
}

export function setHarvestAppearance(uuid, status) {
  pending.delete(uuid);
  if (validStatuses.has(status)) statuses.set(uuid, status);
  else statuses.delete(uuid);
  const token = fromUuidSync(uuid)?.object;
  if (!token || token.destroyed) return;
  token.refreshNameplates?.(true);
  token.renderFlags.set({ refreshMesh: true, refreshState: true });
}

async function loadAppearance(token, force = false) {
  const uuid = token.document.uuid;
  if (!isHarvest(token.document)) {
    pending.delete(uuid);
    applyAppearance(token);
    return;
  }
  if (!game.users?.activeGM || (!game.user.isGM && (token.document.hidden || token.document.isSecret))) return;
  if (!force && (statuses.has(uuid) || pending.has(uuid))) return;
  const job = {};
  pending.set(uuid, job);
  try {
    const status = await request("appearance", token.document);
    if (pending.get(uuid) === job && !token.destroyed) setHarvestAppearance(uuid, status);
  } catch (error) {
    if (pending.get(uuid) === job && isHarvest(token.document)) {
      console.debug(`${ID} | Could not refresh token appearance`, error);
    }
  } finally {
    if (pending.get(uuid) === job) pending.delete(uuid);
  }
}

function refreshScene() {
  for (const token of canvas?.tokens?.placeables ?? []) loadAppearance(token, true);
}

export function initializeAppearance(onRefresh) {
  Hooks.on("refreshToken", applyAppearance);
  Hooks.on("hoverToken", applyAppearance);
  Hooks.on("controlToken", applyAppearance);
  Hooks.on("drawToken", token => { applyAppearance(token); loadAppearance(token); });
  Hooks.on("canvasReady", refreshScene);
  Hooks.on("userConnected", refreshScene);
  Hooks.on("updateToken", (document, changes) => {
    if (changes.flags?.[ID] || changes.hidden !== undefined) {
      const token = document.object;
      if (token) loadAppearance(token, true);
    }
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.attributes.hp.value")) return;
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor?.uuid !== actor.uuid || !isHarvest(token.document)) continue;
      applyAppearance(token);
      loadAppearance(token, true);
      onRefresh?.(token.document.uuid);
    }
  });
  Hooks.on("deleteToken", document => { statuses.delete(document.uuid); pending.delete(document.uuid); });
  Hooks.on("canvasTearDown", () => { statuses.clear(); pending.clear(); });
}
