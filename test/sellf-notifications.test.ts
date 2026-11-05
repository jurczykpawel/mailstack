import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../src/index';
import { config, getBrand } from '../src/core/config';
import { createSqliteStore } from '../src/core/store/sqlite';
import { getTemplate } from '../src/templates';
import { sourceField } from '../src/sources';
import { parseConfig } from '../src/core/config/schema';
import { open } from '../src/core/crypto';
import type { Env, SendParams } from '../src/types';

const events = ['order.placed', 'order.payment_reminder', 'order.cancelled', 'order.participants_needed', 'access.granted', 'license.issued', 'purchase.completed'];
type Payload = { event: string; timestamp: string; data: Record<string, any> };
const fixture = (event: string): Payload => JSON.parse(readFileSync(new URL(`./fixtures/sellf/${event}.json`, import.meta.url), 'utf8'));
let store: ReturnType<typeof createSqliteStore>;
const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
beforeEach(async () => { store = createSqliteStore(':memory:'); await store.migrate(); sendEmail.mockClear(); });
afterEach(async () => { await store.db.destroy(); });
async function request(body: Payload, level: 'none' | 'full' = 'none', extraEnv: Partial<Env> = {}) {
  return createApp({ store, sendEmail, now: () => new Date('2026-11-05T12:00:00Z'),
    logging: { ...config.logging, defaults: { ...config.logging.defaults, level }, brands: {} },
  }).fetch(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
    method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify(body),
  }), { API_KEY: 'test-key', ...extraEnv } as Env, {} as ExecutionContext);
}

it.each(events)('delivers the Sellf example for %s with stable correlation', async event => {
  const body = fixture(event);
  if (event === 'license.issued') body.data.license.issuanceSource = 'manual';
  const response = await request(body);
  expect(response.status).toBe(200);
  expect(sendEmail).toHaveBeenCalledOnce();
  const mail = sendEmail.mock.calls[0][1];
  expect(mail.to).toEqual([body.data.customer.email]);
  const expected: Record<string, string[]> = {
    'order.placed': ['Dane do przelewu', 'PL61109010140000071219812874', 'Example Bank', 'Example Workshops', 'Zamówienie 1001', '94.00 PLN', '2099-06-15', body.data.order?.payUrl],
    'order.payment_reminder': ['Przypomnienie o płatności', 'PL61109010140000071219812874', '94.00 PLN', '2099-06-15'],
    'order.cancelled': ['Zamówienie anulowane', 'Termin został zmieniony.', 'admin'],
    'order.participants_needed': ['Uzupełnij uczestników', '24 h', body.data.reminder?.participantsUrl],
    'access.granted': ['Example course', 'dostęp'],
    'license.issued': ['Premium Plugin', 'example.signed-license'],
    'purchase.completed': ['Płatność otrzymana', '49.99 USD', '00000000-0000-4000-8000-000000000001'],
  };
  for (const value of expected[event]) expect(mail.text).toContain(value);
  const replay = fixture(event);
  replay.data = structuredClone(body.data);
  replay.timestamp = '2026-11-05T13:00:00Z';
  const result = await (await request(replay)).json();
  expect(result).toMatchObject({ success: true, idempotent: true });
  expect(sendEmail).toHaveBeenCalledOnce();
});

const missing = [
  ...['order.placed', 'order.payment_reminder'].flatMap(event => ['order.orderId', 'order.transfer.account', 'order.transfer.bank', 'order.transfer.holder', 'order.transfer.title', 'order.amount', 'order.currency', 'order.paymentDeadline', 'order.payUrl'].map(path => [event, path])),
  ...['order.orderId', 'order.cancelReason'].map(path => ['order.cancelled', path]),
  ...['order.orderId', 'product.name', 'reminder.stage', 'reminder.participantsUrl'].map(path => ['order.participants_needed', path]),
  ...['access.id', 'product.name', 'grantSource'].map(path => ['access.granted', path]),
  ...['license.id', 'licenseKey', 'product.name', 'license.issuanceSource', 'license.order'].map(path => ['license.issued', path]),
  ...['order.orderId', 'order.amount', 'product.name'].map(path => ['purchase.completed', path]),
  ...events.map(event => [event, 'customer.email']),
];
it.each(missing)('rejects incomplete %s at %s before recording', async (event, path) => {
  const body = fixture(event);
  const parts = path.split('.');
  const last = parts.pop()!;
  const parent = parts.reduce((value, key) => value[key], body.data);
  delete parent[last];
  const response = await request(body);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'invalid_event_data' });
  expect(sendEmail).not.toHaveBeenCalled();
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
});

it.each([1, 2])('keeps participants stage %s distinct while retrying the same stage once', async stage => {
  const body = fixture('order.participants_needed');
  body.data.reminder.stage = stage;
  expect((await request(body)).status).toBe(200);
  expect(sendEmail.mock.calls[0][1].text).toContain(stage === 1 ? '24 h' : '2 dni');
  expect(await (await request(body)).json()).toMatchObject({ idempotent: true });
  body.data.reminder.stage = stage === 1 ? 2 : 1;
  expect((await request(body)).status).toBe(200);
  expect(sendEmail).toHaveBeenCalledTimes(2);
});

it.each([false, true])('delivers each paid license once, issuance first=%s', async issuanceFirst => {
  const purchase = fixture('purchase.completed'), license = fixture('license.issued');
  const bodies = issuanceFirst ? [license, purchase] : [purchase, license];
  for (const body of [...bodies, ...bodies]) expect((await request(body)).status).toBe(200);
  expect(sendEmail).toHaveBeenCalledOnce();
  expect(sendEmail.mock.calls[0][1].text.split(license.data.licenseKey)).toHaveLength(2);
});

