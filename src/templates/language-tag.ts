export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 5) return null;
  const tag = value.replace(/^ +| +$/g, "");
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/i.test(tag)) return null;
  const [language, region] = tag.split("-");
  return language.toLowerCase() + (region ? `-${region.toUpperCase()}` : "");
}
