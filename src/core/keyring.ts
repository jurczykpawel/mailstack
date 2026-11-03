import { z } from 'zod';
import { decode, encode } from './crypto/index.ts';
import type { ContentKey, IndexKey } from './crypto/index.ts';
import type { TransitPublicKey } from './transit.ts';

export interface KeyEnvironment { CONTENT_PUBLIC_KEYS?: string; INDEX_KEYS?: string }
export interface Keyring { contentKeys: ContentKey[]; indexKeys: IndexKey[] }
const kid = z.string().regex(/^[A-Za-z0-9_-]+$/);
const material = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const contentKey = z.strictObject({
  kid, kty: z.literal('OKP'), crv: z.literal('X25519'), x: material,
  ext: z.boolean().optional(), key_ops: z.array(z.never()).optional(), use: z.literal('enc').optional(),
});
const indexKey = z.strictObject({ kid, key: material });
const unique = (keys: { kid: string }[]) => new Set(keys.map(k => k.kid)).size === keys.length;
const privateSet = z.strictObject({ keys: z.array(contentKey.extend({ d: material, key_ops: z.array(z.literal('deriveBits')).optional() })).nonempty().refine(unique) });
const contentSet = z.strictObject({ keys: z.array(contentKey).nonempty().refine(unique) });
const indexSet = z.array(indexKey).nonempty().refine(unique);

export function parsePrivateKeys(value: string): ContentKey[] {
  try { return privateSet.parse(JSON.parse(value)).keys; }
  catch { throw new Error('Invalid key configuration'); }
}
const PKCS8_X25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

// TRANSIT_KEYS: private X25519 JWK set; the public half is recomputed from `d` so a mismatched `x` cannot be published.
export async function parseTransitKeys(value: string | undefined): Promise<{ privateKeys: ContentKey[]; publicKeys: TransitPublicKey[] }> {
  try {
    const privateKeys = parsePrivateKeys(value!);
    const publicKeys = await Promise.all(privateKeys.map(async (key) => {
      const pkcs8 = new Uint8Array([...PKCS8_X25519, ...new Uint8Array(decode(key.d!))]);
      const derived = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
      const { x } = await crypto.subtle.exportKey('jwk', derived) as JsonWebKey;
      if (!x || encode(decode(x)) !== key.x) throw new Error();
      return { kid: key.kid, x };
    }));
    return { privateKeys, publicKeys };
  } catch { throw new Error('Invalid key configuration'); }
}
export function parseIndexKeys(value: string): IndexKey[] {
  try { return indexSet.parse(JSON.parse(value)); }
  catch { throw new Error('Invalid key configuration'); }
}

export function parseKeyring(env: KeyEnvironment): Keyring {
  try {
    return {
      contentKeys: contentSet.parse(JSON.parse(env.CONTENT_PUBLIC_KEYS!)).keys,
      indexKeys: parseIndexKeys(env.INDEX_KEYS!),
    };
  } catch { throw new Error('Invalid key configuration'); }
}

/** Order-independent fingerprint of a content keyring (public parts only); shown by the key CLI and the panel. */
export async function keyringFingerprint(keys: readonly { kid: string; x?: string }[]): Promise<string> {
  const pairs = keys.map(k => [k.kid, k.x]).sort(([a], [b]) => (a! < b! ? -1 : 1));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(pairs))));
  return Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join('-');
}
