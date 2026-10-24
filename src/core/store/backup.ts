import type Database from 'better-sqlite3';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function backupSqlite(db: Database.Database, dir: string, now: number, keep = 7): Promise<string> {
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isFinite(now)) throw new Error('Invalid backup options');
  const name = `mailstack-${new Date(now).toISOString().slice(0, 10).replaceAll('-', '')}.db`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${name}.${crypto.randomUUID()}.tmp`);
  const target = join(dir, name);
  try { await db.backup(temporary); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  const names = (await readdir(dir)).filter(value => /^mailstack-\d{8}\.db$/.test(value)).sort().reverse();
  for (const expired of names.slice(keep)) await rm(join(dir, expired));
  return target;
}
