import { beforeAll, describe, expect, it } from 'vitest';
import { createAccessVerifier } from '../src/core/access';
import { accessAud as aud, accessEnv as env, accessKeyPair, accessTeam as team, b64, certsFetch, publicJwk, signAccessJwt } from './fixtures/access';

let signer: CryptoKeyPair, other: CryptoKeyPair, jwk: Awaited<ReturnType<typeof publicJwk>>;
const start = 1_800_000_000_000;
let clock = start;

const jwt = (payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = signer.privateKey) => signAccessJwt(key, clock, payload, header);
const request = (token?: string) => new Request('https://internal.example/internal/v2/messages', { headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token } });

function setup(body: () => unknown = () => ({ keys: [jwk] })) {
  clock = start;
  const { calls, fetcher } = certsFetch(body);
  const verify = createAccessVerifier(fetcher, () => clock);
  return { calls, verify: (token?: string) => verify(request(token), env), advance: (ms: number) => { clock += ms; } };
}

beforeAll(async () => {
  [signer, other] = await Promise.all([accessKeyPair(), accessKeyPair()]);
  jwk = await publicJwk(signer, 'k1');
});

describe('Access JWT verification', () => {
  it('accepts a token signed by the team key and fetches the certs once', async () => {
    const t = setup();
    expect(await t.verify(await jwt())).toBe(true);
    expect(await t.verify(await jwt({ aud }))).toBe(true);
    expect(await t.verify(await jwt({ nbf: Math.floor(start / 1000) + 30 }))).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe(`https://${team}/cdn-cgi/access/certs`);
    expect(t.calls[0].init?.redirect).toBe('error');
    expect(t.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects tokens with a wrong signature, algorithm or claims', async () => {
    const t = setup(), now = Math.floor(clock / 1000);
    const hs = `${b64(JSON.stringify({ alg: 'HS256', kid: 'k1' }))}.${b64(JSON.stringify({ iss: `https://${team}`, aud: [aud], exp: now + 600 }))}`;
    const hsKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(JSON.stringify(jwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const cases = [
      await jwt({}, {}, other.privateKey),
      `${b64(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64(JSON.stringify({ iss: `https://${team}`, aud: [aud], exp: now + 600 }))}.`,
      `${hs}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', hsKey, new TextEncoder().encode(hs))))}`,
      await jwt({ aud: ['other-aud'] }), await jwt({ aud: 'other-aud' }), await jwt({ aud: undefined }),
      await jwt({ iss: 'https://other.cloudflareaccess.com' }),
      await jwt({ exp: now - 1 }), await jwt({ exp: now }), await jwt({ exp: undefined }), await jwt({ exp: now + 600.5 }), await jwt({ exp: String(now + 600) }),
      await jwt({ nbf: now + 61 }), await jwt({ nbf: now + 0.5 }),
      await jwt({}, { alg: 'RS512' }), await jwt({}, { alg: 'PS256' }),
      await jwt({}, { kid: undefined }), 'a.b', 'not-a-token', '',
    ];
    for (const token of cases) expect(await t.verify(token), token).toBe(false);
    expect(await t.verify()).toBe(false);
    expect(await t.verify(await jwt())).toBe(true);
  });

  it('fails closed without certs or configuration', async () => {
    for (const body of [() => new Error('offline'), () => new Response('no', { status: 500 }), () => ({ keys: 'x' }), () => new Response('{bad')]) {
      expect(await setup(body).verify(await jwt())).toBe(false);
    }
    let calls = 0;
    const token = await jwt();
    const verify = createAccessVerifier((async () => { calls++; return Response.json({ keys: [jwk] }); }) as unknown as typeof fetch, () => start);
    for (const config of [{ ACCESS_AUD: aud }, { ACCESS_TEAM_DOMAIN: team }, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: '' }]) {
      expect(await verify(request(token), config)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it('refetches unknown key ids at most once a minute and keeps certs for an hour', async () => {
    const t = setup();
    expect(await t.verify(await jwt())).toBe(true);
    for (let i = 0; i < 100; i++) expect(await t.verify(await jwt({}, { kid: crypto.randomUUID() }))).toBe(false);
    expect(t.calls).toHaveLength(1);
    t.advance(59_000);
    expect(await t.verify(await jwt({}, { kid: 'k-new' }))).toBe(false);
    expect(t.calls).toHaveLength(1);
    t.advance(2_000);
    expect(await t.verify(await jwt({}, { kid: 'k-new' }))).toBe(false);
    expect(t.calls).toHaveLength(2);
    t.advance(3_500_000);
    expect(await t.verify(await jwt())).toBe(true);
    expect(t.calls).toHaveLength(2);
    t.advance(100_000);
    await t.verify(await jwt());
    expect(t.calls).toHaveLength(3);
  });

  it('accepts a rotated key after one refetch and shares concurrent fetches', async () => {
    let keys = [jwk];
    const t = setup(() => ({ keys }));
    expect(await t.verify(await jwt())).toBe(true);
    keys = [jwk, await publicJwk(other, 'k2')];
    t.advance(60_000);
    const token = await jwt({}, { kid: 'k2' }, other.privateKey);
    expect(await Promise.all([t.verify(token), t.verify(token), t.verify(token)])).toEqual([true, true, true]);
    expect(t.calls).toHaveLength(2);
  });
});
