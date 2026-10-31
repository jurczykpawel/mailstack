import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { handleSellfHook } from './sellf-source-helper';
import { bundlePurchase } from './purchase-license-fixture';
import type { Env, SendParams } from '../src/types';

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

it('preserves adapter subject, HTML and text digests across the valid Sellf matrix', async () => {
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
