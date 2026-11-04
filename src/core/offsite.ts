// Storage outside the provider (Backblaze B2 through the S3 API): the daily copies and the erasure register share one bucket.
import { AwsClient } from 'aws4fetch';
import { Decrypter, Encrypter } from 'age-encryption';
import type { Tombstone } from './erase';

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
    const response = await client.fetch(new URL(`/${B2_BUCKET}/${path}`, endpoint), { ...init, redirect: 'manual' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`B2 ${init.method ?? 'GET'} failed: HTTP ${response.status}`); }
    return response;
  };
  return {
    put: async (key: string, body: Uint8Array) => { await (await call(key, { method: 'PUT', body })).body?.cancel(); },
    get: async (key: string) => new Uint8Array(await (await call(key)).arrayBuffer()),
    /** Every key under the prefix; a truncated page without a continuation token is an error, never a shorter list. */
    async list(prefix: string) {
      const keys: string[] = [];
      for (let token: string | undefined, more = true; more;) {
        const xml = await (await call('?' + new URLSearchParams({ 'list-type': '2', prefix, ...token ? { 'continuation-token': token } : {} }))).text();
        keys.push(...text(xml, 'Key'));
        more = text(xml, 'IsTruncated')[0] === 'true'; token = text(xml, 'NextContinuationToken')[0];
        if (more && !token) throw new Error('B2 listing truncated without a continuation token');
      }
      return keys;
    },
  };
}

/** age-encrypts for the owner's public key; the writer cannot read anything back. */
export async function seal(recipient: string, bytes: Uint8Array | string) {
  const encrypter = new Encrypter(); encrypter.addRecipient(recipient);
  return encrypter.encrypt(bytes);
}

export type TombstoneRegistry = (job: string, tombstones: Tombstone[]) => Promise<void>;
export interface RegisteredErasure { job: string; tombstones: Tombstone[] }
const REGISTRY = ['B2_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY', 'BACKUP_AGE_RECIPIENT'];
const prefix = (env: Vars) => typeof env.TOMBSTONE_PREFIX === 'string' && env.TOMBSTONE_PREFIX ? env.TOMBSTONE_PREFIX : 'tombstones/';

/** The API's writer of `<prefix><job>.age`; undefined without any register variable, an error for a partial set. */
export function tombstoneRegistry(env: object): TombstoneRegistry | undefined {
  const vars = env as Vars, missing = REGISTRY.filter(k => typeof vars[k] !== 'string' || !vars[k]);
  if (missing.length === REGISTRY.length) return undefined;
  if (missing.length) throw new Error(`The erasure register needs ${missing.join(', ')}`);
  const b2 = b2Client(vars);
  return async (job, tombstones) => b2.put(`${prefix(vars)}${job}.age`, await seal(vars.BACKUP_AGE_RECIPIENT as string, JSON.stringify({ job, tombstones })));
}

/** Every registered erasure. Refuses, instead of skipping, an object it cannot account for. */
export async function readTombstones(env: object, identity: string): Promise<RegisteredErasure[]> {
  const vars = env as Vars, b2 = b2Client(vars), decrypter = new Decrypter(), entries: RegisteredErasure[] = [];
  decrypter.addIdentity(identity);
  for (const key of await b2.list(prefix(vars))) {
    const job = /^(job_[a-f0-9]{32})\.age$/.exec(key.slice(prefix(vars).length))?.[1];
    if (!job) throw new Error(`Unexpected object ${key} in the erasure register`);
    const entry = JSON.parse(await decrypter.decrypt(await b2.get(key), 'text')) as RegisteredErasure;
    if (entry?.job !== job || !Array.isArray(entry.tombstones) || !entry.tombstones.length) throw new Error(`Invalid erasure register entry ${key}`);
    entries.push(entry);
  }
  return entries;
}
