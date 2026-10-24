import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupSqlite } from '../src/core/store/backup';

it('creates consistent daily snapshots and keeps seven matching files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailstack-backup-'));
  const db = new Database(join(dir, 'source.db'));
  try {
    db.exec('create table sample (value integer); insert into sample values (7)');
    await writeFile(join(dir, 'keep.db'), 'unrelated');
    for (let day = 1; day <= 9; day++) await backupSqlite(db, dir, Date.UTC(2026, 9, day));
    await backupSqlite(db, dir, Date.UTC(2026, 9, 9));
    expect((await readdir(dir)).filter(n => /^mailstack-/.test(n)).sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `mailstack-2026100${i + 3}.db`));
    const copy = new Database(join(dir, 'mailstack-20261009.db'), { readonly: true });
    try { expect(copy.prepare('select value from sample').get()).toEqual({ value: 7 }); }
    finally { copy.close(); }
    expect(await readdir(dir)).toContain('keep.db');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
