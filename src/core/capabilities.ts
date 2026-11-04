import { version } from '../../package.json';
import { jobStats } from './jobs';
import { parseTransitKeys } from './keyring';
import { panelAllows, type PanelPrincipal } from './panel';
import { effectivePolicies, type Config } from './config/schema';
import type { ExtensionHost } from './extension-host';
import type { KyselyStore } from './store';

/** Panel protocol versions this API serves (v1 was removed with assertion v2). */
export const PROTOCOL = { min: 2, max: 2 };
/** Page limits the internal API enforces for every client. */
export const LIMITS = { listPage: 100, exportPageMessages: 50, exportPageBytes: 1024 * 1024 };
/** Daily SQLite snapshots kept by the Node runtime. */
export const NODE_SNAPSHOTS = 7;
/** What the running host contributes: its platform and its extension host. */
export interface CapabilityHost { platform: 'worker' | 'node'; extensions(): Promise<Pick<ExtensionHost, 'features' | 'resendSource'> & Partial<Pick<ExtensionHost, 'durableEvents' | 'refresh'>>> }
type Feature = { state: 'enabled' } | { state: 'disabled' | 'unavailable'; reason: string };
const FEATURES = ['panel', 'webhooks', 'resend.replay', 'resend.source', 'aws.status', 'aws.test'] as const;
type Name = typeof FEATURES[number];
// Outbound HTTP on the Worker needs the egress service (URL, signing keys, Access token); without it these stay off instead of falling back to fetch.
const EGRESS: Name[] = ['webhooks', 'resend.source'];

/** `GET /internal/v2/capabilities`: what this principal may use here and why anything is off (A 3.8.3). */
/** The API installation id that panel assertions and transit envelopes are bound to. */
export const transitAudience = (env: object, host: Pick<CapabilityHost, 'platform'>): string | undefined =>
  Reflect.get(env, host.platform === 'worker' ? 'INTERNAL_HOST' : 'PANEL_AUDIENCE');

export async function capabilities(env: object, store: KyselyStore, cfg: Config, panel: PanelPrincipal, host: CapabilityHost, now = Date.now()) {
  const ext = await host.extensions();
  await ext.refresh?.();
  const loaded = ext.features();
  const pro = loaded.find(f => f.state === 'ready' && f.name === 'pro'), failed = loaded.find(f => f.state === 'unavailable');
  const options = pro && cfg.extensions.find(e => e.module === pro.module)?.options;
  const resend = new Set(effectivePolicies(cfg).map(p => p.policy.resend)), free = cfg.cloudflare?.plan === 'free';
  const admin = panelAllows(panel, 'admin'), full = panel.brands === '*' && panel.templates === '*';
  const configured: Record<Name, boolean> = { panel: true, webhooks: options?.webhooks !== undefined, 'resend.replay': resend.has('replay'),
    'resend.source': resend.has('source'), 'aws.status': !!cfg.events?.ses, 'aws.test': options?.aws !== undefined };
  const allowed: Record<Name, boolean> = { panel: true, webhooks: admin && panel.scopes.includes('webhooks:write'),
    'resend.replay': panelAllows(panel, 'operator'), 'resend.source': panelAllows(panel, 'operator'), 'aws.status': admin && full, 'aws.test': admin && full };
  const state = (name: Name): Feature => {
    const off = (reason: string, s: 'disabled' | 'unavailable' = 'disabled') => ({ state: s, reason });
    if (panel.denied) return off('license');
    if (name === 'panel') return { state: 'enabled' };
    if (!pro) return failed ? off(failed.reason, 'unavailable') : off('not_configured');
    if (host.platform === 'worker' && !['EGRESS_URL', 'EGRESS_KEYS', 'EGRESS_ACCESS_CLIENT_ID', 'EGRESS_ACCESS_CLIENT_SECRET'].every(k => Reflect.get(env, k)) && EGRESS.includes(name)) return off('platform:secure_egress_unavailable');
    if (!configured[name]) return off('not_configured');
    // The host builds resend only with a delivery adapter.
    if (name.startsWith('resend.') && !ext.resendSource) return off('host', 'unavailable');
    return allowed[name] ? { state: 'enabled' } : off('role');
  };
  // Durable events need a consumer and a message row; level none keeps them in memory only (A 3.3.3).
  const none = effectivePolicies(cfg).filter(p => p.policy.level === 'none').map(p => ({ brand: p.brandId, template: p.templateId }));
  const events = !await ext.durableEvents?.() ? { durable: false, reason: 'not_configured' }
    : none.length ? { durable: false, reason: 'policy:level_none', scopes: none } : { durable: true };
  const transit = await parseTransitKeys(Reflect.get(env, 'TRANSIT_KEYS')).catch(() => ({ publicKeys: [] }));
  const proCommit = Reflect.get(env, 'BUILD_PRO_COMMIT');
  return {
    protocol: PROTOCOL,
    api: { version, commit: Reflect.get(env, 'BUILD_COMMIT') || 'dev', ...(proCommit ? { proCommit } : {}), platform: host.platform,
      audience: transitAudience(env, host) ?? null },
    license: { state: panel.denied ? 'invalid' : 'valid' },
    principal: { role: panel.role, brands: panel.brands, templates: panel.templates },
    features: { ...Object.fromEntries(FEATURES.map(name => [name, state(name)])), events },
    limits: LIMITS,
    // The plan changes only how long provider-side copies outlive an erasure: D1 Time Travel keeps 30 days (Paid) or 7 (Free);
    // every feature runs on Free (measured on staging, WP20S). Node keeps its snapshots.
    backupWindowDays: host.platform === 'node' ? NODE_SNAPSHOTS : free ? 7 : 30,
    jobs: await jobStats(store, now),
    transitKeys: transit.publicKeys,
  };
}
