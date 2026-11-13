import { ID } from "./rules.mjs";
import { nodeText } from "./wording.mjs";

export function interactionDistance(rules) {
  return Number(rules.distance ?? game.settings.get(ID, "interactionDistance")) || Infinity;
}

export function gridDistance(first, second) {
  if (!first || !second || first.parent?.id !== second.parent?.id) return Infinity;
  const bounds = token => {
    const { width, height } = token.getSize();
    return [[token.x, token.x + width], [token.y, token.y + height]];
  };
  const left = bounds(first);
  const right = bounds(second);
  const gaps = left.map(([start, end], axis) => Math.max(start, right[axis][0]) - Math.min(end, right[axis][1]));
  const pixels = Math.hypot(...gaps.map(gap => Math.max(0, gap)));
  const cell = first.parent.grid.size;
  return cell > 0 ? 1 + Math.trunc(pixels / cell) : Infinity;
}

export function inRange(first, second, distance, user = game.user) {
  return user.isGM || gridDistance(first, second) <= distance;
}

export function canConfigure(subject, user = game.user) {
  const owner = subject?.documentName === "Token" ? subject.actor : subject;
  return Boolean(owner && (user.isGM || owner.testUserPermission(user, "OWNER")));
}

export function distanceWarning(distance, lootMode = false) {
  return nodeText(`Move a token you own within ${distance} grid units of the harvest.`, lootMode);
}
