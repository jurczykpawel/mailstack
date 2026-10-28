import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { handleSellfHook } from '../src/sellf';
import { config, getBrand } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { createSqliteStore } from '../src/core/store/sqlite';
import { open } from '../src/core/crypto';
import { projectArchive } from '../src/core/logging/projection';
import { purchaseLicenseData } from '../src/purchase-licenses';
import { getTemplate } from '../src/templates';
import { escapeHtml } from '../src/templates/layout';
import type { Env, SendDeps } from '../src/types';
import { bundlePurchase } from './purchase-license-fixture';

const pair = generateKeyPairSync('x25519');
const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', kid: 'c1' };
const env: Env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: '', SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: '', ALTCHA_HMAC_KEY: '',
  CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }),
  INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) };
let store: ReturnType<typeof createSqliteStore>;
let deps: SendDeps;
const request = (body: unknown, brand = 'acme') => handleSellfHook(new Request(`https://mail.example/v1/hooks/sellf?brand=${brand}`, {
  method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify(body),
}), env, deps);
beforeEach(async () => {
  store = createSqliteStore(':memory:'); await store.migrate();
  deps = { store, logging: structuredClone(config.logging), now: () => new Date('2026-10-28T22:11:34Z'),
    verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(), emitEvent: vi.fn(),
    sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200 }) };
});
afterEach(async () => { await store.db.destroy(); });

it('retains the first purchase result and compares every supplied key', async () => {
  const body = bundlePurchase();
  const first = await (await request(body)).json() as { success: boolean; id: string };
  expect(first).toMatchObject({ success: true, id: expect.any(String) });
  expect(await (await request(body)).json()).toEqual({ ...first, idempotent: true });
  const piOnly = structuredClone(body);
  delete (piOnly.data.order as Record<string, unknown>).sessionId;
  expect(await (await request(piOnly)).json()).toEqual({ ...first, idempotent: true });
  body.data.licenses[1].token += '-changed';
  expect(await (await request(body)).json()).toMatchObject({ code: 'idempotency_conflict' });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  const [row] = await store.db.selectFrom('messages').selectAll().execute();
  expect(await open(row.ref_sealed!, { brand: 'acme', messageId: row.id, purpose: 'ref' }, [privateKey])).toBe('pi_bundle');
});

it.each(['pi', 'cs'])('uses the available purchase identifier: %s', async kind => {
  const body = bundlePurchase();
  if (kind === 'pi') delete (body.data.order as Record<string, unknown>).sessionId;
  else delete (body.data.order as Record<string, unknown>).paymentIntentId;
  expect((await request(body)).status).toBe(200);
  expect(vi.mocked(deps.sendEmail).mock.calls[0][1].subject).toContain(`${kind}_bundle`);
});

it.each([undefined, []])('accepts an ordinary purchase without license entries: %j', async licenses => {
  const body = { ...bundlePurchase(), data: { ...bundlePurchase().data, licenses } };
  expect((await request(body)).status).toBe(200);
  const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
  expect(mail.text).not.toContain('Twoje licencje');
  expect(mail.text).toContain('123.00 PLN');
});

const valid = bundlePurchase().data.licenses[0];
it.each([
  null, {}, 'license', [null], [1], [{}], [{ ...valid, token: '' }], [{ ...valid, token: ' ' }],
  [{ ...valid, token: 123 }], [{ ...valid, productId: '' }], [{ ...valid, kid: '' }],
  [{ ...valid, jwksUrl: 'javascript:alert(1)' }], [{ ...valid, jwksUrl: '/jwks' }],
  [{ ...valid, jwksUrl: 'ftp://source.test.example/jwks' }], [valid, valid],
  Array.from({ length: 33 }, (_, i) => ({ ...valid, productId: `p${i}` })),
  [{ ...valid, token: 'a'.repeat(25000) }, { ...valid, productId: 'other', token: 'b'.repeat(25000) }],
])('declines invalid purchase licenses before recording: %j', async licenses => {
  const body = bundlePurchase();
  const response = await request({ ...body, data: { ...body.data, licenses } });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'invalid_event_data' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
  expect(deps.emitEvent).not.toHaveBeenCalled();
  expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
  expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
});

