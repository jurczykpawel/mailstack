import { Kysely, sql } from 'kysely';
import type { Dialect } from 'kysely';
import type { Store } from '../ports';
import { INITIAL_SCHEMA } from './migration';
import { MessageOperations } from './messages';
import type { AtomicBatch, Database } from './messages';

export class KyselyStore extends MessageOperations implements Store {

  constructor(dialect: Dialect, batch?: AtomicBatch) {
    super(new Kysely<Database>({ dialect }), batch);
  }

  async health(): Promise<void> { await sql`select 1`.execute(this.db); }

  async migrate(): Promise<void> {
    for (const statement of INITIAL_SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      await sql.raw(statement).execute(this.db);
    }
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
