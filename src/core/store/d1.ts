import { D1Dialect } from 'kysely-d1';
import { KyselyStore } from './index';

export function createD1Store(database: D1Database): KyselyStore {
  const store = new KyselyStore(new D1Dialect({ database }), async (queries) => {
    const results = await database.batch(queries.map(query => {
      const compiled = query.compile(store.db);
      return database.prepare(compiled.sql).bind(...compiled.parameters);
    }));
    return results.map(result => result.meta.changes);
  });
  return store;
}
