import { CompiledQuery, DummyDriver, isColumnDataType, isOperator, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import type { DatabaseConnection, Dialect, Driver, OperationNode, RootOperationNode, TableNode } from 'kysely';
import type { KyselyStore } from './store';
import type { Job, Step } from './jobs';

const extensionNodes = new Set(`Identifier SchemableIdentifier SelectQuery Selection Reference Column Table Alias From SelectAll
  And Or Parens Value ValueList PrimitiveValueList Join Operator Where InsertQuery DeleteQuery Returning CreateTable
  ColumnDefinition AddColumn DropTable DataType OrderBy OrderByItem GroupBy GroupByItem UpdateQuery ColumnUpdate Limit
  Offset OnConflict CreateIndex List References PrimaryKeyConstraint UniqueConstraint CheckConstraint ForeignKeyConstraint
  With CommonTableExpression Having AlterTable ModifyColumn DropColumn RenameColumn AlterColumn AddConstraint DropConstraint
  Generated DefaultValue On Values CommonTableExpressionName SelectModifier DefaultInsertValue AggregateFunction Over
  PartitionBy PartitionByItem SetOperation BinaryOperation UnaryOperation Using Function Case When Tuple Cast OrAction Collate`
  .split(/\s+/).map(name => name + 'Node'));
const extensionFunctions = new Set(`abs avg coalesce count group_concat hex ifnull length lower ltrim max min nullif
  replace round rtrim substr substring sum total trim typeof upper json json_array json_object json_extract json_type
  json_valid json_quote json_set json_insert json_replace json_remove json_group_array json_group_object json_each`.split(/\s+/));
function extensionToken(kind: string, key: string, value: string): boolean {
  if (kind === 'IdentifierNode' && key === 'name') return /^[a-zA-Z0-9_]+$/.test(value);
  if (['FunctionNode', 'AggregateFunctionNode'].includes(kind) && key === 'func') return extensionFunctions.has(value);
  if (kind === 'DataTypeNode' && key === 'dataType') return !!isColumnDataType(value);
  if (kind === 'OperatorNode' && key === 'operator') return isOperator(value);
  if (['ReferencesNode', 'ForeignKeyConstraintNode'].includes(kind) && ['onDelete', 'onUpdate'].includes(key))
    return ['no action', 'restrict', 'cascade', 'set null', 'set default'].includes(value);
  if (kind === 'CreateTableNode' && key === 'onCommit') return ['preserve rows', 'delete rows', 'drop'].includes(value);
  if (kind === 'OrderByItemNode' && key === 'nulls') return ['first', 'last'].includes(value);
  if (kind === 'JoinNode' && key === 'joinType') return ['InnerJoin', 'LeftJoin', 'RightJoin', 'FullJoin', 'CrossJoin'].includes(value);
  if (kind === 'SetOperationNode' && key === 'operator') return ['union', 'intersect', 'except'].includes(value);
  if (kind === 'OrActionNode' && key === 'action') return ['abort', 'fail', 'ignore', 'replace', 'rollback'].includes(value);
  if (kind === 'DropConstraintNode' && key === 'modifier') return ['cascade', 'restrict'].includes(value);
  if (kind === 'SelectModifierNode' && key === 'modifier') return value === 'Distinct';
  return false;
}
function extensionRelation(node: unknown): void {
  const value = node as { kind?: string; node?: unknown } | undefined;
  if (value?.kind === 'AliasNode') return extensionRelation(value.node);
  // `json_each(?)` passes an id list as one parameter (D1: 100 per statement, A 3.5.4).
  if (value?.kind === 'FunctionNode' && (value as { func?: unknown }).func === 'json_each') return;
  if (value?.kind !== 'TableNode' && value?.kind !== 'SelectQueryNode') throw new Error('Unsupported extension relation');
}
function extensionNode(node: OperationNode, prefix: string): void {
  const value = node as unknown as Record<string, unknown>;
  if (!extensionNodes.has(node.kind)) throw new Error('Unsupported extension statement');
  if (node.kind === 'ValueNode' || node.kind === 'PrimitiveValueListNode') return;
  if (node.kind === 'TableNode') {
    const table = (node as TableNode).table;
    if (table?.kind !== 'SchemableIdentifierNode' || table.identifier?.kind !== 'IdentifierNode') throw new Error('Unsupported extension table');
    if (table.schema || typeof table.identifier.name !== 'string' || !table.identifier.name.startsWith(prefix)) throw new Error('Invalid migration table');
  }
  if (node.kind === 'FromNode' || node.kind === 'UsingNode') {
    for (const table of (value.froms ?? value.tables) as unknown[]) extensionRelation(table);
  }
  for (const key of ['table', 'into', 'renameTo']) {
    if (value[key] && ['InsertQueryNode', 'UpdateQueryNode', 'JoinNode', 'ReferencesNode', 'CreateTableNode',
      'AlterTableNode', 'DropTableNode', 'CreateIndexNode'].includes(node.kind)) extensionRelation(value[key]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'kind') continue;
    for (const item of Array.isArray(child) ? child : [child]) {
      if (typeof item === 'string' && !extensionToken(node.kind, key, item)) throw new Error('Unsupported extension token');
      if (item && typeof item === 'object') {
        if (!('kind' in item)) throw new Error('Unsupported extension field');
        extensionNode(item as OperationNode, prefix);
      }
    }
  }
}
const statements = ['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'SelectQueryNode'];
/** Validates one statement against the extension prefix and recompiles it from the checked tree. */
export function sandboxed(query: CompiledQuery, prefix: string): CompiledQuery {
  const node = structuredClone(query.query) as RootOperationNode;
  if (!statements.includes(node.kind)) throw new Error('Unsupported extension query');
  extensionNode(node, prefix);
  if ('name' in node && node.name && 'name' in node.name && !String(node.name.name).startsWith(prefix)) throw new Error('Invalid migration index');
  return new SqliteQueryCompiler().compileQuery(node, query.queryId);
}
export const sqliteDialect = (driver: Driver): Dialect => ({ createDriver: () => driver, createAdapter: () => new SqliteAdapter(),
  createQueryCompiler: () => new SqliteQueryCompiler(), createIntrospector: db => new SqliteIntrospector(db) });

/** Written with the Kysely schema builder; `up` runs on a recording driver, never on the database. */
export interface ExtensionMigration { version: number; name: string; up(db: Kysely<Record<string, Record<string, unknown>>>): Promise<void> | void }
export interface CompiledMigration { extension: string; version: number; name: string; checksum: string; file: string; statements: string[] }
export type ReconcileStep = { cursor: string } | { done: true };

export async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const ddl = ['CreateTableNode', 'AlterTableNode', 'CreateIndexNode', 'DropTableNode'];
/** One schema statement per node, checked like every sandboxed query, without parameters (a file cannot bind them). */
function ddlStatement(query: CompiledQuery, prefix: string): string {
  const node = query.query as RootOperationNode & { columnAlterations?: unknown[] };
  if (!ddl.includes(node.kind) || query.parameters.length || (node.columnAlterations?.length ?? 0) > 1) throw new Error('Unsupported extension migration');
  return sandboxed(query, prefix).sql;
}

/** The manifest: compiled SQL and SHA-256 per migration. Any invalid statement refuses all of them (setup and host). */
export async function compileMigrations(extension: string, migrations: unknown = []): Promise<CompiledMigration[]> {
  if (!Array.isArray(migrations)) throw new Error('Invalid extension migrations');
  const compiled: CompiledMigration[] = [];
  for (const { version, name, up } of migrations as ExtensionMigration[]) {
    if (!Number.isSafeInteger(version) || version < 1 || version > 8999 || version <= (compiled.at(-1)?.version ?? 0)
      || typeof name !== 'string' || !/^[a-z0-9_]{1,40}$/.test(name) || typeof up !== 'function') throw new Error('Invalid extension migration');
    const statements: string[] = [];
    class Recorder extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        return { executeQuery: async query => { statements.push(ddlStatement(query, `ext_${extension}_`)); return { rows: [] }; },
          async *streamQuery() { throw new Error('Unsupported extension stream'); } };
      }
      override async beginTransaction() { throw new Error('Unsupported extension transaction'); }
    }
    await up(new Kysely({ dialect: sqliteDialect(new Recorder()) }));
    if (!statements.length) throw new Error('Empty extension migration');
    const checksum = await sha256Hex(statements.join(';\n'));
    compiled.push({ extension, version, name, checksum, file: `${1000 + version}_ext_${extension}_${version}.sql`, statements });
  }
  return compiled;
}

