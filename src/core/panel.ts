import { createMac, verifyMac } from './crypto';
import { authenticate, tokenSha256, type Defer, type KeyProvider } from '../clients';
import type { Config } from './config/schema';
import { boundedText } from './http';

export interface PanelClaims {
  actor: string; role: 'viewer' | 'operator' | 'admin'; issuedAt: number; expiresAt: number; stepUpAt: number | null;
}
export interface PanelPrincipal extends PanelClaims { scopes: string[]; brands: '*' | string[]; templates: '*' | string[] }
async function operation(req: Request): Promise<string> {
  const url = new URL(req.url);
  return tokenSha256(req.method + '\n' + url.pathname + url.search + '\n' + await boundedText(req.clone(), 65536));
}
function signingKey(key: unknown) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid panel key');
  return [{ kid: 'panel-v1', key }];
}
export async function signPanelAssertion(req: Request, claims: PanelClaims, key: string): Promise<string> {
  const payload = { ...claims, operation: await operation(req) };
  return btoa(JSON.stringify({ payload, tag: await createMac(payload, signingKey(key)) }));
}
export async function verifyPanelAssertion(req: Request, env: object, now = Date.now()): Promise<PanelClaims | null> {
  try {
    const header = req.headers.get('x-panel-assertion');
    if (!header || header.length > 4096) return null;
    const { payload: p, tag } = JSON.parse(atob(header));
    if (!p || !/^[A-Za-z0-9_-]{1,128}$/.test(p.actor) || req.headers.get('x-panel-actor') !== p.actor ||
      !['viewer', 'operator', 'admin'].includes(p.role) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 60000 ||
      (p.stepUpAt !== null && (!Number.isSafeInteger(p.stepUpAt) || p.stepUpAt > now)) || p.operation !== await operation(req) ||
      !await verifyMac(p, tag, signingKey(Reflect.get(env, 'PANEL_ASSERTION_KEY')))) return null;
    return { actor: p.actor, role: p.role, issuedAt: p.issuedAt, expiresAt: p.expiresAt, stepUpAt: p.stepUpAt };
  } catch { return null; }
}
export function panelAllows(p: PanelClaims, role: PanelClaims['role'], stepUp = false, now = Date.now()): boolean {
  return ['viewer', 'operator', 'admin'].indexOf(p.role) >= ['viewer', 'operator', 'admin'].indexOf(role) &&
    (!stepUp || (p.stepUpAt !== null && p.stepUpAt <= now && now - p.stepUpAt <= 300000));
}
/** Shared internal API gate for Node and the Worker: client token, panel scope, then the signed assertion. */
export async function authorizePanel(req: Request, env: object, config: Pick<Config, 'legacyApiKey'>, keys?: KeyProvider, defer?: Defer): Promise<PanelPrincipal | Response> {
  const client = await authenticate(req, env, config, keys, defer);
  if (!client) return Response.json({ success: false }, { status: 401 });
  const claims = client.scopes.includes('panel') ? await verifyPanelAssertion(req, env) : null;
  return claims ? { ...claims, scopes: client.scopes, brands: client.brands, templates: client.templates } : Response.json({ success: false }, { status: 403 });
}
