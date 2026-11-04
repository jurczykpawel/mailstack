/** Cloudflare Access JWT check for the internal host; any failure denies. */
export interface AccessEnv { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }
export type AccessVerifier = (req: Request, env: AccessEnv) => Promise<boolean>;

const HOUR = 3_600_000, MINUTE = 60_000;
const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (part: string) => JSON.parse(new TextDecoder().decode(decode(part)));
const int = (value: unknown): value is number => Number.isSafeInteger(value);

/** Keys come from `https://<team>/cdn-cgi/access/certs`, cached for an hour; unknown `kid` refetches at most once a minute. */
export function createAccessVerifier(fetcher: typeof fetch = (...args) => fetch(...args), now = () => Date.now()): AccessVerifier {
  let cache: { team: string; at: number; keys: Map<string, CryptoKey> } | undefined, tried = -Infinity;
  let pending: Promise<void> | undefined;
  const load = (team: string) => pending ??= (async () => {
    tried = now();
    try {
      // Workers reject `redirect: 'error'`; a manual 3xx is not `ok`, so a redirect denies like any other failure.
      const res = await fetcher(`https://${team}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      const { keys } = res.ok ? await res.json() as { keys?: unknown } : {};
      if (!Array.isArray(keys)) throw new Error('certs');
      const imported = new Map<string, CryptoKey>();
      for (const { kid, kty, n, e } of keys) if (typeof kid === 'string' && kty === 'RSA' && typeof n === 'string' && typeof e === 'string') {
        imported.set(kid, await crypto.subtle.importKey('jwk', { kty, n, e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
      }
      cache = { team, at: tried, keys: imported };
    } catch { if (cache && tried - cache.at >= HOUR) cache = undefined; } finally { pending = undefined; }
  })();
  const key = async (team: string, kid: string) => {
    const fresh = cache?.team === team && now() - cache.at < HOUR;
    if ((!fresh || !cache?.keys.has(kid)) && now() - tried >= MINUTE) await load(team);
    else if (pending) await pending;
    return cache?.team === team && now() - cache.at < HOUR ? cache.keys.get(kid) : undefined;
  };
  return async (req, env) => {
    const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
    const parts = req.headers.get('cf-access-jwt-assertion')?.split('.') ?? [];
    if (!team || !aud || parts.length !== 3) return false;
    try {
      const header = json(parts[0]), claims = json(parts[1]), seconds = now() / 1000;
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
      if (claims.iss !== `https://${team}` || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return false;
      if (!int(claims.exp) || claims.exp <= seconds || (claims.nbf !== undefined && (!int(claims.nbf) || claims.nbf > seconds + 60))) return false;
      const publicKey = await key(team, header.kid);
      return !!publicKey && await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    } catch { return false; }
  };
}
