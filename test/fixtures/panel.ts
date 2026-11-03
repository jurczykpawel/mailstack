import { PANEL_PROTOCOL, signPanelAssertion, type PanelClaims, type PanelSigning } from '../../src/core/panel';

export const panelKey = { kid: 'p1', key: Buffer.alloc(32, 9).toString('base64url') };
export const panelEnv = { PANEL_ASSERTION_KEYS: JSON.stringify([panelKey]), PANEL_AUDIENCE: 'api.test' };
export const panelClaims = (role: PanelClaims['role'] = 'admin', now = Date.now()): PanelClaims =>
  ({ actor: 'user-1', role, issuedAt: now, expiresAt: now + 60000, stepUpAt: role === 'viewer' ? null : now });
/** Adds Bearer, actor, protocol and an assertion v2 signed over the request's final method, URL and body. */
export async function signPanel(req: Request, token: string, claims = panelClaims(), signing: Partial<PanelSigning> = {}): Promise<Request> {
  req.headers.set('authorization', `Bearer ${token}`);
  req.headers.set('x-panel-actor', claims.actor);
  req.headers.set('x-panel-protocol', PANEL_PROTOCOL);
  req.headers.set('x-panel-assertion', await signPanelAssertion(req, claims, { key: panelKey, token, aud: panelEnv.PANEL_AUDIENCE, ...signing }));
  return req;
}
