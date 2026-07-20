import type { JsonLdBlock } from "../types";

/** Total serialized markup budget across all blocks (anti-abuse). */
const MAX_TOTAL_BYTES = 16 * 1024;

/**
 * Serialize one block into a `<script type="application/ld+json">` tag, safely
 * escaped for embedding in HTML. We do NOT HTML-escape (that would corrupt the
 * JSON the browser parses verbatim); instead we neutralize the only sequence
 * that could break out of the script element — `<` — plus the JS line
 * terminators U+2028 / U+2029.
 */
export function serializeBlock(block: JsonLdBlock): string {
  const json = JSON.stringify(block)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Serialize blocks into the `<head>` script markup, capped at a total byte
 * budget. Blocks past the budget are dropped (fail-soft) rather than truncated.
 */
export function serializeToHead(blocks: JsonLdBlock[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const b of blocks) {
    const tag = serializeBlock(b);
    total += tag.length;
    if (total > MAX_TOTAL_BYTES) break;
    parts.push(tag);
  }
  return parts.join("\n    ");
}
