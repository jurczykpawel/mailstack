import { readSesStatus } from './store/ses-status';
import { createNtfyNotifier } from '../adapters/notify/ntfy';
import { createResendService } from './resend';
import { verifyTurnstile } from '../turnstile';
import { verifyAltcha } from '../altcha';
import type { Env, SendDeps } from '../types';
import { DummyDriver, isColumnDataType, isOperator, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { CompiledQuery, DatabaseConnection, OperationNode, RootOperationNode, TableNode } from 'kysely';
import { runRetention } from './retention';
import type { PanelPrincipal } from './panel';
import { requireKeyProvider, type KeyProvider } from '../clients';
import { appendAudit } from './audit';
import { eventId } from './store/events';
import type { KyselyStore } from './store';
import type { Config } from './config/schema';
import type { EmitEvent, Extension, ExtensionApp, ExtensionContext, ExtensionDatabase, BeforeMessageDelete } from './extensions';

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
  json_valid json_quote json_set json_insert json_replace json_remove json_group_array json_group_object`.split(/\s+/));
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
async function bounded(task: () => unknown, required = false): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Extension timeout')), 5000);
    })]);
  } catch {
    if (required) throw new Error('Extension cleanup failed');
    console.error('mailstack: extension event failed');
  }
  finally { clearTimeout(timer); }
}
const statements = ['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'SelectQueryNode'];
/** Validates one statement against the extension prefix and recompiles it from the checked tree. */
function sandboxed(query: CompiledQuery, prefix: string): CompiledQuery {
  const node = structuredClone(query.query) as RootOperationNode;
  if (!statements.includes(node.kind)) throw new Error('Unsupported extension query');
  extensionNode(node, prefix);
  if ('name' in node && node.name && 'name' in node.name && !String(node.name.name).startsWith(prefix)) throw new Error('Invalid migration index');
  return new SqliteQueryCompiler().compileQuery(node, query.queryId);
}
/** Kysely limited to `ext_<name>_*`; `batch` checks every element before one atomic store batch. */
function extensionDb(store: KyselyStore, prefix: string): ExtensionDatabase {
  class ExtensionDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: <R>(query: CompiledQuery) => store.db.executeQuery<R>(sandboxed(query, prefix)),
        async *streamQuery() { throw new Error('Unsupported extension stream'); },
      };
    }
    override async beginTransaction() { throw new Error('Unsupported extension transaction'); }
  }
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: {
    createDriver: () => new ExtensionDriver(), createAdapter: () => new SqliteAdapter(),
    createQueryCompiler: () => new SqliteQueryCompiler(), createIntrospector: db => new SqliteIntrospector(db),
  } });
  return Object.assign(db, { batch: async (queries: { compile(): CompiledQuery }[]) => store.batch(queries.map(q => sandboxed(q.compile(), prefix))) });
}
type Route = { handler: Parameters<ExtensionApp['route']>[2]; db: ExtensionDatabase; resend: boolean };
export type ExtensionFeature = { module: string; state: 'ready'; name: string; capabilities: string[] } | { module: string; state: 'unavailable'; reason: 'initialization' };
export type ExtensionHost = Awaited<ReturnType<typeof createExtensionHost>>;
/**
 * Runtime-neutral extension host. `importer` is the only host-specific part (Node: dynamic import, Worker: static
 * `pro.generated.ts`). An import or initialization failure leaves that extension `unavailable`; sending and the
 * full key keep working. With `options.keys` present the runtime supplies keys and extension `keys` hooks are skipped.
 */
export async function createExtensionHost(config: Config, store: KyselyStore,
  importer: (module: string) => Promise<{ default?: unknown }>,
  options: { delivery?: Pick<SendDeps, 'sendEmail' | 'provider'>; keys?: KeyProvider } = {}) {
  const extensions: Extension[] = [], routes = new Map<string, Route>(), contexts = new Map<Extension, ExtensionContext>();
  const features: ExtensionFeature[] = [];
  const ctx: Omit<ExtensionContext, 'db'> = { now: Date.now,
    appendAudit: entry => appendAudit(store, entry), config: { brands: Object.keys(config.brands), logging: structuredClone(config.logging) } };
  const unavailable = (index: number) => {
    console.error(`mailstack: $.extensions.${index}.module: extension initialization failed`);
    features.push({ module: config.extensions[index].module, state: 'unavailable', reason: 'initialization' });
  };
  const loaded: [number, Extension][] = [], names: string[] = [];
  for (const [index, entry] of config.extensions.entries()) {
    try {
      const module = await importer(entry.module);
      const extension: Extension = typeof module.default === 'function' ? await module.default(entry.options ?? {}) : module.default;
      if (!extension || typeof extension.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(extension.name)) throw new Error('Invalid extension');
      // Overlapping names share a table prefix: every extension involved becomes unavailable.
      const overlaps = (name: string) => name === extension.name || name.startsWith(extension.name + '_') || extension.name.startsWith(name + '_');
      const clash = names.some(overlaps); names.push(extension.name);
      if (clash) {
        for (const item of loaded.filter(([, e]) => overlaps(e.name))) { loaded.splice(loaded.indexOf(item), 1); unavailable(item[0]); }
        throw new Error('Overlapping extension');
      }
      if (extension.capabilities !== undefined && (!Array.isArray(extension.capabilities) || extension.capabilities.some(c => c !== 'resend'))) throw new Error('Invalid extension capability');
      for (const key of ['migrate', 'routes', 'onEvent', 'onBeforeDelete', 'keys'] as const) if (extension[key] !== undefined && typeof extension[key] !== 'function') throw new Error('Invalid extension hook');
      loaded.push([index, extension]);
    } catch { unavailable(index); }
  }
  let keys = options.keys;
  if (!('keys' in options)) {
    const providers = loaded.filter(([, e]) => e.keys);
    if (providers.length > 1) throw new Error('$.extensions: only one extension may provide keys');
    try { keys = await providers[0]?.[1].keys!(config); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('$.')) throw error;
      loaded.splice(loaded.indexOf(providers[0]), 1); unavailable(providers[0][0]);
    }
    // A failed extension may have been the key provider; only the full key remains then (N7).
    if (!features.length) requireKeyProvider(config, keys);
  }
  for (const [index, extension] of loaded) {
    try {
      const db = extensionDb(store, `ext_${extension.name}_`), own = new Map<string, Route>();
      await extension.migrate?.(db);
      await extension.routes?.({ route(method, path, handler) {
        if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)) throw new Error('Invalid extension route');
        const key = `${method.toUpperCase()} /internal/ext/${extension.name}${path}`;
        if (routes.has(key) || own.has(key)) throw new Error('Duplicate extension route');
        own.set(key, { handler, db, resend: extension.capabilities?.includes('resend') ?? false });
      } });
      for (const [key, route] of own) routes.set(key, route);
      contexts.set(extension, { ...ctx, db }); extensions.push(extension);
      features.push({ module: config.extensions[index].module, state: 'ready', name: extension.name, capabilities: [...extension.capabilities ?? []] });
    } catch { unavailable(index); }
  }
  const emitEvent = (input: Parameters<EmitEvent>[0], waitUntil?: Parameters<EmitEvent>[1]) => {
    const { type, at, brand, template, status, ref, messageId } = input;
    const event = { id: eventId(at), type, at, brand, template, status, messageId, ...(ref === undefined ? {} : { ref }) };
    const task = Promise.all(extensions.map(extension => bounded(() => extension.onEvent?.(structuredClone(event), contexts.get(extension)!))));
    if (waitUntil) { try { waitUntil(task); } catch {} }
    return task;
  };
  const beforeDelete: BeforeMessageDelete = async selection => {
    for (const extension of extensions) if (extension.onBeforeDelete) {
      await bounded(() => extension.onBeforeDelete!(structuredClone(selection), contexts.get(extension)!), true);
    }
  };
  const { delivery } = options;
  const service = (env: Env) => createResendService(config, store, env, { ...delivery!, keys, store, now: () => new Date(), logging: config.logging, notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, emitEvent, verifyTurnstile, verifyAltcha });
  const enabled = delivery && extensions.some(e => e.capabilities?.includes('resend'));
  const resendSource: SendDeps['resendSource'] = enabled ? (env, client, id, key, payload, ref, attachments, brandId) => service(env).sendSource(client, id, key, payload, ref, attachments, brandId) : undefined;
  return { emitEvent, resendSource, keys, beforeDelete, features: () => structuredClone(features),
    runRetention: (now: number) => runRetention(store, now, config, beforeDelete),
    /** Dispatches `/internal/ext/*` after the caller's panel gate; unknown routes are 404. */
    async route(req: Request, env: object, panel: PanelPrincipal): Promise<Response> {
      const route = routes.get(`${req.method} ${new URL(req.url).pathname}`);
      return route ? route.handler(req, { ...ctx, panel, db: route.db,
        ...(panel.brands === '*' && panel.templates === '*' ? { sesStatus: () => readSesStatus(store, config.events?.ses, String(Reflect.get(env, 'SES_REGION') ?? 'eu-west-1')) } : {}),
        ...(enabled && route.resend ? { resend: service(env as Env).forPanel(panel) } : {}) }) : new Response(null, { status: 404 });
    } };
}
