import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { handleSellfHook } from './sellf-source-helper';
import { bundlePurchase } from './purchase-license-fixture';
import type { Env, SendParams, TemplateData } from '../src/types';
import { sourceField } from '../src/sources';
import { getTemplate } from '../src/templates/index';
import { config, getBrand } from '../src/core/config';
import { paymentTemplate } from '../src/templates/types/payment';
import { renderLayout } from '../src/templates/layout';

function cases() {
  const purchase = bundlePurchase();
  const result = [purchase];
  for (const absent of ['sessionId', 'paymentIntentId']) {
    const body = bundlePurchase(); Reflect.deleteProperty(body.data.order, absent); result.push(body);
  }
  for (let count = 0; count <= 32; count++) {
    const body = bundlePurchase();
    body.data.licenses = Array.from({ length: count }, (_, i) => ({ ...body.data.licenses[0], productId: `product-${i}`, token: `key-${i}` }));
    result.push(body);
  }
  const absent = bundlePurchase(); Reflect.deleteProperty(absent.data, 'licenses'); result.push(absent);
  const long = bundlePurchase(); long.data.licenses[0].token = 'a'.repeat(6000); result.push(long);
  const common = { customer: purchase.data.customer, product: purchase.data.product };
  return [...result, ...['waitlist.signup', 'lead.captured', 'access.expired'].map(event => ({
    event, timestamp: purchase.timestamp, data: common,
  })), ...[false, true].map(full => ({ event: 'refund.issued', timestamp: purchase.timestamp, data: {
    ...common, payment: { id: 'payment-1', paymentIntentId: 'pi_refund', sessionId: 'cs_refund', amount: 12300, currency: 'PLN' },
    refund: { stripeRefundId: `re_${full}`, amount: full ? 12300 : 3000, currency: 'pln', status: 'succeeded',
      isFullRefund: full, totalRefunded: full ? 12300 : 3000, refundedAt: purchase.timestamp, reason: full ? 'requested_by_customer' : null },
  } }))];
}

it('renders subject, HTML and text digests across the valid Sellf matrix', async () => {
  const digests = [];
  for (const brand of ['acme', 'demo']) for (const body of cases()) {
    const sendEmail = vi.fn(async (_env: Env, _mail: SendParams) => ({ ok: true, status: 200 }));
    const response = await handleSellfHook(new Request(`https://mail.example/v1/hooks/sellf?brand=${brand}`, {
      method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify(body),
    }), { API_KEY: 'test-key' } as Env, { sendEmail, now: () => new Date('2026-10-31T12:00:00Z'), verifyAltcha: vi.fn(), verifyTurnstile: vi.fn() });
    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledOnce();
    const mail = sendEmail.mock.calls[0][1];
    digests.push(createHash('sha256').update(JSON.stringify([mail.subject, mail.html, mail.text])).digest('hex'));
  }
  expect(digests).toMatchSnapshot();
});

async function sourceMail(body: unknown, brand = 'acme') {
  const sendEmail = vi.fn(async (_env: Env, _mail: SendParams) => ({ ok: true, status: 200 }));
  const response = await handleSellfHook(new Request(`https://mail.example/v1/hooks/sellf?brand=${brand}`, {
    method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify(body),
  }), { API_KEY: 'test-key' } as Env, {
    sendEmail, now: () => new Date('2026-10-31T12:00:00Z'), verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(),
  });
  expect(response.status).toBe(200);
  expect(sendEmail).toHaveBeenCalledOnce();
  return sendEmail.mock.calls[0][1];
}

// Field projection retained from the former adapter for valid purchase inputs.
function adapterPurchase(body: ReturnType<typeof bundlePurchase>, brandId = 'acme') {
  const brand = getBrand(brandId)!;
  const { customer, order, product } = body.data;
  const data = {
    name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
    amount: (order.amount / 100).toFixed(2), currency: order.currency.toUpperCase(),
    item: product.name, orderId: order.paymentIntentId || order.sessionId,
    date: new Date(body.timestamp).toLocaleDateString('pl-PL'),
  };
  return { subject: paymentTemplate.subject(brand, data), ...renderLayout(brand, paymentTemplate.render(brand, data)) };
}

const digest = (mail: { subject: string; html: string; text: string }) =>
  createHash('sha256').update(JSON.stringify([mail.subject, mail.html, mail.text])).digest('hex');

it.each([0, 1, 99, 100, 101, 9007199254740900, 9007199254740901, 9007199254740990, Number.MAX_SAFE_INTEGER])(
  'preserves adapter purchase content for minor amount %s', async amount => {
    const body = bundlePurchase();
    body.data.order.amount = amount;
    expect(digest(await sourceMail(body))).toBe(digest(adapterPurchase(body)));
  },
);

