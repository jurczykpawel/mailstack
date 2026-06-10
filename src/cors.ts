import type { Brand } from "./types";

/** True when `origin` is non-empty and present in the brand's allowlist. */
export function isOriginAllowed(brand: Brand, origin: string): boolean {
  return origin !== "" && brand.allowedOrigins.includes(origin);
}

/**
 * CORS headers to echo when an origin is allowed. We reflect the exact origin
 * (never "*") so credentials/allowlisting stay tight.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
