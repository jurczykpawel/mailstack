import { expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { config } from '../src/core/config';
import { createSqliteStore } from '../src/core/store/sqlite';
import { handleSend } from '../src/send';
import { open } from '../src/core/crypto';
import { openTransit, TRANSIT_REQUEST_BYTES } from '../src/core/transit';
import { parseTransitKeys } from '../src/core/keyring';
import { verifyPanelAssertion } from '../src/core/panel';
import { panelClaims, panelEnv, signPanel } from './fixtures/panel';
import { seal, transitEnv } from './fixtures/transit';

const token = 'msk_panel_' + 'a'.repeat(43), utf8 = new TextEncoder();
const bytes = (value: string) => utf8.encode(value).length;
/** A trusted send body of exactly `size` bytes: markup, subject, Reply-To and multibyte fields within the field limits. */
function body(size: number) {
  const value: Record<string, unknown> = { brand: 'acme', template: 'notice', to: 'one@example.com', replyTo: 'reply@example.com', subject: 'Zażółć gęślą jaźń',
    paragraphs: 'Hello', markup: [{ kind: 'viewAction', name: 'Zobacz zamówienie', url: 'https://acme.example/o/1' }] };
  for (let i = 0; bytes(JSON.stringify(value)) < size - 4900; i++) value['field' + i] = i % 2 ? 'ż'.repeat(2400) : 'x'.repeat(4800);
  value.pad = ''; value.pad = 'x'.repeat(size - bytes(JSON.stringify(value)));
  return JSON.stringify(value);
}
// Review finding 7: a send accepted by /v1/send stays resendable once its replay is sealed in a transit envelope (`mt1.`, base64url).
it.each([57826, 65536])('resends an accepted %i-byte send through a sealed, signed request', async size => {
  const pair = generateKeyPairSync('x25519'), kid = 'c1';
  const env = { API_KEY: 'review-key', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 1).toString('base64url') }]) } as never;
  const saved = structuredClone(config.logging); config.logging.defaults.level = 'full'; config.logging.defaults.resend = 'replay';
  const store = createSqliteStore(':memory:'); await store.migrate();
  try {
    const text = body(size), deps = { store, now: () => new Date(), logging: config.logging, sendEmail: vi.fn(async () => ({ ok: true, status: 200, messageId: 'provider' })), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn() } as never;
    expect(bytes(text)).toBe(size);
    const res = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer review-key' }, body: text }), env, deps);
    expect(res.status).toBe(200); const { id } = await res.json() as { id: string };
    const row = await store.db.selectFrom('replays').selectAll().where('message_id', '=', id).executeTakeFirstOrThrow();
    const replay = await open(row.sealed, { brand: 'acme', messageId: id, purpose: 'replay' }, [{ ...pair.privateKey.export({ format: 'jwk' }), kid, kty: 'OKP', crv: 'X25519' }]);
    expect(replay).toMatchObject({ markup: [{ potentialAction: { '@type': 'ViewAction' } }], subjectOverride: 'Zażółć gęślą jaźń', replyTo: 'reply@example.com' });
    expect(bytes(JSON.stringify(replay))).toBeGreaterThan(size === 65536 ? 65536 : 0);
    const envelope = await seal({ replay }, 'resend.replay', panelEnv.PANEL_AUDIENCE, Date.now(), id);
    const sealedBody = JSON.stringify({ reason: 'Prośba klienta o ponowną wysyłkę '.repeat(15).slice(0, 500), idempotencyKey: 'k'.repeat(128), envelope });
    expect(bytes(sealedBody)).toBeGreaterThan(65536); expect(bytes(sealedBody)).toBeLessThanOrEqual(TRANSIT_REQUEST_BYTES);
    // The panel form carries the same envelope URL-encoded, with the reason percent-encoded.
    expect(new URLSearchParams({ reason: 'ż'.repeat(500), idempotencyKey: 'k'.repeat(128), formToken: 't'.repeat(64), envelope }).toString().length).toBeLessThanOrEqual(TRANSIT_REQUEST_BYTES);
    const req = await signPanel(new Request(`https://api.test/internal/ext/pro/resend?id=${id}`, { method: 'POST', body: sealedBody }), token, panelClaims('operator'));
    expect(await verifyPanelAssertion(req, panelEnv, panelEnv.PANEL_AUDIENCE)).not.toBeNull();
    expect(await openTransit(envelope, { aud: panelEnv.PANEL_AUDIENCE, op: 'resend.replay', messageId: id }, (await parseTransitKeys(transitEnv.TRANSIT_KEYS)).privateKeys, store, Date.now())).toEqual({ replay });
  } finally { config.logging = saved; await store.db.destroy(); }
});
it('refuses to sign or verify a request above the sealed request limit', async () => {
  const large = new Request('https://api.test/internal/ext/pro/resend?id=msg_1', { method: 'POST', body: 'x'.repeat(TRANSIT_REQUEST_BYTES + 1) });
  await expect(signPanel(large.clone(), token, panelClaims('operator'))).rejects.toThrow(RangeError);
  const fits = await signPanel(new Request(large.url, { method: 'POST', body: 'x'.repeat(TRANSIT_REQUEST_BYTES) }), token, panelClaims('operator'));
  expect(await verifyPanelAssertion(fits, panelEnv, panelEnv.PANEL_AUDIENCE)).not.toBeNull();
  const swapped = new Request(large.url, { method: 'POST', headers: fits.headers, body: 'x'.repeat(TRANSIT_REQUEST_BYTES + 1) });
  expect(await verifyPanelAssertion(swapped, panelEnv, panelEnv.PANEL_AUDIENCE)).toBeNull();
});
