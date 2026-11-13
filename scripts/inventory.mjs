// Reward quantities describe units to grant, independently of a source stack's size.
// This service runs on the active GM under the authority layer's per-actor queue.
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
}

function stackKey(data) {
  if (!Number.isFinite(data.system?.quantity) || data.type === "container") return null;
  const system = { ...data.system };
  delete system.quantity;
  // Container contents are never silently combined with top-level inventory.
  system.container ??= null;
  return JSON.stringify(ordered({ name: data.name, type: data.type, img: data.img,
    system, effects: data.effects ?? [], flags: data.flags ?? {} }));
}

export async function grantInventory(rewards, actor, interactionId) {
  if (!rewards.length) return [];
  const stacks = new Map();
  for (const item of actor.items) {
    const key = stackKey(item.toObject());
    if (key && !stacks.has(key)) stacks.set(key, { id: item.id, quantity: item.system.quantity });
  }
  const updates = new Map();
  const creates = [];
  const receipts = [];
  for (const { item, quantity } of rewards) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Invalid inventory reward quantity.");
    const data = item.toObject();
    for (const field of ["_id", "folder", "sort", "ownership"]) delete data[field];
    if (Object.hasOwn(data.system ?? {}, "container")) data.system.container = null;
    const key = stackKey(data);
    const stack = key ? stacks.get(key) : null;
    let target;
    if (stack) {
      stack.quantity += quantity;
      if (!Number.isSafeInteger(stack.quantity)) throw new Error("The inventory quantity exceeds Foundry’s numeric range.");
      if (stack.id) updates.set(stack.id, { _id: stack.id, "system.quantity": stack.quantity });
      else stack.data.system.quantity = stack.quantity;
      target = stack;
    } else if (key) {
      data.system.quantity = quantity;
      target = { data, quantity, index: creates.length };
      stacks.set(key, target);
      creates.push(data);
    } else {
      // Features, spells and containers need separate documents, rather than a
      // synthetic quantity field which their data model may discard.
      target = { index: creates.length, multiple: quantity > 1 };
      for (let unit = 0; unit < quantity; unit++) {
        const copy = foundry.utils.deepClone(data);
        if (Number.isFinite(copy.system?.quantity)) copy.system.quantity = 1;
        creates.push(copy);
      }
    }
    receipts.push({ name: data.name, img: data.img, quantity, type: data.type, target });
  }
  const options = { harvestInteractionId: interactionId };
  if (updates.size) {
    const changed = await actor.updateEmbeddedDocuments("Item", [...updates.values()], options);
    if (changed.length !== updates.size || [...updates.values()].some(update =>
      actor.items.get(update._id)?.system.quantity !== update["system.quantity"])) {
      throw new Error("An inventory stack update was prevented. Review reward delivery.");
    }
  }
  const created = creates.length ? await actor.createEmbeddedDocuments("Item", creates, options) : [];
  if (created.length !== creates.length || created.some((document, index) =>
    Number.isFinite(creates[index].system?.quantity) && document.system.quantity !== creates[index].system.quantity)) {
    throw new Error("An inventory item creation was prevented or changed. Review reward delivery.");
  }
  const grouped = new Map();
  for (const { target, type, ...receipt } of receipts) {
    const key = JSON.stringify([type, receipt.name, receipt.img]);
    const prior = grouped.get(key);
    if (prior) {
      prior.quantity += receipt.quantity;
      delete prior.uuid;
    } else {
      const document = target.id ? actor.items.get(target.id) : created[target.index];
      grouped.set(key, { ...receipt, uuid: target.multiple ? undefined : document?.uuid });
    }
  }
  return [...grouped.values()];
}