it('keeps complete long keys and the explicit product identifier without a lookup', async () => {
  const body = bundlePurchase();
  body.data.licenses[0].token = 'a'.repeat(6000) + 'END1';
  body.data.licenses[1].token = 'b'.repeat(6000) + 'END2';
  body.data.licenses[1].productId = 'unlisted-product';
  expect((await request(body)).status).toBe(200);
  const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
  for (const license of body.data.licenses) {
    expect(mail.text).toContain(license.token);
    expect(mail.html).toContain(license.token);
  }
  expect(mail.text).toContain('Produkt: unlisted-product');
  expect(mail.text).not.toContain('customer.test.example');
  expect(mail.html).not.toContain('href="https://source.test.example/jwks');
});

it('retains the hook body size limit', async () => {
  expect((await request({ ...bundlePurchase(), extra: 'x'.repeat(65536) })).status).toBe(413);
  expect(deps.sendEmail).not.toHaveBeenCalled();
});

it('escapes each product and key and uses only explicitly configured activation pages', () => {
  const body = bundlePurchase();
  body.data.product.name = '<b>Bundle & Co</b>';
  body.data.licenses[1].token = '<script>full-key&value</script>';
  const brand = { ...getBrand('acme')!, licenseActivationUrls: { bundle: 'https://source.test.example/activate/bundle?view=license&mode=demo' } };
  const template = getTemplate('payment')!;
  const result = template.render(brand, purchaseLicenseData(body.data, brand));
  expect(result.bodyHtml).toContain(escapeHtml(body.data.product.name));
  expect(result.bodyHtml).toContain(escapeHtml(body.data.licenses[1].token));
  expect(result.bodyHtml).not.toContain(body.data.licenses[1].token);
  expect(result.bodyText).toContain(body.data.licenses[1].token);
  expect(result.bodyHtml).toContain('href="https://source.test.example/activate/bundle?view=license&amp;mode=demo"');
  expect(result.bodyText).toContain('Otwórz aktywację: <b>Bundle & Co</b>');
  expect(result.bodyText).toContain('inbox@acme.example');
  const unconfigured = { ...brand, licenseActivationUrls: {} };
  const noLink = template.render(unconfigured, purchaseLicenseData(body.data, unconfigured));
  expect(noLink.bodyHtml).not.toContain('<a ');
  expect(noLink.bodyText).toContain('Wklej każdy klucz');
  expect(noLink.bodyText).not.toContain('Otwórz aktywację');
});

it.each(['masked', 'full', 'meta'] as const)('stores and projects purchase content at level %s', async level => {
  deps.logging!.defaults.level = level;
  const body = bundlePurchase();
  body.data.licenses[1].token += '<>&"';
  const response = await request(body);
  expect(response.status).toBe(200);
  const [row] = await store.db.selectFrom('messages').selectAll().execute();
  const contents = await store.db.selectFrom('contents').selectAll().execute();
  if (level === 'meta') expect(contents).toEqual([]);
  else {
    const archive = await open(contents[0].sealed, { brand: 'acme', messageId: row.id, purpose: 'content' }, [privateKey]);
    for (const license of body.data.licenses) expect(JSON.stringify(archive)).not.toContain(license.token);
  }
  const brand = { ...getBrand('acme')!, licenseActivationUrls: { bundle: 'https://source.test.example/private-activation' } };
  const data = purchaseLicenseData(body.data, brand);
  const text = body.data.licenses.map(l => l.token).join(' ');
  const archive = projectArchive({ brand, data: { ...data, item: text }, template: getTemplate('payment')!, patterns: [],
    subject: text, policy: { ...deps.logging!.defaults, show: Object.keys(data).concat('item') } });
  for (const license of body.data.licenses) {
    expect(JSON.stringify(archive)).not.toContain(license.token);
    expect(JSON.stringify(archive)).not.toContain(escapeHtml(license.token));
    expect(JSON.stringify(vi.mocked(deps.emitEvent!).mock.calls)).not.toContain(license.token);
    expect(JSON.stringify(await store.db.selectFrom('messages').selectAll().execute())).not.toContain(license.token);
  }
  expect(JSON.stringify(archive)).not.toContain(brand.licenseActivationUrls.bundle);
  if (archive && archive.level !== 'meta') {
    expect(archive.text).toContain('••••END1');
    expect(archive.html).toContain('••••END1');
    expect(archive.text).toContain('••••<>&"');
    expect(archive.html).toContain('••••&lt;&gt;&amp;&quot;');
  }
});

