import { z } from 'zod';
import type { ContentKey, IndexKey } from './crypto';

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
