import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import type { OperationNode } from 'kysely';
import { authenticate } from '../clients';
import { appendAudit } from '../core/audit';
import { eventId } from '../core/store/events';
import type { KyselyStore } from '../core/store';
import type { Config } from '../core/config/schema';
import type { EmitEvent, Extension, ExtensionApp, ExtensionContext, ExtensionDatabase } from '../core/extensions';

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
async function bounded(task: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Extension timeout')), 5000);
    })]);
  } catch { console.error('mailstack: extension event failed'); }
  finally { clearTimeout(timer); }
}
export async function loadExtensions(config: Config, store: KyselyStore,
  importer: (module: string) => Promise<{ default?: unknown }> = module => import(module)) {
  const extensions: Extension[] = [], routes = new Map<string, Parameters<ExtensionApp['route']>[2]>();
  const ctx: ExtensionContext = { db: store.db as unknown as ExtensionDatabase, now: Date.now,
    appendAudit: entry => appendAudit(store, entry), config: { brands: Object.keys(config.brands), logging: structuredClone(config.logging) } };
  for (const [index, entry] of config.extensions.entries()) {
    try {
      const loaded = await importer(isAbsolute(entry.module) ? pathToFileURL(entry.module).href : entry.module);
      const extension: Extension = typeof loaded.default === 'function' ? await loaded.default(entry.options ?? {}) : loaded.default;
      if (!extension || typeof extension.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(extension.name) || extensions.some(e => e.name === extension.name)) throw new Error('Invalid extension');
      for (const key of ['migrate', 'routes', 'onEvent'] as const) if (extension[key] !== undefined && typeof extension[key] !== 'function') throw new Error('Invalid extension hook');
      const db = ctx.db.withPlugin({
        transformQuery({ node }) {
          if (!['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'SelectQueryNode'].includes(node.kind)) throw new Error('Unsupported migration');
          migrationNode(node, `ext_${extension.name}_`);
          if ('name' in node && node.name && 'name' in node.name && !String(node.name.name).startsWith(`ext_${extension.name}_`)) throw new Error('Invalid migration index');
          if (node.kind === 'DropIndexNode') throw new Error('Unsupported migration');
          return node;
        }, async transformResult({ result }) { return result; },
      });
      await extension.migrate?.(db);
      await extension.routes?.({ route(method, path, handler) {
        if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)) throw new Error('Invalid extension route');
        const key = `${method.toUpperCase()} /internal/ext/${extension.name}${path}`;
        if (routes.has(key)) throw new Error('Duplicate extension route');
        routes.set(key, handler);
      } });
      extensions.push(extension);
    } catch { throw new Error(`$.extensions.${index}.module: extension initialization failed`); }
  }
  const emitEvent: EmitEvent = (input, waitUntil) => {
    const { type, at, brand, template, status, ref, messageId } = input;
    const event = { id: eventId(at), type, at, brand, template, status, ...(ref === undefined ? {} : { ref }), ...(messageId === undefined ? {} : { messageId }) };
    const task = Promise.all(extensions.map(extension => bounded(() => extension.onEvent?.(structuredClone(event), ctx))));
    if (waitUntil) { try { waitUntil(task); } catch {} }
  };
  return { emitEvent, async fetch(req: Request, env: object): Promise<Response> {
    const client = await authenticate(req, env, config);
    if (!client) return Response.json({ success: false }, { status: 401 });
    if (!client.scopes.includes('panel') || !req.headers.get('x-panel-actor')?.trim()) return Response.json({ success: false }, { status: 403 });
    const handler = routes.get(`${req.method} ${new URL(req.url).pathname}`);
    return handler ? handler(req, ctx) : new Response(null, { status: 404 });
  } };
}
