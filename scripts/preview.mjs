import { ID } from "./rules.mjs";

/** Open the system's full item inspector against an isolated, observer-only document. */
export async function renderRewardPreview(itemData) {
  const snapshot = foundry.utils.deepClone(itemData);
  for (const field of ["_id", "folder", "sort", "ownership"]) delete snapshot[field];
  const access = Number(game.settings.get(ID, "previewPermission")) === 1 ? "LIMITED" : "OBSERVER";
  snapshot.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
    [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS[access] };
  const document = new CONFIG.Item.documentClass(snapshot, { temporary: true });
  const inspector = document.sheet;
  if (!inspector) throw new Error("No item sheet is available for this reward.");
  const options = { editable: false, submitOnChange: false, submitOnClose: false };
  if (inspector instanceof foundry.applications.api.ApplicationV2) {
    return inspector.render({ ...options, force: true });
  }
  Object.assign(inspector.options, options);
  return inspector.render(true, options);
}
