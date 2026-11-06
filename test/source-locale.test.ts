import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { config } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { templatePlans } from '../src/templates/config';
import { handleSourceHook } from '../src/sources';
import { prepareEmail } from '../src/templates/prepare';
import { getTemplate } from '../src/templates';
import { mapSourceFields } from '../src/source-fields';
import type { Env, SendParams } from '../src/types';
const original = structuredClone(config);
const example = () => JSON.parse(readFileSync('config/mail-templates.en.example.json', 'utf8'));
const translated = () => ({ ...original, mailTemplates: example(), brands: { ...original.brands, acme: { ...original.brands.acme,
  mailTemplates: { languages: { default: 'pl', allowed: ['pl', 'en'] } } } } });
afterEach(() => { Object.keys(config).forEach(key => Reflect.deleteProperty(config, key)); Object.assign(config, structuredClone(original)); });
async function send(body: unknown, input: unknown = translated(), id = 'sellf') {
  const cfg = parseConfig(input); Object.assign(config, cfg);
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
  const response = await handleSourceHook(new Request(`https://local.example/v1/hooks/${id}?brand=acme`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer example' } }),
    { API_KEY: 'example' } as Env, { templates: templatePlans(cfg), logging: { ...cfg.logging, defaults: { ...cfg.logging.defaults, level: 'none' } }, sendEmail, now: () => new Date(), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn() }, id);
  return { response, sendEmail, cfg };
}
it('ships the complete English template example', () => {
  const cfg = parseConfig(translated());
  for (const template of ['contact', 'received', 'welcome', 'payment', 'license', 'notice', 'refund', 'bank-transfer']) {
    expect(templatePlans(cfg).routes.acme[template][''].en).toBeDefined();
    const prepared = prepareEmail(cfg.brands.acme, getTemplate(template)!, { name: 'Jane', amount: '49.99', currency: 'USD', productName: 'Plan', heading: 'Update', intro: 'Ready', paragraphs: 'Details' }, { plans: templatePlans(cfg), locale: 'en' });
    expect(prepared.locale).toBe('en'); expect(prepared.html).toContain('lang="en"'); expect(prepared.text).toContain('Sent by');
  }
});
for (const file of readdirSync('test/fixtures/sellf-w176').filter(file => file.endsWith('.json'))) it(`renders producer envelope ${file}`, async () => {
  const body = JSON.parse(readFileSync(`test/fixtures/sellf-w176/${file}`, 'utf8'));
  expect(body.data.customer.locale).toBe('en');
  const { response, sendEmail } = await send(body);
  const missing = ({ 'order.placed': ['holder', 'account', 'bank', 'title'], 'order.payment_reminder': ['holder', 'account', 'bank', 'title'], 'refund.issued': ['transactionId'] } as Record<string, string[]>)[body.event];
  if (missing) {
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: 'invalid_event_data', fields: missing });
    expect(sendEmail).not.toHaveBeenCalled(); return;
  }
  expect(response.status, JSON.stringify(await response.json())).toBe(200); expect(sendEmail).toHaveBeenCalledOnce();
  const message = sendEmail.mock.calls[0][1]; expect(message.html).toContain('lang="en"'); expect(message.text).toContain('Sent by');
  const heading = ({ 'purchase.completed': 'Payment confirmation', 'license.issued': 'Your license key', 'order.placed': 'Bank transfer details',
    'order.payment_reminder': 'Payment reminder', 'order.cancelled': 'Order cancelled', 'order.participants_needed': 'Add participants', 'refund.issued': 'Refund confirmation', 'lead.captured': 'Welcome' } as Record<string, string>)[body.event];
  expect(message.subject).toContain(heading);
});
it('resolves an arbitrary configured path and preserves the base without languages', async () => {
  const body = JSON.parse(readFileSync('test/fixtures/sellf-w176/order.cancelled.json', 'utf8'));
  const input = translated(); const source = structuredClone(original.sources.sellf);
  Object.assign(source, { locale: 'data.recipient.language' });
  const custom = { ...input, sources: { alpha: source } }; body.data.recipient = { language: 'en-US' };
  let result = await send(body, custom, 'alpha'); expect(result.sendEmail.mock.calls[0][1].subject).toBe('Order cancelled');
  delete body.data.recipient; result = await send(body, custom, 'alpha'); expect(result.sendEmail.mock.calls[0][1].subject).toBe('Zamówienie anulowane');
  Reflect.deleteProperty(custom.brands.acme, 'mailTemplates'); body.data.recipient = { language: 'en' };
  result = await send(body, custom, 'alpha'); expect(result.sendEmail.mock.calls[0][1].subject).toBe('Zamówienie anulowane');
});
it('validates localized field selections and reports unavailable overlays', () => {
  const input = translated(), action = original.sources.sellf.events['order.cancelled']; if (action.action !== 'send') throw Error('send expected');
  for (const fields of [ { heading: { format: '{data.licenseKey}' }, paragraphs: { format: 'Text' }, ctaLabel: { format: 'View' } },
    { heading: { format: 'Heading' } }, { heading: { format: 'Heading' }, paragraphs: { format: 'Text' }, ctaLabel: { format: 'View' }, ctaUrl: 'data.order.payUrl' } ]) {
    expect(() => parseConfig({ ...input, sources: { alpha: { ...original.sources.sellf, events: { cancel: { ...action, fieldsByLocale: { en: fields } } } } } })).toThrow('$.sources.alpha.events.cancel.fieldsByLocale');
  }
  const cfg = parseConfig(input); expect(templatePlans(cfg).warnings.some(w => w.includes('fieldsByLocale.en'))).toBe(false);
  const dead = parseConfig({ ...input, brands: original.brands }); expect(templatePlans(dead).warnings.some(w => w.includes('fieldsByLocale.en'))).toBe(true);
  const missing = structuredClone(input); Reflect.deleteProperty(missing.sources.sellf.events['order.cancelled'], 'fieldsByLocale');
  expect(templatePlans(parseConfig(missing)).warnings.some(w => w.includes('order.cancelled') && w.includes('fields'))).toBe(true);
});
it('keeps amounts and dates unchanged under English copy', () => {
  const cfg = parseConfig(translated()), source = cfg.sources.sellf;
  const body = JSON.parse(readFileSync('test/fixtures/sellf-w176/purchase.completed.json', 'utf8'));
  const action = source.events[body.event]; if (action.action !== 'send') throw Error('send expected');
  const data = mapSourceFields(body, action.fields);
  const en = prepareEmail(cfg.brands.acme, getTemplate(action.template)!, data, { plans: templatePlans(cfg), locale: 'en' });
  const pl = prepareEmail(cfg.brands.acme, getTemplate(action.template)!, data, { plans: templatePlans(cfg), locale: 'pl' });
  expect(en.text).toContain(data.amount + ' ' + data.currency); expect(en.text).toContain(data.date); expect(pl.text).toContain(data.date);
});

