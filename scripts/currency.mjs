/** Native system currency metadata and document updates; no external currency APIs are used. */
export class CurrencyError extends Error {}

export const validDenomination = key => typeof key === "string" && key.length > 0 && key.length <= 100
  && !/[.\[\]\\/\x00-\x1f]/.test(key) && !["__proto__", "prototype", "constructor"].includes(key);

function registry() { return globalThis.CONFIG?.DND5E?.currencies ?? {}; }
function localize(text) { return globalThis.game?.i18n?.localize?.(text) ?? text; }
function fieldFor(actor, key) {
  const schema = actor?.system?.schema ?? globalThis.CONFIG?.Actor?.dataModels?.character?.schema;
  try { return schema?.getField(`currency.${key}`); } catch { return null; }
}
function knownField(actor, key) {
  const schema = actor?.system?.schema ?? globalThis.CONFIG?.Actor?.dataModels?.character?.schema;
  try {
    const mapping = schema?.getField("currency");
    if (!mapping) return actor ? Object.hasOwn(actor.system?.currency ?? {}, key) : true;
    if (mapping.initialKeysOnly) {
      const keys = Array.isArray(mapping.initialKeys) ? mapping.initialKeys : Object.keys(mapping.initialKeys ?? {});
      if (!keys.includes(key)) return false;
    }
    const field = fieldFor(actor, key);
    if (!field) return false;
    const initial = field.getInitialValue?.();
    return typeof initial === "number" || globalThis.foundry?.data?.fields?.NumberField
      && field instanceof foundry.data.fields.NumberField;
  } catch { return false; }
}

export function currencyDefinition(key, actor) {
  const config = registry()[key];
  const configured = Object.hasOwn(registry(), key);
  const info = typeof config === "object" && config ? config : {};
  const field = fieldFor(actor, key);
  let precision = info.fractionalDigits;
  if (field?.integer || !precision) precision = 0;
  else if (!Number.isFinite(precision)) precision = null;
  else if (!Number.isInteger(precision) || precision < 0 || precision > 20) precision = undefined;
  const supported = validDenomination(key) && knownField(actor, key) && precision !== undefined
    && (configured || !Object.keys(registry()).length && (field || actor && Object.hasOwn(actor.system?.currency ?? {}, key)));
  const icon = typeof info.icon === "string" ? info.icon : "";
  return { key, name: localize(info.label ?? (typeof config === "string" ? config : key)),
    abbreviation: localize(info.abbreviation ?? key), precision, step: precision == null ? "any" : 10 ** -precision,
    img: /^fa[\w-]*(?:\s|$)/.test(icon) ? "" : icon,
    icon: /^fa[\w-]*(?:\s|$)/.test(icon) ? icon : "fa-solid fa-coins", supported: Boolean(supported),
    conversion: Number.isFinite(info.conversion) && info.conversion > 0 ? info.conversion : null };
}

export function currencyDefinitions(actor) {
  const schema = actor?.system?.schema ?? globalThis.CONFIG?.Actor?.dataModels?.character?.schema;
  let nativeKeys = [];
  try {
    const field = schema?.getField("currency");
    nativeKeys = Array.isArray(field?.initialKeys) ? field.initialKeys : Object.keys(field?.initialKeys ?? field?.fields ?? {});
  } catch { /* Currency may be absent from this actor type. */ }
  return [...new Set([...Object.keys(registry()), ...nativeKeys, ...Object.keys(actor?.system?.currency ?? {})])]
    .filter(validDenomination).map(key => currencyDefinition(key, actor));
}

function decimalPlaces(value) {
  const [digits, exponent = "0"] = String(value).toLowerCase().split("e");
  return Math.max(0, (digits.split(".")[1]?.length ?? 0) - Number(exponent));
}
function units(value, precision) {
  if (!Number.isFinite(value) || value < 0 || precision > 20) throw new CurrencyError("The currency amount is invalid or too precise.");
  const scaled = value * 10 ** precision;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > Math.max(1, Math.abs(scaled)) * Number.EPSILON * 4) {
    throw new CurrencyError("The currency amount exceeds the denomination’s supported precision or numeric range.");
  }
  return rounded;
}
function precisionFor(def, values) {
  const used = Math.max(0, ...values.map(decimalPlaces));
  return def.precision === null ? used : Math.min(def.precision, used);
}

export function validateCurrencyEntries(entries, label = "Currency") {
  if (!Array.isArray(entries) || entries.length > 100) throw new CurrencyError(`${label}: use at most 100 currency entries.`);
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !validDenomination(entry.denomination)) {
      throw new CurrencyError(`${label} contains an invalid currency denomination.`);
    }
    const { denomination, quantity, randomQuantity = false } = entry;
    if (typeof randomQuantity !== "boolean") throw new CurrencyError("The currency amount mode is invalid.");
    // Keep removed denominations editable, but never deliver them without a matching system field.
    const amounts = randomQuantity ? [quantity, entry.minQuantity, entry.maxQuantity] : [quantity];
    for (const amount of amounts) units(amount, decimalPlaces(amount));
    if (randomQuantity && entry.maxQuantity < entry.minQuantity) throw new CurrencyError("Each currency maximum must be at least its minimum.");
    return { denomination, quantity, randomQuantity,
      ...(randomQuantity ? { minQuantity: entry.minQuantity, maxQuantity: entry.maxQuantity } : {}) };
  });
}

