import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../src/core/config';
import { getTemplate, missingRequiredFields } from '../src/templates/index';
import { handleSellfHook } from './sellf-source-helper';
import { handleSend } from '../src/send';
import { bundlePurchase } from './purchase-license-fixture';
import { memoryStore } from './store-fixture';
import type { Env, SendDeps, TemplateData } from '../src/types';

const brand = getBrand('acme')!;
const env = { API_KEY: 'local-test-token' } as Env;
function deps(): SendDeps {
  return { sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(), now: () => new Date('2026-10-31T12:00:00Z') };
}
function request(path: string, body: unknown) {
  return new Request(`https://mail.example${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('template requirements', () => {
  it.each([
    ['payment', ['amount', 'currency', 'item', 'orderId']],
    ['license', ['productName', 'licenseKey']],
    ['notice', ['heading', 'paragraphs']],
  ])('%s declares its source data requirements', (id, fields) => {
    expect(getTemplate(id as string)?.requiredFields).toEqual(fields);
  });

  it('returns only missing keys and treats whitespace as empty', () => {
    const template = getTemplate('payment')!;
    expect(missingRequiredFields(template, { amount: '0', currency: 'PLN', item: ' \n' })).toEqual(['item', 'orderId']);
    expect(missingRequiredFields(getTemplate('contact')!, {})).toEqual([]);
  });

  it('declines incomplete mapped data before sending or emitting events', async () => {
    const template = getTemplate('payment')!;
    const original = template.requiredFields;
    template.requiredFields = ['amount', 'missing', 'alsoMissing'];
    const sending = deps();
    sending.emitEvent = vi.fn();
    sending.store = memoryStore();
    const claim = vi.spyOn(sending.store, 'claimIdempotency');
    const insert = vi.spyOn(sending.store, 'insertMessage');
    try {
      const response = await handleSellfHook(request('/v1/hooks/sellf', bundlePurchase()), env, sending);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ success: false, code: 'invalid_event_data',
        message: 'invalid event data', fields: ['missing', 'alsoMissing'] });
      expect(sending.sendEmail).not.toHaveBeenCalled();
      expect(sending.emitEvent).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    } finally { template.requiredFields = original; }
  });

  it.each(['payment', 'license', 'notice'])('/v1/send keeps accepting empty %s data', async template => {
    const sending = deps();
    const response = await handleSend(request('/v1/send', { brand: 'acme', template }), env, sending);
    expect(response.status).toBe(200);
    expect(sending.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('refund content compatibility', () => {
  it.each<[string, string | undefined, string]>([
    ['false', undefined, 'częściowy'],
    ['true', 'requested_by_customer', 'pełny'],
    ['true', '<b>request & reason</b>', 'pełny'],
  ])('keeps the previous notice content for full=%s and reason=%s', (isFullRefund, reason, scope) => {
    const data: TemplateData = { amount: '49.99', currency: 'PLN', productName: 'Protocol: X',
      transactionId: 'pi_1', paymentId: 'payment-1', refundId: 're_1', isFullRefund,
      totalRefunded: '49.99', refundedAt: '2026-06-10T10:00:00.000Z' };
    if (reason) data.reason = reason;
    const legacy = getTemplate('notice')!.render(brand, { heading: 'Zwrot środków', paragraphs: [
      'Zwróciliśmy 49.99 PLN za: Protocol: X.', 'Numer transakcji: pi_1.',
      'Identyfikator płatności: payment-1.', 'Identyfikator zwrotu: re_1.',
      'Status zwrotu: zakończony (succeeded).', `Zakres zwrotu: ${scope}.`,
      'Łącznie zwrócono: 49.99 PLN.', 'Data zwrotu: 2026-06-10T10:00:00.000Z.',
      ...(reason ? [`Powód: ${reason}.`] : []),
    ].join('\n\n') });
    const template = getTemplate('refund')!;
    expect(template.subject(brand, data)).toBe('Zwrot środków');
    expect(template.render(brand, data)).toEqual(legacy);
    expect(missingRequiredFields(template, data)).toEqual([]);
    expect(missingRequiredFields(template, {})).toEqual(template.requiredFields);
    expect(template.publicAllowed).toBeFalsy();
  });
});
