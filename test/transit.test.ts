import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { openTransit, sealTransit, TransitError, TRANSIT_TTL_MS } from '../src/core/transit';
import { parseTransitKeys } from '../src/core/keyring';
import { suite as coreSuite } from '../src/core/crypto';
import type { ContentKey } from '../src/core/crypto';
import { memoryStore } from './store-fixture';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const b64 = (raw: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = 1_800_000_000_000;
const replay = { aud: 'api-1', op: 'resend.replay' as const, messageId: 'msg_1' };
const search = { aud: 'api-1', op: 'log.search' as const };
let privateKeys: ContentKey[];
let publicKey: { kid: string; x: string };

async function keyPair(kid: string): Promise<ContentKey> {
  const pair = await suite.kem.generateKeyPair();
  return { kid, kty: 'OKP', crv: 'X25519', x: b64(await suite.kem.serializePublicKey(pair.publicKey)), d: b64(await suite.kem.serializePrivateKey(pair.privateKey)) };
}

async function rejects(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(TransitError);
  expect(error).toMatchObject({ code, status });
}

beforeAll(async () => {
  const set = await parseTransitKeys(JSON.stringify({ keys: [await keyPair('t1')] }));
  privateKeys = set.privateKeys;
  publicKey = set.publicKeys[0];
});

describe('transit envelope', () => {
  it('opens what it sealed for the same audience, operation and message', async () => {
    const value = await sealTransit({ replay: 'body' }, replay, publicKey, now);
    expect(value).toMatch(/^mt1\.t1\./);
    expect(await openTransit(value, replay, privateKeys, memoryStore(), now + 1000)).toEqual({ replay: 'body' });
    const query = await sealTransit({ address: 'jane@example.com' }, search, publicKey, now);
    expect(await openTransit(query, search, privateKeys, memoryStore(), now)).toEqual({ address: 'jane@example.com' });
  });

  it('records the nonce digest with the envelope expiry', async () => {
    const store = memoryStore();
    const keys: [string, number][] = [];
    const consume = store.consume.bind(store);
    store.consume = async (key, expires) => { keys.push([key, expires]); return consume(key, expires); };
    await openTransit(await sealTransit('x', replay, publicKey, now), replay, privateKeys, store, now);
    expect(keys).toEqual([[expect.stringMatching(/^transit-nonce:[0-9a-f]{64}$/), now + TRANSIT_TTL_MS]]);
  });

  it('rejects a different audience, operation or message', async () => {
    const value = await sealTransit('x', replay, publicKey, now);
    await rejects(openTransit(value, { ...replay, aud: 'api-2' }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(value, { ...replay, op: 'resend.source' }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(value, { ...replay, messageId: 'msg_2' }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(value, { aud: 'api-1', op: 'resend.replay' }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('rejects an elapsed or too distant expiry', async () => {
    const value = await sealTransit('x', replay, publicKey, now);
    await rejects(openTransit(value, replay, privateKeys, memoryStore(), now + TRANSIT_TTL_MS), 'transit_expired', 400);
    await rejects(openTransit(value, replay, privateKeys, memoryStore(), now - 61_000), 'transit_invalid', 400);
    await expect(sealTransit('x', replay, publicKey, now, TRANSIT_TTL_MS + 1)).rejects.toThrow(TransitError);
  });

  it('accepts a nonce once', async () => {
    const store = memoryStore();
    const value = await sealTransit('x', replay, publicKey, now);
    await openTransit(value, replay, privateKeys, store, now);
    await rejects(openTransit(value, replay, privateKeys, store, now), 'replayed', 409);
  });

  it('does not record a nonce for an envelope that fails other checks', async () => {
    const store = memoryStore();
    const value = await sealTransit('x', replay, publicKey, now);
    await rejects(openTransit(value, { ...replay, aud: 'api-2' }, privateKeys, store, now), 'transit_invalid', 400);
    expect(await openTransit(value, replay, privateKeys, store, now)).toBe('x');
  });

  it('propagates storage failures instead of accepting the envelope', async () => {
    const store = memoryStore();
    store.consume = async () => { throw new Error('storage down'); };
    await expect(openTransit(await sealTransit('x', replay, publicKey, now), replay, privateKeys, store, now)).rejects.toThrow('storage down');
  });

  it('rejects an unknown key id and a changed ciphertext or header', async () => {
    const value = await sealTransit('x', replay, publicKey, now);
    const [v, , nonce, enc, ct] = value.split('.');
    await rejects(openTransit([v, 't9', nonce, enc, ct].join('.'), replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    const flipped = ct.slice(0, -2) + (ct.at(-2) === 'A' ? 'B' : 'A') + ct.at(-1);
    await rejects(openTransit([v, 't1', nonce, enc, flipped].join('.'), replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    const otherNonce = b64(new Uint8Array(16).fill(7));
    await rejects(openTransit([v, 't1', otherNonce, enc, ct].join('.'), replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(value + '.x', replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit('mt2' + value.slice(3), replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('rejects envelopes sealed for another key', async () => {
    const other = await parseTransitKeys(JSON.stringify({ keys: [await keyPair('t1')] }));
    const value = await sealTransit('x', replay, other.publicKeys[0], now);
    await rejects(openTransit(value, replay, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('limits the payload to 64 KiB on both sides', async () => {
    const fits = 'x'.repeat(64 * 1024 - 2);
    expect(await openTransit(await sealTransit(fits, search, publicKey, now), search, privateKeys, memoryStore(), now)).toBe(fits);
    await expect(sealTransit(fits + 'x', search, publicKey, now)).rejects.toThrow(TransitError);
    const oversized = await independentEnvelope({ op: 'log.search', messageId: null, nonce: b64(new Uint8Array(16)), exp: now + 1000, payload: fits + 'x' });
    await rejects(openTransit(oversized, search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('rejects an oversized envelope before decrypting it', async () => {
    const [v, kid, nonce, enc, ct] = (await sealTransit('x', search, publicKey, now)).split('.');
    const open = vi.spyOn(coreSuite, 'open');
    try {
      await rejects(openTransit([v, kid, nonce, enc, ct + 'A'.repeat(128 * 1024)].join('.'), search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });

  it('rejects operations outside the closed list on both sides', async () => {
    const op = 'messages.delete' as 'log.search';
    await expect(sealTransit('x', { aud: 'api-1', op }, publicKey, now)).rejects.toThrow(TransitError);
    await rejects(openTransit(await sealTransit('x', search, publicKey, now), { aud: 'api-1', op }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    const forged = await independentEnvelope({ op, messageId: null, nonce: b64(new Uint8Array(16)), exp: now + 1000, payload: 'x' }, op);
    await rejects(openTransit(forged, { aud: 'api-1', op }, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('rejects an inner body that disagrees with the authenticated header', async () => {
    const nonce = b64(new Uint8Array(16).fill(1));
    const inner = (overrides: object) => independentEnvelope({ op: 'log.search', messageId: null, nonce, exp: now + 1000, payload: 'x', ...overrides }, 'log.search', nonce);
    expect(await openTransit(await inner({}), search, privateKeys, memoryStore(), now)).toBe('x');
    await rejects(openTransit(await inner({ op: 'subjects.erase' }), search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(await inner({ messageId: 'msg_1' }), search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(await inner({ nonce: b64(new Uint8Array(16).fill(2)) }), search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
    await rejects(openTransit(await inner({ exp: '9' }), search, privateKeys, memoryStore(), now), 'transit_invalid', 400);
  });

  it('keeps the sealing side free of Node built-ins', () => {
    for (const file of ['src/core/transit.ts', 'src/core/crypto/index.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from ['"](node:|\.\.?\/.*store)/);
    }
  });
});

describe('transit keys', () => {
  it('derives the public half from each private key', async () => {
    const [a, b] = [await keyPair('t1'), await keyPair('t2')];
    const set = await parseTransitKeys(JSON.stringify({ keys: [a, b] }));
    expect(set.publicKeys).toEqual([{ kid: 't1', x: a.x }, { kid: 't2', x: b.x }]);
    expect(set.privateKeys.map((k) => k.kid)).toEqual(['t1', 't2']);
  });

  it('rejects a public half that does not belong to the private key', async () => {
    const [a, b] = [await keyPair('t1'), await keyPair('t2')];
    await expect(parseTransitKeys(JSON.stringify({ keys: [{ ...a, x: b.x }] }))).rejects.toThrow('Invalid key configuration');
  });

  it('rejects missing, public-only and duplicate keys', async () => {
    const a = await keyPair('t1');
    const { d: _d, ...publicOnly } = a;
    for (const value of [undefined, '', '{"keys":[]}', JSON.stringify({ keys: [publicOnly] }), JSON.stringify({ keys: [a, a] })]) {
      await expect(parseTransitKeys(value)).rejects.toThrow('Invalid key configuration');
    }
  });
});

async function independentEnvelope(body: object, op = 'log.search', nonce = (body as { nonce: string }).nonce): Promise<string> {
  const recipientPublicKey = await suite.kem.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: publicKey.x });
  const enc = new TextEncoder();
  const { enc: encapsulated, ct } = await suite.seal(
    { recipientPublicKey, info: enc.encode('mailstack/v1/transit').buffer },
    enc.encode(JSON.stringify(body)).buffer,
    enc.encode(`ms-transit|api-1|${op}|-|${nonce}`).buffer,
  );
  return `mt1.t1.${nonce}.${b64(encapsulated)}.${b64(ct)}`;
}
