// Restores an age-encrypted copy into a NEW database only: a new SQLite file or an empty D1 database.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { Decrypter } from 'age-encryption';

// Restore runs on the owner's computer from a development checkout, where Wrangler is installed.
export function runWrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} failed`);
  return result.stdout;
}
async function withTempDir(use) {
  const dir = await mkdtemp(join(tmpdir(), 'mailstack-backup-'));
  try { return await use(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const TABLES_IN_USE = "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";

async function restoreSqlite(path, bytes, snapshot) {
  await writeFile(path, snapshot ? bytes : '', { flag: 'wx', mode: 0o600 });
  if (snapshot) return;
  const db = new Database(path);
  try { db.exec(bytes.toString('utf8')); db.close(); }
  catch (error) { db.close(); await rm(path, { force: true }); throw error; }
}

export async function restoreBackup({ input, identity, sqlite, d1, wrangler = runWrangler }) {
  if (!identity) throw new Error('an age identity is required');
  if (!sqlite === !d1) throw new Error('choose exactly one target: --sqlite or --d1');
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const bytes = Buffer.from(await decrypter.decrypt(input));
  const snapshot = bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
  if (sqlite) return restoreSqlite(sqlite, bytes, snapshot);
  if (snapshot) throw new Error('a SQLite snapshot can be restored only with --sqlite');
  const [{ results: [{ n }] }] = JSON.parse(wrangler(['d1', 'execute', d1, '--remote', '--json', '--command', TABLES_IN_USE]));
  if (n !== 0) throw new Error(`D1 database ${d1} is not empty`);
  await withTempDir(async dir => {
    const file = join(dir, 'restore.sql');
    await writeFile(file, bytes, { mode: 0o600 });
    wrangler(['d1', 'execute', d1, '--remote', '--file', file, '--yes']);
  });
}

async function main() {
  const { values, positionals: [file] } = parseArgs({ allowPositionals: true, options: { identity: { type: 'string' }, sqlite: { type: 'string' }, d1: { type: 'string' } } });
  if (!file || !values.identity) throw new Error('usage: restore.mjs <backup.age> --identity <age-key-file> (--sqlite <new-file> | --d1 <new-database>)');
  const identity = (await readFile(values.identity, 'utf8')).split('\n').find(line => line.startsWith('AGE-SECRET-KEY-'));
  await restoreBackup({ input: await readFile(file), identity, sqlite: values.sqlite, d1: values.d1 });
  console.log(`restored into ${values.sqlite ?? values.d1}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
