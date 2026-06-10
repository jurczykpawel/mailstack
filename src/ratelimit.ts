const WINDOW_SECONDS = 60 * 60; // fixed 1-hour window
const MAX_REQUESTS = 8;

/**
 * Fixed-window rate limit backed by KV. Counts attempts per `rl:{brand}:{ip}`
 * and blocks once the window exceeds MAX_REQUESTS. Degrades open (allows) when
 * the KV binding is missing — handy in tests and safer than a hard failure.
 *
 * @returns true if the request is allowed, false if the limit is exceeded.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  brand: string,
  ip: string,
): Promise<boolean> {
  if (!kv) return true;

  const key = `rl:${brand}:${ip || "unknown"}`;
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) || 0 : 0;

  if (count >= MAX_REQUESTS) return false;

  // Re-set the TTL each write; "first hit defines the window" is close enough
  // for abuse control and avoids a second read for the original expiry.
  await kv.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}
