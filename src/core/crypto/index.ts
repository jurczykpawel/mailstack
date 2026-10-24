import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';

export type ContentKey = JsonWebKey & { kid: string };
export interface IndexKey { kid: string; key: string }
export interface Mac { kid: string; mac: string }
export interface SealContext {
  brand: string;
  messageId: string;
  purpose: 'rcpt' | 'subject' | 'ref' | 'content' | 'replay' | 'evidence' | 'provider_response';
}

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const utf8 = new TextEncoder();
const purposes = new Set(['rcpt', 'subject', 'ref', 'content', 'replay', 'evidence', 'provider_response']);
const invalid = () => new Error('Invalid key configuration');

function encode(value: ArrayBuffer): string {
  return btoa(Array.from(new Uint8Array(value), (b) => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (encode(bytes.buffer) !== value) throw invalid();
  return bytes.buffer;
}

function checkKids(keys: readonly { kid: string }[]): void {
  if (!keys.length || new Set(keys.map((k) => k.kid)).size !== keys.length ||
      keys.some((k) => typeof k.kid !== 'string' || !/^[A-Za-z0-9_-]+$/.test(k.kid))) throw invalid();
}

function binding(context: SealContext): { info: ArrayBuffer; aad: ArrayBuffer } {
  const { brand, messageId, purpose } = context;
  if (!purposes.has(purpose) || [brand, messageId].some((v) => typeof v !== 'string' || !v || v.includes('|'))) throw invalid();
  return { info: new Uint8Array(utf8.encode(`mailstack/v1/${purpose}`)).buffer, aad: new Uint8Array(utf8.encode(`${brand}|${messageId}|${purpose}`)).buffer };
}

export async function seal(data: unknown, context: SealContext, keys: readonly ContentKey[]): Promise<string> {
  try {
    checkKids(keys);
    const { info, aad } = binding(context);
    const key = keys[0];
    if (key.d !== undefined || key.kty !== 'OKP' || key.crv !== 'X25519') throw invalid();
    const recipientPublicKey = await suite.kem.importKey('jwk', key);
    const compressed = await new Response(new Blob([canonicalJson(data)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const { enc, ct } = await suite.seal({ recipientPublicKey, info }, compressed, aad);
    return `ms1.${key.kid}.${encode(enc)}.${encode(ct)}`;
  } catch {
    throw new Error('Unable to seal content');
  }
}

export async function open(value: string, context: SealContext, keys: readonly ContentKey[]): Promise<unknown> {
  try {
    checkKids(keys);
    const { info, aad } = binding(context);
    const [version, kid, enc, ciphertext, extra] = value.split('.');
    if (version !== 'ms1' || extra !== undefined) throw invalid();
    const key = keys.find((k) => k.kid === kid);
    if (!key?.d || key.kty !== 'OKP' || key.crv !== 'X25519') throw invalid();
    const recipientKey = await suite.kem.importKey('jwk', key, false);
    const plaintext = await suite.open({ recipientKey, enc: decode(enc), info }, decode(ciphertext), aad);
    const json = await new Response(new Blob([plaintext]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(json);
  } catch {
    throw new Error('Unable to open content');
  }
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown): string {
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return JSON.stringify(v);
    if (typeof v !== 'object' || seen.has(v)) throw new Error('Invalid JSON value');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      result = '[' + Array.from(v, visit).join(',') + ']';
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Invalid JSON value');
      result = '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + visit((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    seen.delete(v);
    return result;
  }
  try { return visit(value); } catch { throw new Error('Invalid JSON value'); }
}

async function hmacKey(key: IndexKey): Promise<CryptoKey> {
  const raw = decode(key.key);
  if (raw.byteLength !== 32) throw invalid();
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function blindIndex(address: string, key: IndexKey): Promise<{ kid: string; index: string }> {
  try {
    checkKids([key]);
    const trimmed = address.trim();
    const at = trimmed.lastIndexOf('@');
    if (at < 1 || at === trimmed.length - 1) throw invalid();
    const normalized = trimmed.slice(0, at + 1) + trimmed.slice(at + 1).toLowerCase();
    const digest = await crypto.subtle.sign('HMAC', await hmacKey(key), utf8.encode('mailstack/v1/idx\n' + normalized));
    return { kid: key.kid, index: encode(digest).slice(0, 22) };
  } catch {
    throw new Error('Unable to compute index');
  }
}

export async function blindIndexes(address: string, keys: readonly IndexKey[]): Promise<{ kid: string; index: string }[]> {
  try {
    checkKids(keys);
    return await Promise.all(keys.map((key) => blindIndex(address, key)));
  } catch {
    throw new Error('Unable to compute index');
  }
}

function macInput(data: unknown): Uint8Array {
  return utf8.encode('mailstack/v1/mac\n' + canonicalJson(data));
}

export async function createMac(data: unknown, keys: readonly IndexKey[]): Promise<Mac> {
  try {
    checkKids(keys);
    const key = keys[0];
    const digest = await crypto.subtle.sign('HMAC', await hmacKey(key), macInput(data));
    return { kid: key.kid, mac: encode(digest) };
  } catch {
    throw new Error('Unable to compute MAC');
  }
}

export async function verifyMac(data: unknown, tag: Mac, keys: readonly IndexKey[]): Promise<boolean> {
  try {
    checkKids(keys);
    const key = keys.find((k) => k.kid === tag.kid);
    return !!key && await crypto.subtle.verify('HMAC', await hmacKey(key), decode(tag.mac), macInput(data));
  } catch {
    return false;
  }
}
