/**
 * Shared payload string helpers: Herdr events name the same value under
 * several keys and expose it either as a string or as an `{id, name}` object.
 */

/** First non-empty trimmed string, or the decimal form of a finite number. */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** A string-or-object field as a display string, or null. */
export function stringFrom(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return firstString(value);
  if (typeof value === "object") {
    return firstString(value.name, value.id, value.command, value.display, value.display_name);
  }
  return null;
}
