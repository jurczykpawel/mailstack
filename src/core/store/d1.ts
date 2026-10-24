import { D1Dialect } from 'kysely-d1';
import { KyselyStore } from './index';

export function createD1Store(database: D1Database): KyselyStore {
  return new KyselyStore(new D1Dialect({ database }), async queries => {
    const results = await database.batch(queries.map(q => database.prepare(q.sql).bind(...q.parameters)));
    if (results.some(r => !r.success)) throw new Error('Unable to write message');
    return results.map(result => result.meta.changes);
  });
}
