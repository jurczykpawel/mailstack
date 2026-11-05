import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrateWorker, remoteStore } from '../scripts/worker-schema.ts';
import { createSqliteStore } from '../src/core/store/sqlite';
import { readFileSync } from 'node:fs';
import type { ExtensionMigration } from '../src/core/ext-migrations';

const migrations: ExtensionMigration[] = [{ version: 1, name: 'callbacks', up: async db => {
  await db.schema.createTable('ext_pro_callbacks').ifNotExists().addColumn('id', 'text', c => c.primaryKey()).execute();
} }, { version: 2, name: 'request_key', up: async db => {
  await db.schema.alterTable('ext_pro_callbacks').addColumn('request_key', 'text').execute();
  await db.schema.createIndex('ext_pro_request_key').ifNotExists().on('ext_pro_callbacks').column('request_key').execute();
} }];
const snapshot = (db: Database.Database) => db.prepare("select type,name,sql from sqlite_master where name not like 'sqlite_%' order by type,name").all().map(row => {
  const r = row as { type: string; name: string; sql: string };
  return { ...r, sql: r.sql.toLowerCase().replaceAll('"', '').replace(/\s+/g, '') };
});

it.each([false, true])('upgrades a partial database and adopts existing columns: %s', async hasColumn => {
  const db = new Database(':memory:'), fresh = new Database(':memory:');
  const query = (db: Database.Database) => async (text: string) => {
    const parts = text.split(';').map(s => s.trim()).filter(Boolean);
    return db.transaction(() => parts.map(s => {
      const stmt = db.prepare(s);
      return stmt.reader ? { success: true, results: stmt.all(), meta: { changes: 0 } } : { success: true, results: [], meta: { changes: stmt.run().changes } };
    }))();
  };
  const pro = { CACHE_SCHEMA: 'create table if not exists pro_license_cache(id text primary key,json text not null)', workerMigrations: () => ({ name: 'pro', migrations }) };
  const store = remoteStore(query(db)), other = createSqliteStore(fresh);
  try {
    db.exec(readFileSync('test/fixtures/schema-initial.sql', 'utf8'));
    db.exec(`create table ext_pro_callbacks(id text primary key${hasColumn ? ',request_key text' : ''}); insert into ext_pro_callbacks(id) values('demo')`);
    if (hasColumn) db.exec("update ext_pro_callbacks set request_key='saved'");
    db.exec("insert into resend_jobs(id,message_id,root,actor,token,state,created_at,expires_at) values('demo','msg','msg','demo','token','pending',1,2)");
    db.exec('drop table contents');
    await migrateWorker(store, pro);
    await migrateWorker(other, pro);
    expect(snapshot(db)).toEqual(snapshot(fresh));
    expect(db.prepare('select strategy,payload_mac from resend_jobs').get()).toEqual({ strategy: 'replay', payload_mac: null });
    expect(db.prepare('select * from ext_pro_callbacks').get()).toEqual({ id: 'demo', request_key: hasColumn ? 'saved' : null });
    const before = snapshot(db);
    await migrateWorker(store, pro);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('pragma quick_check').get()).toEqual({ quick_check: 'ok' });
  } finally { await store.db.destroy(); await other.db.destroy(); db.close(); }
});
