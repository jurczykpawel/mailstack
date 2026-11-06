import type { SourceField } from "./core/config/sources.ts";
import { WorkBudget } from "./templates/output.ts";
import { tokenize } from "./templates/tokens.ts";
export function read(value: unknown, path: string): unknown {
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}
export const scalar = (value: unknown): string => ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
export function sourceField(body: unknown, field: SourceField, budget = new WorkBudget(1024 * 1024), limit = 5000, trim = false): string {
  const pieces: string[] = [];
  let size = 0;
  const push = (value: string) => { if ((size += value.length) > limit && !trim) throw new RangeError("invalid_event_data"); pieces.push(value); };
  const get = (path: string) => { const value = scalar(read(body, path)); budget.spend(value.length); return value; };
  if (typeof field === "string") push(get(field));
  else if ("format" in field) {
    budget.spend(field.format.length);
    for (const token of tokenize(field.format)) push(typeof token === "string" ? token : get(token.field));
  } else if ("first" in field) {
    for (const path of field.first) { const value = get(path); budget.spend(value.length); if (value.trim()) { push(value); break; } }
  } else if ("join" in field) {
    for (const path of field.join) { const value = get(path); if (value) { if (pieces.length) push(" "); push(value); } }
  } else {
    const value = read(body, field.path), text = scalar(value);
    budget.spend(text.length);
    switch (field.as) {
      case "money-minor": push(typeof value === "number" && Number.isSafeInteger(value) ? (value / 100).toFixed(2) : ""); break;
      case "upper": {
        let length = 0;
        budget.spend(text.length);
        for (const char of text) if ((length += char.toUpperCase().length) > limit) throw new RangeError("invalid_event_data");
        push(text.toUpperCase()); break;
      }
      case "date-pl": {
        budget.spend(text.length);
        const date = typeof value === "string" && value.trim() ? new Date(value) : new Date(NaN);
        push(Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("pl-PL")); break;
      }
      case "map": {
        if (!["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value) || text.length > 128) break;
        const key = `${typeof value}:${text}`; push(Object.hasOwn(field.map, key) ? field.map[key] : ""); break;
      }
    }
  }
  if (trim) {
    while (pieces.length && !pieces[0].trim()) pieces.shift();
    while (pieces.length && !pieces.at(-1)!.trim()) pieces.pop();
    if (pieces.length) { pieces[0] = pieces[0].trimStart(); pieces[pieces.length - 1] = pieces.at(-1)!.trimEnd(); }
    size = pieces.reduce((sum, piece) => sum + piece.length, 0);
  }
  if (size > limit) throw new RangeError("invalid_event_data");
  return pieces.join("");
}
export function mapSourceFields(body: unknown, fields: Record<string, SourceField>, budget = new WorkBudget(1024 * 1024)): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    try { mapped[key] = sourceField(body, field, budget); }
    catch (error) { if (!(error instanceof RangeError)) throw error; throw new RangeError(key); }
  }
  return mapped;
}
