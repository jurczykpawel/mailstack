const ROW_KEYS = ["qty", "name", "amount", "description"];
const REQUIRED = ROW_KEYS.slice(0, 3);
const MAX_ROWS = 50, MAX_CELL = 500;
/** Upper bound of canonical rows JSON (also allowed for row fields in replay records). */
export const MAX_ROWS_JSON = MAX_ROWS * (ROW_KEYS.length * (MAX_CELL * 6 + 20) + 2) + 2;
const cellOk = (cell: unknown) => (typeof cell === "string" || typeof cell === "number" && Number.isFinite(cell)) && String(cell).length <= MAX_CELL;

/** Canonical JSON of order rows (`{qty,name,amount,description?}`), "" when empty, null when invalid. */
export function normalizeRows(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const rows = value.map(row => row && typeof row === "object" && !Array.isArray(row) && Object.entries(row).every(([key, cell]) => ROW_KEYS.includes(key) && cellOk(cell))
    && REQUIRED.every(key => Object.hasOwn(row, key) && String(row[key as keyof typeof row]).trim())
    ? Object.fromEntries(ROW_KEYS.filter(key => Object.hasOwn(row, key)).map(key => [key, String(row[key as keyof typeof row])])) : null);
  return rows.includes(null) ? null : rows.length ? JSON.stringify(rows) : "";
}
/** True for a string that is exactly the canonical JSON of valid rows. */
export function isCanonicalRows(value: string): boolean {
  if (value.length > MAX_ROWS_JSON || !value.startsWith("[")) return false;
  try { return normalizeRows(JSON.parse(value)) === value; } catch { return false; }
}
export function rowCells(value: string): string[] {
  try { const rows: unknown = JSON.parse(value); return Array.isArray(rows) ? rows.flatMap(row => Object.values(row as object).map(String)) : []; } catch { return []; }
}
