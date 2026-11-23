export type Token = string | { field: string };
export function tokenize(value: string): Token[] {
  const parts: Token[] = [];
  let start = 0;
  for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
    if (match.index > start) parts.push(value.slice(start, match.index));
    parts.push({ field: match[1] }); start = match.index + match[0].length;
  }
  if (start < value.length) parts.push(value.slice(start));
  return parts;
}
type Text = string | readonly (string | { field: string })[] | undefined;
/** Field names referenced by a configured text (placeholders and fragments). */
export const textFields = (value: Text): string[] => value === undefined ? [] : (typeof value === "string" ? [value] : value)
  .flatMap(part => typeof part === "string" ? tokenize(part).flatMap(token => typeof token === "string" ? [] : [token.field]) : [part.field]);
