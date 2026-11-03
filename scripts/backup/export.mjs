// Daily encrypted copy outside the provider: D1 export or newest Node snapshot -> age -> B2 (S3 API).
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AwsClient } from 'aws4fetch';
import { Encrypter } from 'age-encryption';

export function runWrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed`);
  return result.stdout;
}

export async function withTempDir(use) {
  const dir = await mkdtemp(join(tmpdir(), 'mailstack-backup-'));
  try { return await use(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function readSource({ d1, sqliteDir, wrangler, now }) {
  if (d1) return withTempDir(async dir => {
    const output = join(dir, 'export.sql');
    wrangler(['d1', 'export', d1, '--remote', '--output', output, '--skip-confirmation']);
    return { name: `${d1}-${new Date(now).toISOString().replace(/[-:]|\.\d+/g, '')}.sql`, bytes: await readFile(output) };
  });
  const latest = (await readdir(sqliteDir)).filter(name => /^mailstack-\d{8}\.db$/.test(name)).sort().at(-1);
  if (!latest) throw new Error(`no snapshot in ${sqliteDir}`);
  return { name: latest, bytes: await readFile(join(sqliteDir, latest)) };
}

export async function exportBackup({ recipient, d1, sqliteDir, put, wrangler = runWrangler, now = Date.now() }) {
  if (!recipient?.startsWith('age1')) throw new Error('an age recipient (age1...) is required');
  if (!d1 === !sqliteDir) throw new Error('choose exactly one source: --d1 or --sqlite-dir');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const { name, bytes } = await readSource({ d1, sqliteDir, wrangler, now });
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

async function main() {
  const { values } = parseArgs({ options: { d1: { type: 'string' }, 'sqlite-dir': { type: 'string' } } });
  const put = b2Put(process.env);
  const key = await exportBackup({ recipient: process.env.BACKUP_AGE_RECIPIENT, d1: values.d1, sqliteDir: values['sqlite-dir'], put });
  console.log(`uploaded ${key}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
