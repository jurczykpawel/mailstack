import { createNtfyNotifier } from '../adapters/notify/ntfy';
import { createResendService } from '../core/resend';
import { verifyTurnstile } from '../turnstile';
import { verifyAltcha } from '../altcha';
import type { Env, SendDeps } from '../types';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { CompiledQuery, DatabaseConnection, OperationNode } from 'kysely';
import { runRetention } from '../core/retention';
import { internalFetch } from '../core/internal';
import { verifyPanelAssertion } from '../core/panel';
import { authenticate } from '../clients';
import { appendAudit } from '../core/audit';
import { eventId } from '../core/store/events';
import type { KyselyStore } from '../core/store';
import type { Config } from '../core/config/schema';
import type { EmitEvent, Extension, ExtensionApp, ExtensionContext, ExtensionDatabase, BeforeMessageDelete } from '../core/extensions';

function migrationNode(node: OperationNode, prefix: string): void {
  const value = node as unknown as Record<string, unknown>;
  if (node.kind === 'RawNode') throw new Error('Unsupported migration statement');
  if (node.kind === 'IdentifierNode' && typeof value.name === 'string' && !/^[a-zA-Z0-9_]+$/.test(value.name)) throw new Error('Invalid migration identifier');
  if (node.kind === 'TableNode') {
    const table = value.table as { identifier: { name: string }; schema?: unknown };
    if (table.schema || !table.identifier.name.startsWith(prefix)) throw new Error('Invalid migration table');
  }
  for (const child of Object.values(value)) {
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item === 'object' && 'kind' in item) migrationNode(item as OperationNode, prefix);
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
      if (!extension || typeof extension.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(extension.name) || extensions.some(e => e.name === extension.name)) throw new Error('Invalid extension');
      if (extension.capabilities !== undefined && (!Array.isArray(extension.capabilities) || extension.capabilities.some(c => c !== 'resend'))) throw new Error('Invalid extension capability');
      for (const key of ['migrate', 'routes', 'onEvent', 'onBeforeDelete'] as const) if (extension[key] !== undefined && typeof extension[key] !== 'function') throw new Error('Invalid extension hook');
      const prefix = `ext_${extension.name}_`;
      class ExtensionDriver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
          return {
            async executeQuery<R>(query: CompiledQuery) {
              const node = structuredClone(query.query);
              if (!['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'SelectQueryNode'].includes(node.kind)) throw new Error('Unsupported extension query');
              migrationNode(node, prefix);
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
      extensions.push(extension);
    } catch { throw new Error(`$.extensions.${index}.module: extension initialization failed`); }
  }
  const emitEvent: EmitEvent = (input, waitUntil) => {
    const { type, at, brand, template, status, ref, messageId } = input;
    const event = { id: eventId(at), type, at, brand, template, status, ...(ref === undefined ? {} : { ref }), ...(messageId === undefined ? {} : { messageId }) };
    const task = Promise.all(extensions.map(extension => bounded(() => extension.onEvent?.(structuredClone(event), contexts.get(extension)!))));
    if (waitUntil) { try { waitUntil(task); } catch {} }
  };
  const beforeDelete: BeforeMessageDelete = async selection => {
    for (const extension of extensions) if (extension.onBeforeDelete) {
      await bounded(() => extension.onBeforeDelete!(structuredClone(selection), contexts.get(extension)!), true);
    }
  };
  const service = (env: Env) => createResendService(config, store, env, { ...delivery!, store, now: () => new Date(), logging: config.logging, notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, emitEvent, verifyTurnstile, verifyAltcha });
  const enabled = delivery && extensions.some(e => e.capabilities?.includes('resend'));
  const resendSource: SendDeps['resendSource'] = enabled ? (env, client, id, key, payload, ref, attachments, brandId) => service(env).sendSource(client, id, key, payload, ref, attachments, brandId) : undefined;
  return { emitEvent, resendSource, runRetention: (now: number) => runRetention(store, now, config, beforeDelete), async fetch(req: Request, env: object): Promise<Response> {
    const client = await authenticate(req, env, config);
    if (!client) return Response.json({ success: false }, { status: 401 });
    if (!client.scopes.includes('panel')) return Response.json({ success: false }, { status: 403 });
    const claims = await verifyPanelAssertion(req, env);
    if (!claims) return Response.json({ success: false }, { status: 403 });
    const panel = { ...claims, scopes: client.scopes, brands: client.brands, templates: client.templates };
    if (new URL(req.url).pathname.startsWith('/internal/v1/')) return internalFetch(req, env, store, config, panel, beforeDelete);
    const key = `${req.method} ${new URL(req.url).pathname}`, handler = routes.get(key), route = routeContexts.get(key);
    return handler ? handler(req, { ...ctx, panel, db: route!.db,
      ...(enabled && route!.resend ? { resend: service(env as Env).forPanel(panel) } : {}) }) : new Response(null, { status: 404 });
  } };
}
