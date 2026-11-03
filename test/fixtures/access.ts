/** RSA keys and Cloudflare Access style tokens for tests. */
export const accessTeam = 'team.cloudflareaccess.com', accessAud = 'aud-tag-1';
export const accessEnv = { ACCESS_TEAM_DOMAIN: accessTeam, ACCESS_AUD: accessAud };
const rsa = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
export const b64 = (data: string | Uint8Array) => Buffer.from(data).toString('base64url');
export const accessKeyPair = () => crypto.subtle.generateKey(rsa, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
export const publicJwk = async (pair: CryptoKeyPair, kid: string) => ({ ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' });

export async function signAccessJwt(key: CryptoKey, nowMs: number, payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(nowMs / 1000);
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: 'k1', ...header }))}.${b64(JSON.stringify({ iss: `https://${accessTeam}`, aud: [accessAud], iat: now, nbf: now, exp: now + 600, ...payload }))}`;
  return `${input}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))))}`;
}

/** Fetch stand-in serving the given certs body; records each call. */
export function certsFetch(body: () => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const result = await body();
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : Response.json(result);
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}
