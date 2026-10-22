import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChallenge, verifyAltcha } from '../src/altcha';
import { handleSend } from '../src/send';
import type { Env, SendDeps } from '../src/types';

const KEY = 'test-altcha-lifecycle-key';
const START = new Date('2026-10-22T12:00:00Z');
const encode = (value: unknown) => btoa(JSON.stringify(value));
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');

async function signed(salt: string, number: unknown = 0) {
  const enc = new TextEncoder();
  const challenge = hex(await crypto.subtle.digest('SHA-256', enc.encode(salt + number)));
  const key = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, enc.encode(challenge)));
  return { algorithm: 'SHA-256', salt, number, challenge, signature };
}

function fixture() {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string, _options?: KVNamespacePutOptions) => { store.set(key, value); });
  const kv = { get, put } as unknown as KVNamespace;
  const env = { ALTCHA_HMAC_KEY: KEY, API_KEY: 'test-api-key', RATE_LIMIT: kv } as Env;
  const deps: SendDeps = {
    verifyAltcha, verifyTurnstile: vi.fn(async () => true),
    sendEmail: vi.fn(async () => ({ ok: true, status: 200 })), now: () => new Date(),
  };
  const send = (payload: string, headers: Record<string, string> = {}, brand = 'demo') => handleSend(new Request('https://mail.example/v1/send', {
    method: 'POST', headers: { origin: `https://${brand}.example`, ...headers },
    body: JSON.stringify({ brand, altcha: payload, message: 'Hello', autoreply: false }),
  }), env, deps);
  return { env, deps, get, put, send };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

describe('ALTCHA submission lifecycle', () => {
  it('issues a ten-minute expiry in the salt', async () => {
    const ch = await createChallenge(KEY, { maxnumber: 0 });
    expect(ch.salt).toMatch(new RegExp(`^[a-f0-9]{24}\\?expires=${START.getTime() / 1000 + 600}$`));
    expect(await verifyAltcha(KEY, encode({ ...ch, number: 0 }))).toBe(true);
  });

  it('accepts the first submission and declines the next with one send', async () => {
    const f = fixture();
    const payload = encode(await signed(`abcdef?expires=${START.getTime() / 1000 + 600}`));
    expect((await f.send(payload)).status).toBe(200);
    const next = await f.send(payload);
    expect(next.status).toBe(403);
    expect(await next.json()).toEqual({ success: false, message: 'verification failed' });
    expect(f.deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(f.put.mock.calls[0][2]).toEqual({ expirationTtl: 600 });
  });

  it.each([0, -1])('declines expiry offset %s before storage or send', async (offset) => {
    const f = fixture();
    expect((await f.send(encode(await signed(`abcdef?expires=${START.getTime() / 1000 + offset}`)))).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.deps.sendEmail).not.toHaveBeenCalled();
  });

  it.each(['abcdef', 'abcdef?expires=no', 'abcdef?expires=1.5', 'abcdef?expires=999999999999999999999', 'abcdef?expires=1792671000&expires=1792671001'])('declines invalid expiry %s', async salt => {
    const f = fixture();
    expect((await f.send(encode(await signed(salt)))).status).toBe(403);
    expect(f.deps.sendEmail).not.toHaveBeenCalled();
  });

  it('declines a changed expiry with the original signature', async () => {
    const p = await signed(`abcdef?expires=${START.getTime() / 1000 + 600}`);
    p.salt = `abcdef?expires=${START.getTime() / 1000 + 601}`;
    expect(await verifyAltcha(KEY, encode(p))).toBe(false);
  });

  it.each([-1, 0.5, 100001, '0', null, {}, []])('declines number %j even with a matching digest', async number => {
    expect(await verifyAltcha(KEY, encode(await signed(`abcdef?expires=${START.getTime() / 1000 + 600}`, number)))).toBe(false);
  });

  it.each(['read', 'write', 'missing'])('declines unavailable storage: %s', async failure => {
    const f = fixture();
    if (failure === 'read') f.get.mockRejectedValue(new Error('unavailable'));
    if (failure === 'write') f.put.mockRejectedValue(new Error('unavailable'));
    if (failure === 'missing') delete f.env.RATE_LIMIT;
    expect((await f.send(encode(await signed(`abcdef?expires=${START.getTime() / 1000 + 600}`)))).status).toBe(403);
    expect(f.deps.sendEmail).not.toHaveBeenCalled();
  });

  it('uses the minimum KV TTL near expiry without extending acceptance', async () => {
    const f = fixture();
    const payload = encode(await signed(`abcdef?expires=${START.getTime() / 1000 + 1}`));
    expect((await f.send(payload)).status).toBe(200);
    expect(f.put.mock.calls[0][2]).toEqual({ expirationTtl: 60 });
    vi.setSystemTime(new Date(START.getTime() + 1000));
    expect((await f.send(payload)).status).toBe(403);
    expect(f.deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('requires a new solution after a failed delivery', async () => {
    const f = fixture();
    vi.mocked(f.deps.sendEmail).mockResolvedValue({ ok: false, status: 502 });
    const payload = encode(await signed(`abcdef?expires=${START.getTime() / 1000 + 600}`));
    expect((await f.send(payload)).status).toBe(502);
    expect((await f.send(payload)).status).toBe(403);
    expect(f.deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps trusted and Turnstile submissions independent of ALTCHA storage', async () => {
    const f = fixture();
    delete f.env.RATE_LIMIT;
    expect((await f.send('', { authorization: 'Bearer test-api-key' })).status).toBe(200);
    expect((await f.send('', {}, 'acme')).status).toBe(200);
    expect(f.deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(f.deps.sendEmail).toHaveBeenCalledTimes(2);
  });
});
