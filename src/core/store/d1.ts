import { D1Dialect } from 'kysely-d1';
import { KyselyStore } from './index';

export function createD1Store(database: D1Database): KyselyStore {
  return new KyselyStore(new D1Dialect({ database }));
}
