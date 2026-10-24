import type { JsonLdBlock } from "../types.ts";
import * as B from "./builders.ts";

/** Max JSON-LD blocks emitted per email (anti-abuse). */
const MAX_BLOCKS = 5;
/** Max object nesting for a directive's output (guards against huge payloads). */
const MAX_DEPTH = 8;

type Rec = Record<string, unknown>;

/** Deepest object/array nesting within a value. */
function depth(v: unknown, level = 0): number {
  if (level >= MAX_DEPTH || !v || typeof v !== "object") return level;
  let max = level;
  for (const child of Object.values(v as Rec)) {
    const d = depth(child, level + 1);
    if (d > max) max = d;
    if (max >= MAX_DEPTH) break;
  }
  return max;
}

const BUILDERS: Record<string, (d: Rec) => JsonLdBlock | null> = {
  viewAction: B.viewAction,
  confirmAction: B.confirmAction,
  trackAction: B.trackAction,
  discountOffer: B.discountOffer,
  promotionCard: B.promotionCard,
  organization: B.organization,
  schema: B.schema,
  raw: B.raw,
};

function buildOne(item: unknown): JsonLdBlock | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const d = item as Rec;
  const builder = typeof d.kind === "string" && Object.hasOwn(BUILDERS, d.kind) ? BUILDERS[d.kind] : undefined;
  return builder ? builder(d) : null;
}

function validLinks(value: unknown, key = ""): boolean {
  if (Array.isArray(value)) return value.every((item) => validLinks(item, key));
  if (value && typeof value === "object") return Object.entries(value).every(([name, item]) => validLinks(item, name));
  return !/^(url|target|trackingUrl|urlTemplate)$/.test(key) || B.isHttpUrl(value);
}

/**
 * Turn an untrusted `markup` value (an array of directives, or a single one)
 * into validated JSON-LD blocks. Fail-soft: unknown/invalid/over-deep directives
 * are dropped, and the result is capped at MAX_BLOCKS.
 */
export function buildBlocks(input: unknown): JsonLdBlock[] {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? [input]
      : [];
  const out: JsonLdBlock[] = [];
  for (const item of items) {
    if (out.length >= MAX_BLOCKS) break;
    const block = buildOne(item);
    if (block && depth(block) < MAX_DEPTH && validLinks(block)) out.push(block);
  }
  return out;
}

export { serializeBlock, serializeToHead } from "./serialize.ts";
export * from "./builders.ts";