/** The ledger row is the last statement of the same migration (Node: one transaction; D1: one migration file). */
export function migrationQueries(m: CompiledMigration): CompiledQuery[] {
  return [...m.statements, `insert into ext_migrations(extension, version, name, checksum)
    values ('${m.extension}', ${m.version}, '${m.name}', '${m.checksum}')`].map(s => CompiledQuery.raw(s));
}
export const migrationFile = (m: CompiledMigration) => migrationQueries(m).map(q => q.sql + ';\n').join('');

/** Node applies every manifest migration missing from the ledger, each atomically with its ledger row. */
export async function applyMigrations(store: KyselyStore, manifest: CompiledMigration[]): Promise<void> {
  const applied = new Set((await ledger(store, manifest[0]?.extension ?? '')).map(r => r.version));
  for (const m of manifest) if (!applied.has(m.version)) await store.batch(migrationQueries(m));
}
const ledger = (store: KyselyStore, extension: string) => sql<{ version: number; checksum: string }>`select version, checksum
  from ext_migrations where extension = ${extension}`.execute(store.db).then(r => r.rows);

/** Every manifest migration in the ledger with an equal checksum; newer ledger rows (expand-only) are allowed. */
export async function schemaReady(store: KyselyStore, manifest: CompiledMigration[]): Promise<boolean> {
  if (!manifest.length) return true;
  const rows = new Map((await ledger(store, manifest[0].extension)).map(r => [Number(r.version), r.checksum]));
  const newest = manifest.at(-1)!.version;
  return manifest.every(m => rows.get(m.version) === m.checksum) && [...rows.keys()].every(v => v > newest || manifest.some(m => m.version === v));
}

