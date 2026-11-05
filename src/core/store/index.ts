import { Kysely, sql } from 'kysely';
import type { Dialect } from 'kysely';
import type { Store } from '../ports';
import { EVENTS_SCHEMA, EXT_SCHEMA, INITIAL_SCHEMA, JOBS_SCHEMA, PARTIAL_INDEX_SCHEMA, READ_SCHEMA, SES_STATUS_SCHEMA, WITHOUT_ROWID_TABLES, withoutRowid } from './migration.ts';
import { MessageOperations } from './messages.ts';
import type { AtomicBatch, Database } from './messages.ts';

export class KyselyStore extends MessageOperations implements Store {

  constructor(dialect: Dialect, batch?: AtomicBatch) {
    super(new Kysely<Database>({ dialect }), batch);
  }

  async health(): Promise<void> { await sql`select 1`.execute(this.db); }

  async migrate(): Promise<void> {
    for (const statement of (INITIAL_SCHEMA + SES_STATUS_SCHEMA + JOBS_SCHEMA + EXT_SCHEMA + EVENTS_SCHEMA + PARTIAL_INDEX_SCHEMA).split(';').map(s => s.trim()).filter(Boolean)) {
      await sql.raw(statement).execute(this.db);
    }
    const columns = (await sql<{ name: string }>`pragma table_info(resend_jobs)`.execute(this.db)).rows;
    if (!columns.some(c => c.name === 'strategy') || !columns.some(c => c.name === 'payload_mac')) {
      const definition = INITIAL_SCHEMA.match(/CREATE TABLE IF NOT EXISTS resend_jobs \([\s\S]*?\);/)![0];
      const names = ['id', 'message_id', 'root', 'actor', 'token', 'strategy', 'payload_mac', 'state', 'created_at', 'expires_at', 'result_id'];
      const values = names.map(n => columns.some(c => c.name === n) ? n : n === 'strategy' ? "'replay'" : 'NULL');
      await this.batch([definition.replace('IF NOT EXISTS resend_jobs', 'resend_jobs_upgrade'),
        `INSERT INTO resend_jobs_upgrade (${names.join(',')}) SELECT ${values.join(',')} FROM resend_jobs`,
        'DROP TABLE resend_jobs', 'ALTER TABLE resend_jobs_upgrade RENAME TO resend_jobs',
        'CREATE INDEX resend_jobs_exp ON resend_jobs(expires_at)'].map(s => sql.raw(s).compile(this.db)));
    }
    if (!columns.some(c => c.name === 'error')) await sql`ALTER TABLE resend_jobs ADD COLUMN error TEXT`.execute(this.db);
    // Tables still stored with a rowid are rebuilt in one atomic batch (a failure leaves the old tables untouched).
    const pending = (await sql<{ name: string }>`select name from sqlite_master where type = 'table'
      and name in (${sql.join(WITHOUT_ROWID_TABLES)}) and sql not like '%WITHOUT ROWID'`.execute(this.db)).rows;
    if (pending.length) await this.batch(pending.flatMap(t => withoutRowid(t.name)).map(s => sql.raw(s).compile(this.db)));
    for (const statement of READ_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await sql.raw(statement).execute(this.db);
  }

  async consume(key: string, expiresAt: number): Promise<boolean> {
    const result = await this.db.insertInto('guards')
      .values({ key, count: 1, expires_at: expiresAt })
      .onConflict(c => c.column('key').doNothing()).executeTakeFirstOrThrow();
    return result.numInsertedOrUpdatedRows === 1n;
  }

  async release(key: string): Promise<void> {
    await this.db.deleteFrom('guards').where('key', '=', key).execute();
  }

  async increment(key: string, expiresAt: number): Promise<number> {
    const result = await this.db.insertInto('guards')
      .values({ key, count: 1, expires_at: expiresAt })
      .onConflict(c => c.column('key').doUpdateSet({ count: sql<number>`guards.count + 1` }))
      .returning('count').executeTakeFirstOrThrow();
    return result.count;
  }

  async purgeGuards(now: number): Promise<void> {
    await this.db.deleteFrom('guards').where('expires_at', '<=', now).execute();
  }
}