it('preserves adapter purchase date across midnight in the runtime timezone', async () => {
  vi.stubEnv('TZ', 'Europe/Warsaw');
  try {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Warsaw');
    const body = bundlePurchase();
    body.timestamp = '2026-10-31T23:30:00Z';
    const expected = adapterPurchase(body);
    expect(expected.text).toContain('Data: 1.11.2026');
    expect(digest(await sourceMail(body))).toBe(digest(expected));
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([true, false, undefined, null, 'true', 'false', 0, 1, {}, []])(
  'uses only boolean refund scope from the source: %j', async value => {
    const body = cases().find(body => body.event === 'refund.issued' && Reflect.get(body.data, 'refund').isFullRefund === (value === true))!;
    Reflect.set(body.data, 'refund', { ...Reflect.get(body.data, 'refund'), isFullRefund: value });
    const sendEmail = vi.fn(async (_env: Env, _mail: SendParams) => ({ ok: true, status: 200 }));
    const response = await handleSellfHook(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
      method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify(body),
    }), { API_KEY: 'test-key' } as Env, { sendEmail, now: () => new Date('2026-10-31T12:00:00Z'), verifyAltcha: vi.fn(), verifyTurnstile: vi.fn() });
    if (typeof value === 'boolean') {
      expect(response.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledOnce();
      for (const content of [sendEmail.mock.calls[0][1].html, sendEmail.mock.calls[0][1].text])
        expect(content).toContain(`Zakres zwrotu: ${value ? 'pełny' : 'częściowy'}.`);
    } else {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'invalid_event_data', fields: ['isFullRefund'] });
      expect(sendEmail).not.toHaveBeenCalled();
    }
  },
);

// Content projection from 9fd45da, independent of the source preset and refund template.
function adapterOther(body: ReturnType<typeof cases>[number], brandId: string) {
  const brand = getBrand(brandId)!;
  const data = body.data as Record<string, Record<string, unknown>>;
  const product = data.product.name;
  const refund = data.refund, payment = data.payment;
  const heading = body.event === 'refund.issued' ? 'Zwrot środków'
    : body.event === 'waitlist.signup' ? 'Jesteś na liście oczekujących' : 'Dostęp wygasł';
  const paragraphs = body.event === 'refund.issued' ? [
    `Zwróciliśmy ${(Number(refund.amount) / 100).toFixed(2)} ${String(refund.currency).toUpperCase()} za: ${product}.`,
    `Numer transakcji: ${payment.paymentIntentId || payment.sessionId}.`,
    `Identyfikator płatności: ${payment.id}.`, `Identyfikator zwrotu: ${refund.stripeRefundId}.`,
    'Status zwrotu: zakończony (succeeded).', `Zakres zwrotu: ${refund.isFullRefund ? 'pełny' : 'częściowy'}.`,
    `Łącznie zwrócono: ${(Number(refund.totalRefunded) / 100).toFixed(2)} ${String(refund.currency).toUpperCase()}.`,
    `Data zwrotu: ${refund.refundedAt}.`, ...(refund.reason ? [`Powód: ${refund.reason}.`] : []),
  ] : body.event === 'waitlist.signup'
    ? [`Dziękujemy za zapis na: ${product ?? ''}.`, 'Damy znać, gdy produkt będzie dostępny.']
    : [`Twój dostęp do ${product ?? ''} wygasł.`, 'Jeśli chcesz go odnowić, odpowiedz na tę wiadomość.'];
  const template = getTemplate(body.event === 'lead.captured' ? 'welcome' : 'notice')!;
  const fields: TemplateData = body.event === 'lead.captured' ? { name: '', intro: `Twój dostęp do ${product ?? ''} jest gotowy.` }
    : { heading, paragraphs: paragraphs.join('\n\n') };
  return { subject: template.subject(brand, fields), ...renderLayout(brand, template.render(brand, fields)) };
}

it.each(['acme', 'demo'])('compares every preset content operation with adapter output for %s', async brand => {
  for (const body of cases()) {
    const expected = body.event === 'purchase.completed' ? adapterPurchase(body as ReturnType<typeof bundlePurchase>, brand) : adapterOther(body, brand);
    expect(await sourceMail(body, brand)).toMatchObject(expected);
  }
  for (const absent of ['firstName', 'lastName']) {
    const body = bundlePurchase(); Reflect.deleteProperty(body.data.customer, absent);
    expect(await sourceMail(body, brand)).toMatchObject(adapterPurchase(body, brand));
  }
  for (const body of cases().filter(body => body.event === 'refund.issued')) {
    const payment = Reflect.get(body.data, 'payment');
    Reflect.deleteProperty(payment, 'paymentIntentId');
    const refund = Reflect.get(body.data, 'refund');
    refund.amount = refund.totalRefunded = 9007199254740901;
    expect(await sourceMail(body, brand)).toMatchObject(adapterOther(body, brand));
  }
});

it('preserves all preset correlation and identity first selections', () => {
  for (const [event, action] of Object.entries(config.sources.sellf.events)) {
    if (action.action !== 'send' || !['purchase.completed', 'refund.issued', 'waitlist.signup', 'lead.captured', 'access.expired'].includes(event)) continue;
    const paths = event === 'purchase.completed' ? ['data.order.orderId', 'data.order.paymentIntentId', 'data.order.sessionId']
      : event === 'refund.issued' ? ['data.payment.paymentIntentId', 'data.payment.sessionId']
      : ['data.order.sessionId', 'data.order.paymentIntentId', 'data.payment.sessionId', 'data.payment.paymentIntentId'];
    for (let index = 0; index <= paths.length; index++) {
      const body = { data: { order: {}, payment: {}, refund: { stripeRefundId: 're_1' } } };
      paths.slice(index).forEach((path, offset) => {
        const [, parent, key] = path.split('.'); Reflect.set(Reflect.get(body.data, parent), key, `id_${index + offset}`);
      });
      expect(sourceField(body, action.ref!)).toBe(index === paths.length ? '' : `id_${index}`);
      expect(sourceField(body, action.idempotencyKey!)).toBe(event === 'refund.issued' ? 're_1' : index === paths.length ? '' : `id_${index}`);
    }
  }
});
