import { D1Dialect } from 'kysely-d1';
import { KyselyStore } from './index';
import { countOperation } from '../budget';

/** Every query and every batch counts once against the invocation's D1 limit (Free: 50, D1 limits). */
export function createD1Store(database: D1Database): KyselyStore {
  const counted = { prepare: (query: string) => ({ bind: (...values: unknown[]) => {
    const statement = database.prepare(query).bind(...values);
    return { all: () => { countOperation(); return statement.all(); } };
  } }) } as unknown as D1Database;
  return new KyselyStore(new D1Dialect({ database: counted }), async queries => {
    countOperation();
    const results = await database.batch(queries.map(q => database.prepare(q.sql).bind(...q.parameters)));
    if (results.some(r => !r.success)) throw new Error('Unable to write message');
    return results.map(result => result.meta.changes);
  });
}
