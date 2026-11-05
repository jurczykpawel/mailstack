import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { createSqliteStore } from '../src/core/store/sqlite';

const dir = '.wrangler/migrations/';
const files = () => readdirSync(dir).filter(f => /^00\d\d_/.test(f) && !f.startsWith('0003_')).sort();
const schema = (db: Database.Database) => db.prepare("select type,name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all();

it('generates the same core schema for sequential D1 migrations and Node startup', async () => {
  const d1 = new Database(':memory:'), node = new Database(':memory:'), store = createSqliteStore(node);
  try {
    expect(files().at(-1)).toBe('0010_resend_result.sql');
    for (const file of files()) d1.exec(readFileSync(dir + file, 'utf8'));
    await store.migrate();
    expect(schema(d1)).toEqual(schema(node));
    expect(d1.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  } finally { d1.close(); await store.db.destroy(); }
});

it('upgrades existing jobs without a register, preserves rows and permits a repeated application', () => {
  const db = new Database(':memory:');
  try {
    for (const file of files().filter(f => !f.startsWith('0009_'))) db.exec(readFileSync(dir + file, 'utf8'));
    db.exec("drop table erasure_registry; insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at) values('demo','demo','acme','notice','meta','h','sent',1,9)");
    const before = db.prepare('select * from messages').all(), upgrade = readFileSync(dir + '0009_read_schema.sql', 'utf8');
    for (let i = 0; i < 2; i++) {
      db.exec(upgrade);
      expect(db.prepare('select * from messages').all()).toEqual(before);
      expect(db.prepare('select * from erasure_registry').all()).toEqual([]);
    }
  } finally { db.close(); }
});