it.each(['manual', 'api', 'free'])('delivers standalone %s licenses once per license ID', async source => {
  const body = fixture('license.issued');
  body.data.license.issuanceSource = source === 'free' ? 'purchase' : source;
  body.data.license.order = source === 'free' ? 'free_user_product' : 'api_order';
  expect((await request(body)).status).toBe(200);
  expect(await (await request(body)).json()).toMatchObject({ idempotent: true });
  body.data.license.id += '_second';
  body.data.licenseKey += '_second';
  expect((await request(body)).status).toBe(200);
  expect(sendEmail).toHaveBeenCalledTimes(2);
});

it('accepts nullable license metadata and uses the configured activation page', async () => {
  const body = fixture('license.issued');
  Object.assign(body.data.license, { issuanceSource: 'api', orderId: null, orderNumber: null, tier: null, domain: null, expiresAt: null });
  const brand = getBrand('acme')!, previous = brand.licenseActivationUrls;
  brand.licenseActivationUrls = { [body.data.product.id]: 'https://source.test.example/settings/license' };
  try {
    expect((await request(body)).status).toBe(200);
    expect(sendEmail.mock.calls[0][1].text).toContain('https://source.test.example/settings/license');
    expect(sendEmail.mock.calls[0][1].text).toContain(body.data.licenseKey);
  } finally { brand.licenseActivationUrls = previous; }
});

it('accepts an automatic cancellation without administrator text', async () => {
  const body = fixture('order.cancelled');
  body.data.order.cancelReason = 'payment_window_expired';
  delete body.data.order.cancelReasonText;
  expect((await request(body)).status).toBe(200);
  expect(sendEmail.mock.calls[0][1].text).toContain('payment_window_expired');
});

it.each(['purchase', 'bank_transfer', 'manual', 'subscription'])('does not send a free welcome for %s access', async source => {
  const body = fixture('access.granted'); body.data.grantSource = source;
  expect(await (await request(body)).json()).toMatchObject({ success: true, ignored: 'access.granted' });
  expect(sendEmail).not.toHaveBeenCalled();
});

it('uses the shared layout helpers for bank transfer values', () => {
  const template = getTemplate('bank-transfer');
  expect(template).toBeDefined();
  const body = template!.render(getBrand('acme')!, { account: '<b>A&B</b>', bank: '<script>bank</script>', orderUrl: 'javascript:example' });
  expect(body.bodyHtml).toContain('&lt;b&gt;A&amp;B&lt;/b&gt;');
  expect(body.bodyHtml).not.toContain('<script>');
  expect(body.bodyHtml).not.toContain('href="javascript:');
});

it.each([0, 3, '1', null])('requires a documented participants stage: %j', async stage => {
  const body = fixture('order.participants_needed'); body.data.reminder.stage = stage;
  expect((await request(body)).status).toBe(422);
  expect(sendEmail).not.toHaveBeenCalled();
});

it.each(['order.placed', 'order.participants_needed', 'access.granted', 'license.issued', 'purchase.completed'])('uses the documented ref for %s', event => {
  const body = fixture(event), action = config.sources.sellf.events[event];
  if (action.action !== 'send') throw new Error('Expected send');
  expect(sourceField(body, action.ref!)).toBe(body.data.order?.orderId ?? body.data.access?.id ?? body.data.license.orderId);
});

it('checks required source fields at configuration load', () => {
  const cfg = structuredClone(config), action = cfg.sources.sellf.events['order.cancelled'];
  if (action.action !== 'send') throw new Error('Expected send');
  delete action.fields.orderId;
  expect(() => parseConfig(cfg)).toThrow('required source field');
});

it('checks license transform inputs even when custom requirements are omitted', () => {
  const cfg = structuredClone(config), action = cfg.sources.sellf.events['license.issued'];
  if (action.action !== 'send') throw new Error('Expected send');
  delete action.requiredFields;
  delete action.fields.licenseOrder;
  expect(() => parseConfig(cfg)).toThrow('required source field');
});

it('delivers paid issuance separately when the purchase action omits keys', async () => {
  const purchaseAction = config.sources.sellf.events['purchase.completed'];
  if (purchaseAction.action !== 'send') throw new Error('Expected send');
  const previous = purchaseAction.transform;
  delete purchaseAction.transform;
  try {
    const license = fixture('license.issued');
    expect((await request(fixture('purchase.completed'))).status).toBe(200);
    expect((await request(license)).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0][1].text).not.toContain(license.data.licenseKey);
    expect(sendEmail.mock.calls[1][1].text).toContain(license.data.licenseKey);
  } finally { purchaseAction.transform = previous; }
});

it.each(['order.placed', 'order.participants_needed', 'license.issued'])('archives %s with delivery credentials masked', async event => {
  const body = fixture(event);
  if (event === 'license.issued') body.data.license.issuanceSource = 'api';
  const secret = body.data.order?.payUrl ?? body.data.reminder?.participantsUrl ?? body.data.licenseKey;
  const pair = generateKeyPairSync('x25519');
  const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', kid: 'c1' };
  const response = await request(body, 'full', {
    CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]),
  });
  expect(response.status).toBe(200);
  const [row] = await store.db.selectFrom('messages').selectAll().execute();
  const [content] = await store.db.selectFrom('contents').selectAll().execute();
  const archive = await open(content.sealed, { brand: 'acme', messageId: row.id, purpose: 'content' }, [privateKey]);
  expect(JSON.stringify(archive)).not.toContain(secret);
  expect(sendEmail.mock.calls[0][1].text).toContain(secret);
  expect(await store.db.selectFrom('replays').selectAll().execute()).toEqual([]);
});