export function currencyRows(entries = [], actor) {
  return entries.map(entry => {
    const def = currencyDefinition(entry.denomination, actor);
    return { ...entry, ...def, amountLabel: entry.randomQuantity ? `${entry.minQuantity}–${entry.maxQuantity}` : String(entry.quantity),
      available: def.supported };
  });
}

export async function collectCurrency(sources, multiplier, actor) {
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) throw new CurrencyError("The currency reward multiplier is invalid.");
  const totals = new Map();
  for (const source of sources) for (const entry of validateCurrencyEntries(source.currency ?? [])) {
    if (entry.randomQuantity ? entry.maxQuantity === 0 : entry.quantity === 0) continue;
    const def = currencyDefinition(entry.denomination, actor);
    if (!def.supported) throw new CurrencyError(`Currency “${def.name}” is not supported by the current system currency fields.`);
    const precision = entry.randomQuantity && def.precision !== null ? def.precision
      : precisionFor(def, entry.randomQuantity ? [entry.minQuantity, entry.maxQuantity] : [entry.quantity]);
    let amount;
    if (entry.randomQuantity) {
      const min = units(entry.minQuantity, precision), max = units(entry.maxQuantity, precision);
      if (!Number.isSafeInteger(max - min + 1)) throw new CurrencyError("The random currency range exceeds the system’s numeric range.");
      if (max === min) amount = min;
      else {
        const roll = await new Roll(`1d${max - min + 1} + ${min - 1}`).evaluate();
        if (!Number.isSafeInteger(roll.total) || roll.total < min || roll.total > max) throw new CurrencyError("The random currency roll returned an invalid result.");
        amount = roll.total;
      }
    } else amount = units(entry.quantity, precision);
    const value = amount / 10 ** precision;
    const previous = totals.get(entry.denomination) ?? 0;
    const sumPrecision = precisionFor(def, [previous, value]);
    const total = units(previous, sumPrecision) + units(value, sumPrecision) * multiplier;
    if (!Number.isSafeInteger(total)) throw new CurrencyError("The combined currency reward exceeds the system’s numeric range.");
    if (total) totals.set(entry.denomination, total / 10 ** sumPrecision);
  }
  return [...totals].map(([denomination, quantity]) => ({ denomination, quantity }));
}

function balances(actor) {
  const values = actor._source?.system?.currency ?? actor.system?.currency;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new CurrencyError("The recipient has no supported system currency wallet.");
  return values;
}

export function prepareCurrency(actor, amounts) {
  if (!amounts.length) return { before: {}, updates: {}, expected: {} };
  const before = { ...balances(actor) }, updates = {}, expected = {};
  for (const { denomination, quantity } of amounts) {
    const def = currencyDefinition(denomination, actor);
    if (!def.supported || typeof actor.update !== "function") throw new CurrencyError(`The recipient cannot receive currency “${def.name}”.`);
    const field = fieldFor(actor, denomination);
    const current = expected[denomination] ?? before[denomination] ?? field?.getInitialValue?.() ?? 0;
    const precision = precisionFor(def, [current, quantity]);
    const total = units(current, precision) + units(quantity, precision);
    if (!Number.isSafeInteger(total)) throw new CurrencyError("The recipient’s currency balance exceeds the system’s numeric range.");
    const next = total / 10 ** precision;
    if (field?.max != null && next > field.max || field?.min != null && next < field.min) throw new CurrencyError(`The ${def.name} balance is outside its system field limits.`);
    updates[`system.currency.${denomination}`] = next;
    expected[denomination] = next;
  }
  return { before, updates, expected };
}

function appliedCurrency(actor, before, after, amounts, expected) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(expected)]);
  if ([...keys].every(key => (after[key] ?? 0) === (expected[key] ?? before[key] ?? 0))) return true;
  // A normal update hook may convert denominations. Verify the system-defined total value instead.
  let oldValue = 0, newValue = 0, rewardValue = 0;
  for (const key of keys) {
    const def = currencyDefinition(key, actor);
    if (!def.conversion) {
      if ((after[key] ?? 0) !== (expected[key] ?? before[key] ?? 0)) return false;
      continue;
    }
    if (![before[key] ?? 0, after[key] ?? 0].every(value => Number.isFinite(value) && value >= 0)) return false;
    oldValue += (before[key] ?? 0) / def.conversion;
    newValue += (after[key] ?? 0) / def.conversion;
  }
  for (const { denomination, quantity } of amounts) {
    const def = currencyDefinition(denomination, actor);
    if (def.conversion) rewardValue += quantity / def.conversion;
  }
  const difference = newValue - oldValue;
  const quantum = Math.min(...[...keys].map(key => {
    const def = currencyDefinition(key, actor);
    return def.conversion ? 10 ** -(def.precision ?? 20) / def.conversion : Infinity;
  }));
  const tolerance = Math.min(quantum / 4, Math.max(1, Math.abs(newValue), Math.abs(oldValue)) * Number.EPSILON * 16);
  return Number.isFinite(difference) && Math.abs(difference - rewardValue) <= tolerance;
}

export async function grantCurrency(actor, amounts, interactionId) {
  if (!amounts.length) return [];
  const plan = prepareCurrency(actor, amounts);
  const updated = await actor.update(plan.updates, { harvestInteractionId: interactionId });
  if (!updated || !appliedCurrency(actor, plan.before, balances(actor), amounts, plan.expected)) {
    throw new CurrencyError("The currency update was prevented or changed. Review reward delivery before resetting this harvest.");
  }
  return currencyRows(amounts, actor);
}
