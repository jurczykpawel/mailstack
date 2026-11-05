// Storage outside the provider (Backblaze B2 through the S3 API): the daily copies and the erasure register share one bucket.
import { AwsClient } from 'aws4fetch';
import { Decrypter, Encrypter } from 'age-encryption';
import type { Tombstone } from './erase';
import { sql, type CompiledQuery } from 'kysely';
import type { KyselyStore } from './store';

type Vars = Record<string, unknown>;
const XML: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map(m => m[1].replace(/&(\w+);/g, (_, e) => XML[e] ?? `&${e};`));

export function b2Client({ B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY }: Vars) {
  if (![B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY].every(v => typeof v === 'string' && v)) throw new Error('B2_ENDPOINT, B2_BUCKET, B2_KEY_ID and B2_APP_KEY are required');
  const endpoint = new URL(B2_ENDPOINT as string);
  const client = new AwsClient({ accessKeyId: B2_KEY_ID as string, secretAccessKey: B2_APP_KEY as string, service: 's3', retries: 0, region: endpoint.hostname.match(/^s3\.([\w-]+)\./)?.[1] ?? 'us-east-1' });
  // No retries inside a call: every attempt is a Worker subrequest; the job engine and the daily loop retry instead.
  // Workers reject `redirect: 'error'`; a manual 3xx is not `ok`, so a redirect fails like any other refusal.
  const call = async (path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([(async () => {
        const response = await client.fetch(new URL(`/${B2_BUCKET}/${path}`, endpoint), { ...init, redirect: 'manual', signal: controller.signal });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`B2 ${init.method ?? 'GET'} failed: HTTP ${response.status}`); }
        return init.method === 'PUT' ? (await response.body?.cancel(), new Uint8Array()) : new Uint8Array(await response.arrayBuffer());
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('B2 deadline')); }, 2000); })]);
    } finally { clearTimeout(timer!); }
  };
  return {
    put: async (key: string, body: Uint8Array) => { await call(key, { method: 'PUT', body }); },
    get: (key: string) => call(key),
    /** Every key under the prefix; a truncated page without a continuation token is an error, never a shorter list. */
    async list(prefix: string) {
      const keys: string[] = [];
      for (let token: string | undefined, more = true; more;) {
        const xml = new TextDecoder().decode(await call('?' + new URLSearchParams({ 'list-type': '2', prefix, ...token ? { 'continuation-token': token } : {} })));
        keys.push(...text(xml, 'Key'));
        more = text(xml, 'IsTruncated')[0] === 'true'; token = text(xml, 'NextContinuationToken')[0];
        if (more && !token) throw new Error('B2 listing truncated without a continuation token');
      }
      return keys;
    },
  };
}

/** Encrypts to the owner's public age key; only the owner can decrypt the payload. */
export async function seal(recipient: string, bytes: Uint8Array | string) {
  const encrypter = new Encrypter(); encrypter.addRecipient(recipient);
  return encrypter.encrypt(bytes);
}

export type TombstoneRegistry = (job: string, tombstones: Tombstone[], store: KyselyStore) => Promise<{ registered: boolean; error?: 'erasure_registry_unavailable'; writes?: CompiledQuery[] }>;
export interface RegisteredErasure { job: string; tombstones: Tombstone[] }
const REGISTRY = ['B2_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY', 'BACKUP_AGE_RECIPIENT', 'TOMBSTONE_REGISTRY_ID'];
const prefix = (env: Vars) => typeof env.TOMBSTONE_PREFIX === 'string' && env.TOMBSTONE_PREFIX ? env.TOMBSTONE_PREFIX : 'tombstones/';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(b => b.toString(16).padStart(2, '0')).join('');
interface Head { registry: string; seq: number; hash: string }
interface RecordRow { seq: number; job: string; sealed: string; hash: string; confirmed: number }
export const erasureAvailable = (env: object) => REGISTRY.every(k => typeof Reflect.get(env, k) === 'string' && Reflect.get(env, k))
  ? /^[\w-]{16,128}$/.test(String(Reflect.get(env, 'TOMBSTONE_REGISTRY_ID')))
  : REGISTRY.every(k => !Reflect.get(env, k)) && Reflect.get(env, 'MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY') === 'true';
