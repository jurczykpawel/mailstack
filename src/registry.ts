import type { Brand } from "./types";
import { BRANDS } from "./brands";

/**
 * Brand lookups. The brand data itself lives in `src/brands.ts` (gitignored,
 * created from `src/brands.example.ts` by `npm run setup`), so the registry logic
 * stays in version control while each deployment keeps its own brands private.
 */

export function getBrand(id: string): Brand | undefined {
  return BRANDS[id];
}

/** First brand whose allowlist contains `origin`. Used to resolve CORS when no `brand` is given. */
export function findBrandByOrigin(origin: string): Brand | undefined {
  if (!origin) return undefined;
  return Object.values(BRANDS).find((b) => b.allowedOrigins.includes(origin));
}
