import { Kysely, sql } from 'kysely';
import type { RawBuilder, Dialect } from 'kysely';
import type { Store } from '../ports';
import { INITIAL_SCHEMA } from './migration';

interface Database {
  guards: { key: string; count: number; expires_at: number };
}

export class KyselyStore implements Store {
  readonly db: Kysely<Database>;

  constructor(dialect: Dialect, private readonly atomic?: (queries: RawBuilder<unknown>[]) => Promise<number[]>) {
    this.db = new Kysely<Database>({ dialect });
  }

  async batch(queries: RawBuilder<unknown>[]): Promise<number[]> {
    if (this.atomic) return this.atomic(queries);
    return this.db.transaction().execute(async (tx) => {
      const changes: number[] = [];
      for (const query of queries) changes.push(Number((await query.execute(tx)).numAffectedRows ?? 0));
      return changes;
    });
  }

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
