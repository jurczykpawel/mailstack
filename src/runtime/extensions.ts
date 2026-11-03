import { readSesStatus } from '../core/store/ses-status';
import { createNtfyNotifier } from '../adapters/notify/ntfy';
import { createResendService } from '../core/resend';
import { verifyTurnstile } from '../turnstile';
import { verifyAltcha } from '../altcha';
import type { Env, SendDeps } from '../types';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { DummyDriver, isColumnDataType, isOperator, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { CompiledQuery, DatabaseConnection, OperationNode, TableNode } from 'kysely';
import { runRetention } from '../core/retention';
import { internalFetch } from '../core/internal';
import { authorizePanel } from '../core/panel';
import { requireKeyProvider, type KeyProvider } from '../clients';
import { appendAudit } from '../core/audit';
import { eventId } from '../core/store/events';
import type { KyselyStore } from '../core/store';
import type { Config } from '../core/config/schema';
import type { EmitEvent, Extension, ExtensionApp, ExtensionContext, ExtensionDatabase, BeforeMessageDelete } from '../core/extensions';

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
export async function loadExtensions(config: Config, store: KyselyStore,
  importer: (module: string) => Promise<{ default?: unknown }> = module => import(module),
  delivery?: Pick<SendDeps, 'sendEmail' | 'provider'>) {
  const extensions: Extension[] = [], routes = new Map<string, Parameters<ExtensionApp['route']>[2]>();
  const contexts = new Map<Extension, ExtensionContext>();
  const routeContexts = new Map<string, { db: ExtensionDatabase; resend: boolean }>();
  const ctx: ExtensionContext = { db: store.db as unknown as ExtensionDatabase, now: Date.now,
    appendAudit: entry => appendAudit(store, entry), config: { brands: Object.keys(config.brands), logging: structuredClone(config.logging) } };
  for (const [index, entry] of config.extensions.entries()) {
    try {
      const loaded = await importer(isAbsolute(entry.module) ? pathToFileURL(entry.module).href : entry.module);
      const extension: Extension = typeof loaded.default === 'function' ? await loaded.default(entry.options ?? {}) : loaded.default;
      if (!extension || typeof extension.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(extension.name) ||
        extensions.some(e => e.name === extension.name || e.name.startsWith(extension.name + '_') || extension.name.startsWith(e.name + '_'))) throw new Error('Invalid extension');
      if (extension.capabilities !== undefined && (!Array.isArray(extension.capabilities) || extension.capabilities.some(c => c !== 'resend'))) throw new Error('Invalid extension capability');
      for (const key of ['migrate', 'routes', 'onEvent', 'onBeforeDelete', 'keys'] as const) if (extension[key] !== undefined && typeof extension[key] !== 'function') throw new Error('Invalid extension hook');
      extensions.push(extension);
    } catch { throw new Error(`$.extensions.${index}.module: extension initialization failed`); }
  }
  const providers = extensions.filter(e => e.keys);
  if (providers.length > 1) throw new Error('$.extensions: only one extension may provide keys');
  let keys: KeyProvider | undefined;
  try { keys = await providers[0]?.keys!(config); }
  catch (error) { throw new Error(error instanceof Error && error.message.startsWith('$.') ? error.message : '$.clients: key provider initialization failed'); }
  requireKeyProvider(config, keys);
  for (const [index, extension] of extensions.entries()) {
    try {
      const prefix = `ext_${extension.name}_`;
      class ExtensionDriver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
          return {
            async executeQuery<R>(query: CompiledQuery) {
              const node = structuredClone(query.query);
              if (!['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'SelectQueryNode'].includes(node.kind)) throw new Error('Unsupported extension query');
              extensionNode(node, prefix);
              if ('name' in node && node.name && 'name' in node.name && !String(node.name.name).startsWith(prefix)) throw new Error('Invalid migration index');
              return store.db.executeQuery<R>(new SqliteQueryCompiler().compileQuery(node, query.queryId));
            },
            async *streamQuery() { throw new Error('Unsupported extension stream'); },
          };
        }
        override async beginTransaction() { throw new Error('Unsupported extension transaction'); }
      }
      const db: ExtensionDatabase = new Kysely({ dialect: {
        createDriver: () => new ExtensionDriver(), createAdapter: () => new SqliteAdapter(),
        createQueryCompiler: () => new SqliteQueryCompiler(), createIntrospector: db => new SqliteIntrospector(db),
      } });
      contexts.set(extension, { ...ctx, db });
      await extension.migrate?.(db);
      await extension.routes?.({ route(method, path, handler) {
        if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)) throw new Error('Invalid extension route');
        const key = `${method.toUpperCase()} /internal/ext/${extension.name}${path}`;
        if (routes.has(key)) throw new Error('Duplicate extension route');
        routes.set(key, handler);
        routeContexts.set(key, { db, resend: extension.capabilities?.includes('resend') ?? false });
      } });
    } catch { throw new Error(`$.extensions.${index}.module: extension initialization failed`); }
  }
  const emitEvent: EmitEvent = (input, waitUntil) => {
    const { type, at, brand, template, status, ref, messageId } = input;
    const event = { id: eventId(at), type, at, brand, template, status, messageId, ...(ref === undefined ? {} : { ref }) };
    const task = Promise.all(extensions.map(extension => bounded(() => extension.onEvent?.(structuredClone(event), contexts.get(extension)!))));
    if (waitUntil) { try { waitUntil(task); } catch {} }
  };
  const beforeDelete: BeforeMessageDelete = async selection => {
    for (const extension of extensions) if (extension.onBeforeDelete) {
      await bounded(() => extension.onBeforeDelete!(structuredClone(selection), contexts.get(extension)!), true);
    }
  };
  const service = (env: Env) => createResendService(config, store, env, { ...delivery!, keys, store, now: () => new Date(), logging: config.logging, notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, emitEvent, verifyTurnstile, verifyAltcha });
  const enabled = delivery && extensions.some(e => e.capabilities?.includes('resend'));
  const resendSource: SendDeps['resendSource'] = enabled ? (env, client, id, key, payload, ref, attachments, brandId) => service(env).sendSource(client, id, key, payload, ref, attachments, brandId) : undefined;
  return { emitEvent, resendSource, keys, runRetention: (now: number) => runRetention(store, now, config, beforeDelete), async fetch(req: Request, env: object): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith('/internal/v2/') && !pathname.startsWith('/internal/ext/')) return new Response(null, { status: 404 });
    const panel = await authorizePanel(req, env, config, { audience: String(Reflect.get(env, 'PANEL_AUDIENCE') ?? ''), store, keys });
    if (panel instanceof Response) return panel;
    if (pathname.startsWith('/internal/v2/')) return internalFetch(req, env, store, config, panel, beforeDelete);
    const key = `${req.method} ${pathname}`, handler = routes.get(key), route = routeContexts.get(key);
    return handler ? handler(req, { ...ctx, panel, db: route!.db,
      ...(panel.brands === '*' && panel.templates === '*' ? { sesStatus: () => readSesStatus(store, config.events?.ses, String(Reflect.get(env, 'SES_REGION') ?? 'eu-west-1')) } : {}),
      ...(enabled && route!.resend ? { resend: service(env as Env).forPanel(panel) } : {}) }) : new Response(null, { status: 404 });
  } };
}