it('validates activation configuration and retains existing brands', () => {
  const original = structuredClone(config);
  for (const brand of Object.values(original.brands)) delete brand.licenseActivationUrls;
  expect(parseConfig(original).brands.acme.licenseActivationUrls).toBeUndefined();
  for (const url of ['https://source.test.example/activate/bundle', 'http://source.test.example/activate/component']) {
    expect(parseConfig({ ...original, brands: { acme: { ...original.brands.acme, licenseActivationUrls: { bundle: url } } } }).brands.acme.licenseActivationUrls).toEqual({ bundle: url });
  }
  for (const urls of [[], { bundle: 'javascript:alert(1)' }, { bundle: '/activate' }, { bundle: 123 }, { '': 'https://source.test.example/' }])
    expect(() => parseConfig({ ...original, brands: { acme: { ...original.brands.acme, licenseActivationUrls: urls } } })).toThrow('licenseActivationUrls');
});

it.each(['masked', 'full'] as const)('projects complete short keys at level %s', level => {
  const body = bundlePurchase();
  body.data.licenses[0].token = 'ZQ7';
  const brand = getBrand('acme')!;
  const archive = projectArchive({ brand, data: purchaseLicenseData(body.data, brand), template: getTemplate('payment')!, patterns: [],
    policy: { ...config.logging.defaults, level } });
  expect(JSON.stringify(archive)).not.toContain('ZQ7');
});

it('sends the full unconfigured bundle instructions in one first email', async () => {
  const body = bundlePurchase();
  expect((await request(body, 'demo')).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
  for (const license of body.data.licenses) {
    expect(mail.text).toContain(license.token);
    expect(mail.html).toContain(license.token);
  }
  expect(mail.text).toContain('Każdy komponent aktywuje się oddzielnie');
  expect(mail.text).toContain('team@demo.example');
  expect(mail.text).not.toContain('Otwórz aktywację');
  expect(mail.html).not.toContain('/activate/');
});

it.each(['Z', 'Z7'])('projects embedded key %s in shown content and subject', token => {
  const body = bundlePurchase();
  body.data.licenses[0].token = token;
  body.data.product.name = `prefix${token}suffix`;
  const brand = getBrand('acme')!;
  const data = { ...purchaseLicenseData(body.data, brand), item: body.data.product.name };
  for (const level of ['masked', 'full'] as const) {
    const archive = projectArchive({ brand, data, template: getTemplate('payment')!, patterns: [],
      subject: `order${token}number`, policy: { ...config.logging.defaults, level, show: ['item'] } });
    expect(archive && archive.level !== 'meta').toBe(true);
    if (archive && archive.level !== 'meta') {
      expect(archive.html).not.toContain(token);
      expect(archive.text).not.toContain(token);
      expect(archive.subject).not.toContain(token);
      expect(archive.subject).toBe('order••••number');
      expect(archive.html).toContain('prefix••••suffix');
      expect(archive.text).toContain('prefix••••suffix');
    }
  }
});
