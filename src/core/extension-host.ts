import { readSesStatus } from './store/ses-status';
import { createNtfyNotifier } from '../adapters/notify/ntfy';
import { createResendService } from './resend';
import { transitAudience } from './capabilities';
import { handleSend } from '../send';
import { verifyTurnstile } from '../turnstile';
import { verifyAltcha } from '../altcha';
import type { Env, SendDeps } from '../types';
import { DummyDriver, Kysely } from 'kysely';
import type { CompiledQuery, DatabaseConnection } from 'kysely';
import { applyMigrations, compileMigrations, reconcileDone, reconcilers, sandboxed, schemaReady, sha256Hex, sqliteDialect, startReconcile } from './ext-migrations';
import { runRetention } from './retention';
import { ensureJob, runJobs, type JobHooks, type JobKind } from './jobs';
import { JOB_KINDS } from './job-kinds';
import { currentInvocation } from './budget';
import type { EventConsumer } from './events';
import { panelAllows, type PanelPrincipal } from './panel';
import { requireKeyProvider, type KeyProvider } from '../clients';
import { appendAudit } from './audit';
import { eventId } from './store/events';
import type { KyselyStore } from './store';
import type { Config } from './config/schema';
import type { EmitEvent, Extension, ExtensionApp, ExtensionContext, ExtensionDatabase, BeforeMessageDelete } from './extensions';

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
type Query = { compile(): CompiledQuery };
/** The checks of `batch` without running it: writes an extension hands back for a core batch (job steps, event acks). */
const prepared = new WeakMap<ExtensionDatabase, (queries: Query[]) => CompiledQuery[]>();
/** Kysely limited to `ext_<name>_*`; `batch` checks every element before one atomic store batch. */
function extensionDb(store: KyselyStore, prefix: string, kinds: string[] = []): ExtensionDatabase {
  class ExtensionDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: <R>(query: CompiledQuery) => store.db.executeQuery<R>(sandboxed(query, prefix)),
        async *streamQuery() { throw new Error('Unsupported extension stream'); },
      };
    }
    override async beginTransaction() { throw new Error('Unsupported extension transaction'); }
  }
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: sqliteDialect(new ExtensionDriver()) });
  const jobs = new WeakSet<CompiledQuery>();
  function enqueue(kind: string, key: string, payload: unknown, source?: Query) {
    const name = `ext:${prefix.slice(4, -1)}:${kind}`;
    if (!kinds.includes(kind) || !/^[\w.:-]{1,128}$/.test(key)) throw new Error('Invalid extension job');
    const query = ensureJob(store, name, source ? `${name}:` : `${name}:${key}`, payload, Date.now(), source && sandboxed(source.compile(), prefix));
    jobs.add(query);
    return { compile: () => query };
  }
  const prepare = (queries: Query[]) => queries.map(q => { const query = q.compile(); return jobs.has(query) ? query : sandboxed(query, prefix); });
  const extension = Object.assign(db, { enqueue, batch: async (queries: Query[]) => store.batch(prepare(queries)) });
  prepared.set(extension, prepare);
  return extension;
}
const SES_SCENARIOS = ['success', 'bounce', 'complaint'] as const;
/** R8: the only send an extension gets: three fixed notice mails to SES simulator addresses, never an arbitrary message. */
const sesLoop = (config: Config, env: object, deps: SendDeps | undefined, panel: PanelPrincipal, last: { at: number }): ExtensionContext['sendInProcess'] => async ({ brand, scenario, key }) => {
  const secret = Reflect.get(env, config.legacyApiKey?.env ?? 'API_KEY');
  if (!SES_SCENARIOS.includes(scenario) || !Object.hasOwn(config.brands, brand) || typeof key !== 'string' || !/^[\w.:-]{1,100}$/.test(key) ||
    !panelAllows(panel, 'admin') || (panel.brands !== '*' && !panel.brands.includes(brand)) || (panel.templates !== '*' && !panel.templates.includes('notice'))) return { error: 'invalid' };
  if (!deps || config.legacyApiKey?.enabled === false || typeof secret !== 'string' || !secret) return { error: 'unavailable' };
  const now = deps.now().getTime();
  if (now - last.at < 1100) return { error: 'rate_limited' };
  last.at = now;
  try {
    const response = await handleSend(new Request('https://in-process.invalid/v1/send', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'idempotency-key': `aws-${key}-${scenario}` },
      body: JSON.stringify({ brand, template: 'notice', to: `${scenario}@simulator.amazonses.com`, autoreply: false, heading: 'SES loop test', paragraphs: 'Synthetic delivery check.' }) }), env as Env, deps);
    const body = await response.json() as { success?: unknown; id?: unknown }; const id = typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.id) ? body.id : undefined;
    return { ...id ? { id } : {}, ...response.ok && body.success === true ? id ? {} : { error: 'log_required' as const } : { error: 'send_failed' as const } };
  } catch { return { error: 'unavailable' }; }
};
type Route = { handler: Parameters<ExtensionApp['route']>[2]; db: ExtensionDatabase; resend: boolean; extension: string };
type Ready = { module: string; state: 'ready'; name: string; capabilities: string[] };
export type ExtensionFeature = Ready | { module: string; state: 'unavailable'; reason: 'initialization' | 'schema' | 'reconcile' };
export type ExtensionHost = Awaited<ReturnType<typeof createExtensionHost>>;
/**
 * Runtime-neutral extension host. `importer` is the only host-specific part (Node: dynamic import, Worker: static
 * `pro.generated.ts`). An import or initialization failure leaves that extension `unavailable`; sending and the
 * full key keep working. With `options.keys` present the runtime supplies keys and extension `keys` hooks are skipped.
 */
