import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { blindIndex, blindIndexes, canonicalJson, createMac, open, seal, verifyMac } from '../src/core/crypto';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const context = { brand: 'acme', messageId: 'msg-1', purpose: 'content' as const };
const indexKey = { kid: 'i1', key: btoa(String.fromCharCode(...new Uint8Array(32).fill(11))).replace(/=+$/, '') };
let publicKey: JsonWebKey & { kid: string };
let privateKey: JsonWebKey & { kid: string };
beforeAll(async () => {
  const pair = await suite.kem.generateKeyPair();
  const encode = (raw: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  publicKey = { kty: 'OKP', crv: 'X25519', x: encode(await suite.kem.serializePublicKey(pair.publicKey)), kid: 'c1' };
  privateKey = { ...publicKey, d: encode(await suite.kem.serializePrivateKey(pair.privateKey)) };
});

describe('content envelopes', () => {
  it('accepts exactly the configured UTF-8 byte limit on both paths', async () => {
    const data = 'ą'.repeat(31);
    expect(new TextEncoder().encode(canonicalJson(data)).byteLength).toBe(64);
    const value = await seal(data, context, [publicKey], 64);
    expect(await open(value, context, [privateKey], 64)).toBe(data);
    await expect(seal(data + 'ą', context, [publicKey], 64)).rejects.toThrow(/^Unable to seal content$/);
    await expect(open(await independentEnvelope(data + 'ą'), context, [privateKey], 64)).rejects.toThrow(/^Unable to open content$/);
  });

  it('uses a default limit of two MiB for JSON bytes', async () => {
    const data = 'x'.repeat(2 * 1024 * 1024 - 2);
    const value = await seal(data, context, [publicKey]);
    expect(await open(value, context, [privateKey])).toBe(data);
    await expect(seal(data + 'x', context, [publicKey])).rejects.toThrow(/^Unable to seal content$/);
    await expect(open(await independentEnvelope(data + 'x'), context, [privateKey])).rejects.toThrow(/^Unable to open content$/);
    expect(await open(await seal(data + 'x', context, [publicKey], 3 * 1024 * 1024), context, [privateKey], 3 * 1024 * 1024)).toBe(data + 'x');
  });

  it('stops reading and cancels gzip output when it exceeds the limit', async () => {
    const data = 'x'.repeat(8 * 1024 * 1024);
    const value = await independentEnvelope(data);
    const NativeDecompressionStream = DecompressionStream;
    let readBytes = 0;
    let lastChunkBytes = 0;
    let cancelled = false;
    vi.stubGlobal('DecompressionStream', class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream;
      constructor(format: 'gzip') {
        const stream = new NativeDecompressionStream(format);
        const reader = stream.readable.getReader();
        this.writable = stream.writable;
        this.readable = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else {
              lastChunkBytes = next.value.byteLength;
              readBytes += lastChunkBytes;
              controller.enqueue(next.value);
            }
          },
          cancel() {
            cancelled = true;
            return reader.cancel();
          },
        }, { highWaterMark: 0 });
      }
    });
    try {
      await expect(open(value, context, [privateKey], 64 * 1024)).rejects.toThrow(/^Unable to open content$/);
      expect(cancelled).toBe(true);
      expect(readBytes).toBeGreaterThan(64 * 1024);
      expect(readBytes - lastChunkBytes).toBeLessThanOrEqual(64 * 1024);
      expect(readBytes).toBeLessThan(new TextEncoder().encode(canonicalJson(data)).byteLength);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([0, -1, NaN, Infinity, 1.5])('requires a positive integer byte limit: %s', async (limit) => {
    const value = await independentEnvelope(null);
    await expect(seal(null, context, [publicKey], limit)).rejects.toThrow(/^Unable to seal content$/);
    await expect(open(value, context, [privateKey], limit)).rejects.toThrow(/^Unable to open content$/);
  });

  it('opens a fixed envelope produced with HPKE and Node gzip', async () => {
    const pair = await suite.kem.deriveKeyPair(new Uint8Array(32).fill(7));
    const encode = (raw: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const key = { kty: 'OKP', crv: 'X25519', kid: 'fixture', x: encode(await suite.kem.serializePublicKey(pair.publicKey)), d: encode(await suite.kem.serializePrivateKey(pair.privateKey)) };
    expect(await open('ms1.fixture.3okjpnXQIYDN19AJe6QEueHikw1WZculjRdlAGNheTs.jT10erfFg5YsVo0_OE6N-oZCcTKnTndTydR6VQ0s1VI8HbPolUfg_7nLwTTP4llfrYxwyQ', context, [key])).toEqual({ fixture: true });
  });

  it('round trips JSON and uses the first public key', async () => {
    const data = { text: 'Zażółć 📨', values: [1, null, true] };
    const sealed = await seal(data, context, [publicKey, { ...publicKey, kid: 'old' }]);
    expect(sealed).toMatch(/^ms1\.c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await open(sealed, context, [{ ...privateKey, kid: 'new' }, privateKey])).toEqual(data);
    expect(await seal(data, context, [publicKey])).not.toBe(sealed);
    const [, , enc, ciphertext] = sealed.split('.');
    const plaintext = await suite.open({ recipientKey: await suite.kem.importKey('jwk', privateKey, false), enc: decode(enc), info: new TextEncoder().encode('mailstack/v1/content') }, decode(ciphertext), new TextEncoder().encode('acme|msg-1|content'));
    expect([...new Uint8Array(plaintext).slice(0, 2)]).toEqual([31, 139]);
    const json = await new Response(new Blob([plaintext]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(JSON.parse(json)).toEqual(data);
  });

  it.each([
    { ...context, brand: 'demo' },
    { ...context, messageId: 'msg-2' },
    { ...context, purpose: 'subject' as const },
  ])('requires the original context: %j', async (other) => {
    await expect(open(await seal({ ok: true }, context, [publicKey]), other, [privateKey])).rejects.toThrow('Unable to open content');
  });

  it('requires matching key identifiers and ciphertext bytes', async () => {
    const value = await seal('hello', context, [publicKey]);
    await expect(open(value.replace('.c1.', '.c2.'), context, [privateKey])).rejects.toThrow();
    const other = await suite.kem.generateKeyPair();
    const d = btoa(String.fromCharCode(...new Uint8Array(await suite.kem.serializePrivateKey(other.privateKey)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(open(value.replace('.c1.', '.c2.'), context, [privateKey, { ...privateKey, d, kid: 'c2' }])).rejects.toThrow();
    const parts = value.split('.');
    const bytes = new Uint8Array(decode(parts[3]));
    bytes[0] ^= 1;
    parts[3] = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(open(parts.join('.'), context, [privateKey])).rejects.toThrow();
  });

  it('returns fixed errors for invalid key material and input', async () => {
    await expect(seal({}, context, [{ kid: 'c1', kty: 'sentinel-material' }])).rejects.toThrow(/^Unable to seal content$/);
    for (const input of ['sentinel-material', 'ms1.c1.A.A', 'ms2.c1.A.A']) {
      await expect(open(input, context, [privateKey])).rejects.toThrow(/^Unable to open content$/);
    }
    await expect(seal({}, { ...context, brand: 'acme|other' }, [publicKey])).rejects.toThrow();
    await expect(seal({}, context, [])).rejects.toThrow();
  });
});

async function independentEnvelope(data: unknown): Promise<string> {
  const plaintext = await new Response(new Blob([canonicalJson(data)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const { enc, ct } = await suite.seal({ recipientPublicKey: await suite.kem.importKey('jwk', publicKey), info: new TextEncoder().encode('mailstack/v1/content') }, plaintext, new TextEncoder().encode('acme|msg-1|content'));
  const encode = (raw: ArrayBuffer) => btoa(Array.from(new Uint8Array(raw), (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `ms1.c1.${encode(enc)}.${encode(ct)}`;
}

function decode(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
}

describe('index and canonical MAC', () => {
  it.each<[string, unknown]>([
    ['{"a":"x@y"}', { a: 'x@y' }],
    ['"a@b"', 'a@b'],
  ])('uses distinct contexts for an address and JSON value %s', async (address, data) => {
    const index = await blindIndex(address, indexKey);
    const tag = await createMac(data, [indexKey]);
    expect(index.index).not.toBe(tag.mac.slice(0, 22));
  });

  it('requires the current MAC context', async () => {
    expect(await verifyMac({ z: 1, a: 2 }, { kid: 'i1', mac: 'bJYsNGiwWW4g9LpjKotkLDQbJyni44hSzjHo3YRhaNg' }, [indexKey])).toBe(false);
  });

  it('normalizes only the domain and matches a fixed digest', async () => {
    expect(await blindIndex(' Alice+tag@EXAMPLE.COM ', indexKey)).toEqual({ kid: 'i1', index: 'b9wBqr5yIzYo7CZ-kHaqYF' });
    expect(await blindIndex('alice+tag@example.com', indexKey)).not.toEqual(await blindIndex('Alice+tag@example.com', indexKey));
  });

  it('includes older index keys after rotation', async () => {
    const old = await blindIndex('User@example.com', indexKey);
    const keys = [{ kid: 'i2', key: btoa('x'.repeat(32)).replace(/=+$/, '') }, indexKey];
    const found = await blindIndexes('User@EXAMPLE.COM', keys);
    expect(found.map((v) => v.kid)).toEqual(['i2', 'i1']);
    expect(found).toContainEqual(old);
  });

  it('sorts object keys recursively, preserves arrays and JSON primitives', () => {
    expect(canonicalJson({ z: 1, a: [{ z: 0, a: -0 }, null, 'ą'] })).toBe('{"a":[{"a":0,"z":0},null,"ą"],"z":1}');
    expect(canonicalJson(JSON.parse('{"__proto__":1,"2":2,"10":10}'))).toBe('{"10":10,"2":2,"__proto__":1}');
    for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(), [undefined]]) expect(() => canonicalJson(value)).toThrow(/^Invalid JSON value$/);
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => canonicalJson(cycle)).toThrow(/^Invalid JSON value$/);
  });

  it('uses a full canonical HMAC and verifies by kid after rotation', async () => {
    const data = { z: 1, a: 2 };
    const tag = await createMac(data, [indexKey]);
    expect(tag).toEqual({ kid: 'i1', mac: 'BPC2gX0K_ylHZOY7dOCkE1SYc1fyEpbT5A-dzwhje8M' });
    const keys = [{ ...indexKey, kid: 'i2' }, indexKey];
    expect((await createMac(data, keys)).kid).toBe('i2');
    expect(await verifyMac({ a: 2, z: 1 }, tag, keys)).toBe(true);
    expect(await verifyMac({ a: 3, z: 1 }, tag, keys)).toBe(false);
    expect(await verifyMac(data, { ...tag, kid: 'absent' }, keys)).toBe(false);
    expect(await verifyMac(data, { ...tag, mac: 'invalid' }, keys)).toBe(false);
    await expect(createMac(data, [{ kid: 'i1', key: 'sentinel-material' }])).rejects.toThrow(/^Unable to compute MAC$/);
  });
});
