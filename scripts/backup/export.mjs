// Daily encrypted copy outside the provider: D1 export (Cloudflare API) or newest Node snapshot -> age -> B2 (S3 API).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { AwsClient } from 'aws4fetch';
import { Encrypter } from 'age-encryption';

// The runtime image has no Wrangler (dev dependency), so D1 is exported through the REST API: start, poll the bookmark, download the signed dump.
export async function d1Export(database, { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }, { fetch: get = fetch, wait = sleep, polls = 600 } = {}) {
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for a D1 copy');
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/export`;
  let body = { output_format: 'polling' };
  for (let poll = 0; poll < polls; poll++) {
    const response = await get(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' });
    const { success, result } = await response.json().catch(() => ({}));
    if (!response.ok || !success || result?.status === 'error') throw new Error(`D1 export failed: HTTP ${response.status}${result?.error ? ` ${result.error}` : ''}`);
    if (result.result?.signed_url) {
      const dump = await get(result.result.signed_url, { redirect: 'error' });
      if (!dump.ok) throw new Error(`D1 export download failed: HTTP ${dump.status}`);
      return Buffer.from(await dump.arrayBuffer());
    }
    if (!result.at_bookmark) throw new Error('D1 export failed: no bookmark');
    body = { output_format: 'polling', current_bookmark: result.at_bookmark };
    await wait(1000);
  }
  throw new Error('D1 export did not finish');
}

async function readSource({ d1, sqliteDir, exportD1, now }) {
  if (d1) return { name: `${d1}-${new Date(now).toISOString().replace(/[-:]|\.\d+/g, '')}.sql`, bytes: await exportD1(d1) };
  const latest = (await readdir(sqliteDir)).filter(name => /^mailstack-\d{8}\.db$/.test(name)).sort().at(-1);
  if (!latest) throw new Error(`no snapshot in ${sqliteDir}`);
  return { name: latest, bytes: await readFile(join(sqliteDir, latest)) };
}

export async function exportBackup({ recipient, d1, sqliteDir, put, exportD1 = database => d1Export(database, process.env), now = Date.now() }) {
  if (!recipient?.startsWith('age1')) throw new Error('an age recipient (age1...) is required');
  if (!d1 === !sqliteDir) throw new Error('choose exactly one source: --d1 or --sqlite-dir');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const { name, bytes } = await readSource({ d1, sqliteDir, exportD1, now });
  const key = `mailstack/${name}.age`;
  await put(key, await encrypter.encrypt(bytes));
  return key;
}

export function b2Put({ B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY }) {
  if (!B2_ENDPOINT || !B2_BUCKET || !B2_KEY_ID || !B2_APP_KEY) throw new Error('B2_ENDPOINT, B2_BUCKET, B2_KEY_ID and B2_APP_KEY are required');
  const endpoint = new URL(B2_ENDPOINT);
  const client = new AwsClient({ accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY, service: 's3', region: endpoint.hostname.match(/^s3\.([\w-]+)\./)?.[1] ?? 'us-east-1' });
  return async (key, body) => {
    const response = await client.fetch(new URL(`/${B2_BUCKET}/${key}`, endpoint), { method: 'PUT', body, redirect: 'error' });
    if (!response.ok) throw new Error(`upload failed: HTTP ${response.status}`);
  };
}

// Without flags the source comes from the environment (Compose `backup.env`): BACKUP_SOURCE=d1 with BACKUP_D1_ID, or sqlite.
export function sourceFrom(values, env) {
  if (values.d1 || values['sqlite-dir']) return { d1: values.d1, sqliteDir: values['sqlite-dir'] };
  if (env.BACKUP_SOURCE === 'd1' && env.BACKUP_D1_ID) return { d1: env.BACKUP_D1_ID };
  if (env.BACKUP_SOURCE === 'sqlite') return { sqliteDir: env.BACKUP_SQLITE_DIR || '/data/backups' };
  throw new Error('set BACKUP_SOURCE to d1 (Worker, with BACKUP_D1_ID) or sqlite (Node)');
}

async function main() {
  const { values } = parseArgs({ options: { d1: { type: 'string' }, 'sqlite-dir': { type: 'string' } } });
  const source = sourceFrom(values, process.env), put = b2Put(process.env);
  const key = await exportBackup({ recipient: process.env.BACKUP_AGE_RECIPIENT, ...source, put });
  console.log(`uploaded ${key}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