export async function createExtensionHost(config: Config, store: KyselyStore,
  importer: (module: string) => Promise<{ default?: unknown }>,
  options: { delivery?: Pick<SendDeps, 'sendEmail' | 'provider'>; keys?: KeyProvider; applyMigrations?: boolean; kickJobs?: boolean; platform?: 'worker' | 'node' } & Pick<JobHooks, 'registry'> = {}) {
  const extensions: Extension[] = [], consumers: Extension[] = [], routes = new Map<string, Route>(), contexts = new Map<Extension, ExtensionContext>();
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
      for (const key of ['migrate', 'reconcile', 'routes', 'onEvent', 'onBeforeDelete', 'keys'] as const) if (extension[key] !== undefined && typeof extension[key] !== 'function') throw new Error('Invalid extension hook');
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
  // Schema and reconcile readiness (W7, N6): routes of a waiting extension answer 503 until it is ready.
  const waiting = new Map<string, { index: number; ready: Ready; configSha: string }>(), kinds: Record<string, JobKind> = {};
  for (const [index, extension] of loaded) {
    try {
      const db = extensionDb(store, `ext_${extension.name}_`, Object.keys(extension.jobs ?? {})), own = new Map<string, Route>();
      const configSha = await sha256Hex(JSON.stringify(config) + (extension.reconcileKey ? '\n' + extension.reconcileKey : ''));
      const manifest = await compileMigrations(extension.name, extension.migrations);
      let state: 'ready' | 'schema' | 'reconcile' = 'ready';
      try {
        if (options.applyMigrations) await applyMigrations(store, manifest);
        if (!await schemaReady(store, manifest)) state = 'schema';
        else if (extension.reconcile) {
          reconcilers.set(extension.name, { configSha, run: cursor => extension.reconcile!(db, { configSha, cursor }) });
          await startReconcile(store, extension.name, configSha, Date.now());
          if (!await reconcileDone(store, extension.name, configSha)) state = 'reconcile';
        }
      } catch { state = 'schema'; }
      if (state !== 'schema') await extension.migrate?.(db);
      await extension.routes?.({ route(method, path, handler) {
        if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)) throw new Error('Invalid extension route');
        const key = `${method.toUpperCase()} /internal/ext/${extension.name}${path}`;
        if (routes.has(key) || own.has(key)) throw new Error('Duplicate extension route');
        own.set(key, { handler, db, resend: extension.capabilities?.includes('resend') ?? false, extension: extension.name });
      } });
      for (const [key, route] of own) routes.set(key, route);
      const ready: Ready = { module: config.extensions[index].module, state: 'ready', name: extension.name, capabilities: [...extension.capabilities ?? []] };
      const extCtx = { ...ctx, db }, compile = (writes: Query[] = []) => prepared.get(db)!(writes);
      if (state !== 'schema') { contexts.set(extension, extCtx); extensions.push(extension); }
      // Without its schema an extension's jobs stay pending: unregistered `ext:` kinds are never claimed.
      if (state !== 'schema') for (const [name, job] of Object.entries(extension.jobs ?? {})) kinds[`ext:${extension.name}:${name}`] = { reserveMs: job.reserveMs, ops: job.ops, ready: job.ready,
        dead: ({ payload }) => compile(job.dead?.({ payload }, extCtx)),
        async step({ payload, attempt }) { const r = await job.run({ payload, attempt }, extCtx); return { ...r.retry ? { retry: true } : { result: null }, writes: compile(r.writes) }; } };
      if (state !== 'ready') {
        console.error(`mailstack: $.extensions.${index}.module: extension ${state} not ready`);
        waiting.set(extension.name, { index: features.length, ready, configSha });
      }
      // Extensions waiting for schema or reconcile still consume: their events wait in `domain_events` (A 3.3.3).
      if (extension.onEvent) consumers.push(extension);
      features.push(state === 'ready' ? ready : { module: ready.module, state: 'unavailable', reason: state });
    } catch { unavailable(index); }
  }
  // Durable events reach consumers only through the fan-out job (Worker: kicked by the emit; Node: its job clock).
  const fanout = new Map<string, EventConsumer>(consumers.filter(e => contexts.has(e)).map(e => [e.name, async (event, resume) => {
    const ack = await e.onEvent!(structuredClone(event), contexts.get(e)!, resume);
    return ack?.writes ? { ...ack, writes: prepared.get(contexts.get(e)!.db)!(ack.writes) } : ack;
  }]));
  // A configured extension without code or schema cannot clean up: erasure and retention wait instead of deleting around it.
  const cleanupBlocked = features.some(f => f.state === 'unavailable' && f.reason !== 'reconcile');
  const beforeDelete: BeforeMessageDelete = async selection => {
    if (cleanupBlocked) throw new Error('Extension cleanup unavailable');
    for (const extension of extensions) if (extension.onBeforeDelete) {
      await bounded(() => extension.onBeforeDelete!(structuredClone(selection), contexts.get(extension)!), true);
    }
  };
  const jobs: JobHooks = { beforeDelete, consumers: fanout, registry: options.registry, kinds: { ...JOB_KINDS, ...kinds,
    ...cleanupBlocked ? { erase: { ...JOB_KINDS.erase, ready: async () => false } } : {} } };
  // One drain per invocation: a kick during a running drain (auto-reply after the main send) asks it for one more pass.
  const drains = new WeakMap<object, { again: boolean; run?: Promise<void> }>();
  const kick = (): Promise<void> => {
    const call = currentInvocation() ?? {}, running = drains.get(call);
    if (running) { running.again = true; return running.run!; }
    const state: { again: boolean; run?: Promise<void> } = { again: false };
    drains.set(call, state);
    return state.run = (async () => {
      do { state.again = false; await runJobs(store, 'request', jobs).catch(() => {}); } while (state.again);
      drains.delete(call);
    })();
  };
  const emitEvent = (input: Parameters<EmitEvent>[0], waitUntil?: Parameters<EmitEvent>[1]): Promise<unknown> => {
    const { type, at, brand, template, status, ref, messageId, durable } = input;
    if (durable) return options.kickJobs && fanout.size ? kick() : Promise.resolve();
    const event = { id: eventId(at), type, at, brand, template, status, messageId, ...(ref === undefined ? {} : { ref }) };
    const task = Promise.all(extensions.map(extension => bounded(async () => {
      const ack = await extension.onEvent?.(structuredClone(event), contexts.get(extension)!);
      if (ack?.writes?.length) await contexts.get(extension)!.db.batch(ack.writes);
    })));
    if (waitUntil) { try { waitUntil(task); } catch {} }
    return task;
  };
  const events = consumers.length ? { ref: consumers.some(e => e.eventRef === true) } : undefined;
  const durableEvents = async () => events;
  const { delivery } = options;
  const sendDeps = (env: Env): SendDeps | undefined => delivery && { ...delivery, keys, store, now: () => new Date(), logging: config.logging, notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, emitEvent, durableEvents, verifyTurnstile, verifyAltcha };
  const service = (env: Env) => createResendService(config, store, env, sendDeps(env)!);
  const loop = { at: 0 };
  const enabled = delivery && extensions.some(e => e.capabilities?.includes('resend'));
  const resendSource: SendDeps['resendSource'] = enabled ? (env, client, id, key, payload, ref, attachments, brandId) => service(env).sendSource(client, id, key, payload, ref, attachments, brandId) : undefined;
  /** A waiting extension becomes ready once its reconcile job finished (in any process or isolate). */
  async function refresh(extension: string): Promise<ExtensionFeature | undefined> {
    const wait = waiting.get(extension), feature = wait && features[wait.index];
    if (feature?.state !== 'unavailable' || feature.reason !== 'reconcile' || !await reconcileDone(store, extension, wait!.configSha).catch(() => false)) return feature;
    features[wait!.index] = wait!.ready; waiting.delete(extension);
    return wait!.ready;
  }
  return { emitEvent, durableEvents, resendSource, keys, beforeDelete, jobs,
    features: () => structuredClone(features),
    /** Re-checks waiting extensions before `features()` is reported (capabilities). */
    async refresh() { for (const extension of [...waiting.keys()]) await refresh(extension); },
    runRetention: (now: number) => runRetention(store, now, config, beforeDelete, consumers.map(e => e.name)),
    /** Dispatches `/internal/ext/*` after the caller's panel gate; unknown routes are 404. */
    async route(req: Request, env: object, panel: PanelPrincipal, deps?: SendDeps): Promise<Response> {
      const route = routes.get(`${req.method} ${new URL(req.url).pathname}`);
      const feature = route && await refresh(route.extension);
      if (feature?.state === 'unavailable') return Response.json({ success: false, message: 'extension unavailable', code: 'extension_unavailable', reason: feature.reason }, { status: 503 });
      return route ? route.handler(req, { ...ctx, panel, db: route.db,
        ...(panel.brands === '*' && panel.templates === '*' ? { sesStatus: () => readSesStatus(store, config.events?.ses, String(Reflect.get(env, 'SES_REGION') ?? 'eu-west-1')) } : {}),
        sendInProcess: sesLoop(config, env, deps ?? sendDeps(env as Env), panel, loop),
        ...(enabled && route.resend ? { resend: service(env as Env).forPanel(panel, transitAudience(env, { platform: options.platform ?? 'node' })) } : {}) }) : new Response(null, { status: 404 });
    } };
}
