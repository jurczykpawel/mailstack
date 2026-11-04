import { createMac, encode, verifyMac, type IndexKey } from './crypto';
import { authenticate, bearerToken, licenseRequired, tokenSha256, type Defer, type KeyProvider } from '../clients';
import type { Config } from './config/schema';
import type { KyselyStore } from './store';
import { parseIndexKeys } from './keyring';
import { boundedText, TRANSIT_REQUEST_BYTES } from './http';

export const PANEL_PROTOCOL = '2';
export interface PanelClaims {
  actor: string; role: 'viewer' | 'operator' | 'admin'; issuedAt: number; expiresAt: number; stepUpAt: number | null;
}
export interface PanelPrincipal extends PanelClaims { scopes: string[]; brands: '*' | string[]; templates: '*' | string[]; denied?: 'license' }
/** Signing inputs: one keyring entry, the Bearer token sent with the request, the API installation id, and an optional nonce (null omits it). */
export interface PanelSigning { key: IndexKey; token: string; aud: string; nonce?: string | null }
async function operation(req: Request): Promise<string> {
  const url = new URL(req.url);
  return tokenSha256(req.method + '\n' + url.pathname + url.search + '\n' + await boundedText(req.clone(), TRANSIT_REQUEST_BYTES));
}
const mutation = (req: Request) => req.method !== 'GET' && req.method !== 'HEAD';
export async function signPanelAssertion(req: Request, claims: PanelClaims, s: PanelSigning): Promise<string> {
  const nonce = s.nonce === undefined ? (mutation(req) ? encode(crypto.getRandomValues(new Uint8Array(32)).buffer) : null) : s.nonce;
  const payload = { v: 2, kid: s.key.kid, ...claims, tokenHash: await tokenSha256(s.token), aud: s.aud,
    ...(nonce === null ? {} : { nonce }), operation: await operation(req) };
  return btoa(JSON.stringify({ payload, tag: await createMac(payload, [s.key]) }));
}
/** Verifies an assertion v2 against the keyring, the presented Bearer token and the audience; returns the claims and the nonce to consume. */
export async function verifyPanelAssertion(req: Request, env: object, aud: string, now = Date.now()): Promise<{ claims: PanelClaims; nonce?: string } | null> {
  try {
    const header = req.headers.get('x-panel-assertion'), token = bearerToken(req);
    if (!header || header.length > 4096 || !token || !aud || req.headers.get('x-panel-protocol') !== PANEL_PROTOCOL) return null;
    const { payload: p, tag } = JSON.parse(atob(header));
    const keys = parseIndexKeys(String(Reflect.get(env, 'PANEL_ASSERTION_KEYS')));
    const key = keys.find(k => k.kid === p?.kid);
    if (!p || p.v !== 2 || !key || !/^[A-Za-z0-9_-]{1,128}$/.test(p.actor) || req.headers.get('x-panel-actor') !== p.actor ||
      !['viewer', 'operator', 'admin'].includes(p.role) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 60000 ||
      (p.stepUpAt !== null && (!Number.isSafeInteger(p.stepUpAt) || p.stepUpAt > now)) ||
      p.tokenHash !== await tokenSha256(token) || p.aud !== aud ||
      (p.nonce === undefined ? mutation(req) : typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.nonce)) ||
      p.operation !== await operation(req) || !await verifyMac(p, tag, [key])) return null;
    return { claims: { actor: p.actor, role: p.role, issuedAt: p.issuedAt, expiresAt: p.expiresAt, stepUpAt: p.stepUpAt }, nonce: p.nonce };
  } catch { return null; }
}
export function panelAllows(p: PanelClaims, role: PanelClaims['role'], stepUp = false, now = Date.now()): boolean {
  return ['viewer', 'operator', 'admin'].indexOf(p.role) >= ['viewer', 'operator', 'admin'].indexOf(role) &&
    (!stepUp || (p.stepUpAt !== null && p.stepUpAt <= now && now - p.stepUpAt <= 300000));
}
export interface PanelGate { audience: string | undefined; store: Pick<KyselyStore, 'consume'>; keys?: KeyProvider; defer?: Defer }
/** The one internal API gate for Node and the Worker: client token, license, panel scope, assertion v2, then single use of its nonce. */
export async function authorizePanel(req: Request, env: object, config: Pick<Config, 'legacyApiKey'>, gate: PanelGate): Promise<PanelPrincipal | Response> {
  const result = await authenticate(req, env, config, gate.keys, gate.defer);
  if (!result) return Response.json({ success: false }, { status: 401 });
  // Without a license a valid token reaches only the capabilities route, which reports the license state.
  const denied = 'denied' in result, client = denied ? result.client : result;
  if (denied && (req.method !== 'GET' || new URL(req.url).pathname !== '/internal/v2/capabilities')) return licenseRequired();
  const verified = client.scopes.includes('panel') ? await verifyPanelAssertion(req, env, gate.audience ?? '') : null;
  if (!verified) return Response.json({ success: false }, { status: 403 });
  if (verified.nonce !== undefined) {
    let fresh: boolean;
    try { fresh = await gate.store.consume('panel-nonce:' + await tokenSha256(verified.nonce), Date.now() + 60000); }
    catch { return Response.json({ success: false }, { status: 503 }); }
    if (!fresh) return Response.json({ success: false, code: 'replayed' }, { status: 409 });
  }
  return { ...verified.claims, scopes: client.scopes, brands: client.brands, templates: client.templates, ...(denied ? { denied: 'license' as const } : {}) };
}