it('uses complete English helper labels and CTA fallbacks', () => {
  const cfg = parseConfig(translated()), plans = templatePlans(cfg);
  for (const name of ['name', 'NAME', 'Imię i nazwisko']) {
    const mail = prepareEmail(cfg.brands.acme, getTemplate('contact')!, { [name]: 'Jane' }, { plans, locale: 'en' });
    expect(mail.text).toContain('Name: Jane'); expect(mail.text).not.toContain('Imię');
  }
  for (const id of ['notice', 'welcome']) for (const ctaLabel of [undefined, '', '  ']) {
    const data = { heading: 'Update', paragraphs: 'Ready', ctaUrl: 'https://example.com' }; if (ctaLabel !== undefined) Object.assign(data, { ctaLabel });
    const mail = prepareEmail(cfg.brands.acme, getTemplate(id)!, data, { plans, locale: 'en' });
    expect(mail.text).toContain(id === 'notice' ? 'Learn more' : 'Get started'); expect(mail.text).not.toContain('Otwórz');
  }
});
it('bounds localized expansion before delivery and accounts for source configuration bytes', async () => {
  const input = translated(), action = original.sources.sellf.events['order.cancelled']; if (action.action !== 'send') throw Error('send expected');
  const base = { heading: { format: 'Update' }, paragraphs: 'data.x' };
  const source = { legacyKey: true, locale: 'data.customer.locale', signature: { scheme: 'bearer-only' }, envelope: original.sources.sellf.envelope,
    events: { test: { action: 'send', template: 'notice', to: 'data.customer.email', fields: base, fieldsByLocale: { en: { heading: { format: 'Update' }, paragraphs: { format: '{data.x}'.repeat(500) } } } } } };
  const output = await send({ event: 'test', timestamp: '2026-11-06T12:00:00Z', data: { customer: { email: 'reader@example.com', locale: 'en' }, x: 'x'.repeat(5000) } }, { ...input, sources: { alpha: source } }, 'alpha');
  expect(output.response.status).toBe(422); expect(await output.response.json()).toMatchObject({ code: 'invalid_event_data', fields: ['paragraphs'] }); expect(output.sendEmail).not.toHaveBeenCalled();
  const fields = { heading: { format: 'x'.repeat(5000) }, paragraphs: { format: 'x'.repeat(5000) } };
  expect(() => parseConfig({ ...input, sources: { alpha: { ...source, events: Object.fromEntries(Array.from({ length: 27 }, (_, i) => ['event' + i,
    { ...source.events.test, fields, fieldsByLocale: { en: fields } }])) } } })).toThrow('configuration byte limit');
});
it('renders every source copy overlay from documented producer examples', async () => {
  const cfg = parseConfig(translated()), plans = templatePlans(cfg);
  const access = JSON.parse(readFileSync('test/fixtures/sellf/access.granted.json', 'utf8'));
  for (const [event, action] of Object.entries(cfg.sources.sellf.events)) {
    if (action.action !== 'send' || !action.fieldsByLocale?.en) continue;
    const file = ['order.cancelled', 'order.participants_needed', 'lead.captured'].includes(event) ? `test/fixtures/sellf-w176/${event}.json` : '';
    const body = file ? JSON.parse(readFileSync(file, 'utf8')) : access;
    const data = { ...mapSourceFields(body, action.fields), ...mapSourceFields(body, action.fieldsByLocale.en) };
    const mail = prepareEmail(cfg.brands.acme, getTemplate(action.template)!, data, { plans, locale: 'en' });
    expect(mail.html).toContain('lang="en"'); expect(mail.text).toContain('Sent by');
    for (const [key, text] of Object.entries(mapSourceFields(body, action.fieldsByLocale.en))) {
      if (key !== 'ctaLabel' || /^https?:/.test(data.ctaUrl ?? '')) expect(mail.text).toContain(text.trim());
    }
  }
  expect(access.data.customer.locale).toBeUndefined();
  const result = await send(access); expect(result.response.status).toBe(200); expect(result.sendEmail.mock.calls[0][1].html).toContain('lang="pl"');
});
it('records source locale preference and resolves duplicates before rendering again', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { createSqliteStore } = await import('../src/core/store/sqlite');
  const { open } = await import('../src/core/crypto');
  const cfg = parseConfig(translated()); Object.assign(config, cfg);
  const store = createSqliteStore(':memory:'); await store.migrate();
  const pair = generateKeyPairSync('x25519');
  const env = { API_KEY: 'example', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'test' }] }), INDEX_KEYS: JSON.stringify([{ kid: 'test', key: Buffer.alloc(32, 7).toString('base64url') }]) } as Env;
  const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'test' };
  const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
  const deps = { store, templates: templatePlans(cfg), logging: { ...cfg.logging, defaults: { ...cfg.logging.defaults, level: 'full' as const, resend: 'replay' as const } }, sendEmail, now: () => new Date(), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn() };
  const body = JSON.parse(readFileSync('test/fixtures/sellf-w176/purchase.completed.json', 'utf8'));
  const call = (locale: string) => { body.data.customer.locale = locale; return handleSourceHook(new Request('https://local.example/v1/hooks/sellf?brand=acme', { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer example' } }), env, deps, 'sellf'); };
  try {
    const first = await (await call('en-us')).json() as { id: string }; expect(first.id).toBeTruthy();
    expect(await (await call('en-US')).json()).toEqual({ ...first, idempotent: true }); expect(sendEmail).toHaveBeenCalledOnce();
    const content = await store.db.selectFrom('contents').selectAll().executeTakeFirstOrThrow();
    expect(await open(content.sealed, { brand: 'acme', messageId: first.id, purpose: 'content' }, [privateKey])).toMatchObject({ metadata: { render: { locale: 'en' } } });
    const replay = await store.db.selectFrom('replays').selectAll().executeTakeFirstOrThrow();
    expect(await open(replay.sealed, { brand: 'acme', messageId: first.id, purpose: 'replay' }, [privateKey])).toMatchObject({ locale: 'en-US' });
    expect((await call('fr')).status).toBe(409); expect(sendEmail).toHaveBeenCalledOnce();
  } finally { await store.db.destroy(); }
});
