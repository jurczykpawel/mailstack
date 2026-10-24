import Database from 'better-sqlite3';
import { SqliteDialect } from 'kysely';
import { KyselyStore } from './index';

export function createSqliteStore(filename: string): KyselyStore {
  return new KyselyStore(new SqliteDialect({ database: new Database(filename) }));
}