type Reconciler = { configSha: string; run(cursor: string | null): Promise<ReconcileStep> };
/** Reconcile handlers of the extension host in this process or isolate, by extension name. */
export const reconcilers = new Map<string, Reconciler>();

/** A new configuration starts a new generation; the job commits with it. An unfinished generation without a job gets one. */
export async function startReconcile(store: KyselyStore, extension: string, configSha: string, now: number): Promise<void> {
  const { enqueueJob } = await import('./jobs');
  const [row] = (await sql<{ config_sha: string; generation: number; done_at: number | null }>`select config_sha, generation, done_at
    from ext_reconcile where extension = ${extension}`.execute(store.db)).rows;
  if (row?.config_sha === configSha) {
    const live = await sql`select 1 from jobs where kind = 'ext.reconcile' and state in ('pending','running')
      and json_extract(payload, '$.extension') = ${extension}`.execute(store.db);
    if (row.done_at != null || live.rows.length) return;
    return void await store.batch([enqueueJob(store, 'ext.reconcile', { extension, generation: row.generation }, now).query]);
  }
  const previous = row?.generation ?? 0, generation = previous + 1;
  await store.batch([sql`insert into ext_reconcile(extension, config_sha, generation) values (${extension}, ${configSha}, ${generation})
    on conflict(extension) do update set config_sha = excluded.config_sha, generation = excluded.generation, cursor = null, done_at = null
    where ext_reconcile.generation = ${previous}`.compile(store.db), enqueueJob(store, 'ext.reconcile', { extension, generation }, now).query]);
}

export async function reconcileDone(store: KyselyStore, extension: string, configSha: string): Promise<boolean> {
  const { rows } = await sql`select 1 from ext_reconcile where extension = ${extension} and config_sha = ${configSha} and done_at is not null`.execute(store.db);
  return rows.length > 0;
}

/** Job step: progress and completion are written only while the job's generation is current (N6). */
export async function reconcileStep(job: Job, { store, now }: { store: KyselyStore; now: number }): Promise<Step> {
  const { extension, generation } = job.payload as { extension: string; generation: number };
  const [row] = (await sql<{ config_sha: string; generation: number }>`select config_sha, generation from ext_reconcile
    where extension = ${extension}`.execute(store.db)).rows;
  if (row?.generation !== generation) return { result: { superseded: true } };
  const reconciler = reconcilers.get(extension);
  // Another isolate or process with this configuration finishes the job; this one retries later.
  if (reconciler?.configSha !== row.config_sha) throw new Error('Reconcile configuration not loaded');
  const step = await reconciler.run(job.cursor);
  const current = sql`extension = ${extension} and generation = ${generation}`;
  if ('done' in step && step.done === true) return { result: { done: true }, writes: [sql`update ext_reconcile set cursor = null, done_at = ${now} where ${current}`.compile(store.db)] };
  if (!('cursor' in step) || typeof step.cursor !== 'string') throw new Error('Invalid reconcile step');
  return { cursor: step.cursor, writes: [sql`update ext_reconcile set cursor = ${step.cursor} where ${current}`.compile(store.db)] };
}