const registryId = (vars: Vars) => {
  if (typeof vars.TOMBSTONE_REGISTRY_ID !== 'string' || !/^[\w-]{16,128}$/.test(vars.TOMBSTONE_REGISTRY_ID)) throw new Error('TOMBSTONE_REGISTRY_ID required');
  return vars.TOMBSTONE_REGISTRY_ID;
};
async function registryHead(vars: Vars) {
  const b2 = b2Client(vars), p = prefix(vars), registry = registryId(vars);
  const rawGenesis = await b2.get(p + 'genesis'), genesis = JSON.parse(new TextDecoder().decode(rawGenesis));
  const head = JSON.parse(new TextDecoder().decode(await b2.get(p + 'head'))) as Head;
  if (genesis.registry !== registry || head.registry !== registry || !Number.isSafeInteger(head.seq) || head.seq < 0 || head.seq === 0 && head.hash !== await digest(rawGenesis) || !/^[a-f0-9]{64}$/.test(head.hash)) throw new Error('Invalid erasure register head');
  return { b2, p, head };
}
/** Installation only: the caller must choose a fresh, empty prefix and retain its registry id with the backups. */
export async function initTombstoneRegistry(env: object) {
  const vars = env as Vars, b2 = b2Client(vars), p = prefix(vars), registry = registryId(vars);
  const genesis = bytes({ registry }), head = bytes({ registry, seq: 0, hash: await digest(genesis) });
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  // A rerun after a lost response finds only its own genesis/head and completes them; anything else is refused.
  const found = await b2.list(p);
  if (found.some(k => k !== p + 'genesis' && k !== p + 'head')) throw new Error('Erasure register prefix is not empty');
  for (const [name, value] of [['genesis', genesis], ['head', head]] as const) {
    if (!found.includes(p + name)) await b2.put(p + name, value);
    else if (!same(await b2.get(p + name), value)) throw new Error('Erasure register prefix is not empty');
  }
}

export function tombstoneRegistry(env: object): TombstoneRegistry {
  const vars = env as Vars, missing = REGISTRY.filter(k => typeof vars[k] !== 'string' || !vars[k]);
  if (missing.length === REGISTRY.length && vars.MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY === 'true') return async () => ({ registered: true });
  if (missing.length) throw new Error(`The erasure register needs ${missing.join(', ')}`);
  registryId(vars);
  return async (job, tombstones, store) => {
    const { rows: [schema] } = await sql`select 1 from sqlite_master where type='table' and name='erasure_registry'`.execute(store.db);
    if (!schema) return { registered: false, error: 'erasure_registry_unavailable' };
    const { b2, p, head } = await registryHead(vars);
    const rows = (await sql<RecordRow>`select * from erasure_registry order by seq desc limit 1`.execute(store.db)).rows, last = rows[0];
    const own = (await sql<RecordRow>`select * from erasure_registry where job=${job}`.execute(store.db)).rows[0];
    if (!own) {
      if (last && (!last.confirmed || head.seq < last.seq || head.seq === last.seq && head.hash !== last.hash)) throw new Error('Erasure register awaiting confirmation');
      const seq = head.seq + 1, entry = { registry: head.registry, seq, prev: head.hash, job, tombstones };
      const sealed = await seal(vars.BACKUP_AGE_RECIPIENT as string, bytes(entry)), hash = await digest(sealed);
      return { registered: false, writes: [sql`insert into erasure_registry(seq,job,sealed,hash,confirmed)
        values(${seq},${job},${btoa(String.fromCharCode(...sealed))},${hash},0)`.compile(store.db)] };
    }
    if (head.seq !== own.seq - 1 && !(head.seq === own.seq && head.hash === own.hash)) throw new Error('Erasure register head changed');
    await b2.put(`${p}${own.seq}.age`, Uint8Array.from(atob(own.sealed), c => c.charCodeAt(0)));
    await b2.put(p + 'head', bytes({ registry: head.registry, seq: own.seq, hash: own.hash }));
    return { registered: true, writes: [sql`update erasure_registry set confirmed=1 where seq=${own.seq}`.compile(store.db)] };
  };
}

/** Independent of both databases: genesis, head, numbered objects and their ciphertext hashes must agree. */
export async function readTombstones(env: object, identity: string): Promise<RegisteredErasure[]> {
  const vars = env as Vars, { b2, p, head } = await registryHead(vars), decrypter = new Decrypter(), entries: RegisteredErasure[] = [];
  decrypter.addIdentity(identity);
  const keys = new Set(await b2.list(p));
  if (keys.size !== head.seq + 2 || !keys.has(p + 'genesis') || !keys.has(p + 'head')) throw new Error('Incomplete erasure register');
  let prev = await digest(await b2.get(p + 'genesis'));
  for (let seq = 1; seq <= head.seq; seq++) {
    const key = `${p}${seq}.age`;
    if (!keys.has(key)) throw new Error(`Missing erasure register entry ${key}`);
    const sealed = await b2.get(key), entry = JSON.parse(await decrypter.decrypt(sealed, 'text'));
    if (entry.registry !== head.registry || entry.seq !== seq || entry.prev !== prev || !/^job_[a-f0-9]{32}$/.test(entry.job) || !Array.isArray(entry.tombstones) || !entry.tombstones.length) throw new Error(`Invalid erasure register entry ${key}`);
    entries.push({ job: entry.job, tombstones: entry.tombstones }); prev = await digest(sealed);
  }
  if (prev !== head.hash) throw new Error('Erasure register hash mismatch');
  return entries;
}
