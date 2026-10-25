import Database from 'better-sqlite3';
import { SqliteDialect } from 'kysely';
import { KyselyStore } from './index.ts';

export function createSqliteStore(filename: string | Database.Database): KyselyStore {
  return new KyselyStore(new SqliteDialect({ database: typeof filename === 'string' ? new Database(filename) : filename }));
}
