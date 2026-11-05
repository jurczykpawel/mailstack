import { CompiledQuery, DummyDriver, sql } from 'kysely';
import type { DatabaseConnection } from 'kysely';
import { KyselyStore } from '../src/core/store/index.ts';
import { applyMigrations, compileMigrations, sqliteDialect } from '../src/core/ext-migrations.ts';
import type { ExtensionMigration } from '../src/core/ext-migrations.ts';

type Result = { success: boolean; results?: unknown[]; meta: { changes: number } };
type Query = (text: string) => Promise<Result[]>;
export interface WorkerSchema {
  CACHE_SCHEMA: string;
  workerMigrations(options?: Record<string, unknown>): { name: string; migrations: ExtensionMigration[] };
}
const literal = (v: unknown): string => {
  if (v === null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return "'" + v.replaceAll("'", "''") + "'";
  throw new Error('Unsupported migration parameter');
};
/** Query text comes from the checked schema builders. Values are supplied as SQL literals to the deployment transport. */
const text = (q: CompiledQuery) => {
  let i = 0;
  const value = q.sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, part => part === '?' ? literal(q.parameters[i++]) : part);
  if (i !== q.parameters.length) throw new Error('Invalid migration parameters');
  return value;
};
/** D1's query endpoint executes a multi-statement request atomically; the ledger travels in that same request. */
export function remoteStore(query: Query): KyselyStore {
  const batch = async (queries: CompiledQuery[]) => {
    const results = await query(queries.map(text).join(';\n'));
    if (results.length !== queries.length || results.some(r => !r.success)) throw new Error('Schema migration failed');
    return results;
  };
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return { executeQuery: async <R>(q: CompiledQuery) => {
        const [r] = await batch([q]);
        return { rows: (r.results ?? []) as R[], numAffectedRows: BigInt(r.meta.changes) };
      }, async *streamQuery() { throw new Error('Unsupported migration stream'); } };
    }
  }
  return new KyselyStore(sqliteDialect(new Driver()), async queries => (await batch(queries)).map(r => r.meta.changes));
}
/** Node's core upgrade and the extension ledger, also used before either Worker deployment. No license or delivery setup. */
export async function migrateWorker(store: KyselyStore, pro?: WorkerSchema, options: Record<string, unknown> = {}) {
  await store.migrate();
  if (pro) {
    await sql.raw(pro.CACHE_SCHEMA).execute(store.db);
    const ext = pro.workerMigrations(options);
    await applyMigrations(store, await compileMigrations(ext.name, ext.migrations));
  }
}
