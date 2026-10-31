import { expect, it, vi } from 'vitest';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema';
import { resolvePolicy } from '../src/core/logging/policy';
import { projectArchive } from '../src/core/logging/projection';
import { renderAndSend } from '../src/send';
import { getTemplate } from '../src/templates';
import type { Env, SendDeps, TemplateData } from '../src/types';

const brand = example.brands.acme;
const refund = { amount: '123.00', currency: 'PLN', productName: 'Pakiet Żółw', transactionId: 'payment-1',
  paymentId: 'pi_payment', refundId: 're_full', totalRefunded: '123.00', refundedAt: '2026-10-28T22:12:00Z' };

it.each(['true', 'false'])('sends the correct refund scope to the provider with masked logging: %s', async isFullRefund => {
  const sendEmail = vi.fn<SendDeps["sendEmail"]>().mockResolvedValue({ ok: true, status: 200 });
  const logging = parseConfig(example).logging;
  logging.defaults.level = 'masked';
  await renderAndSend({ sendEmail, logging, now: () => new Date(), verifyAltcha: vi.fn(), verifyTurnstile: vi.fn() } as SendDeps, {} as Env, brand, getTemplate('refund')!,
    { ...refund, isFullRefund }, { to: ['buyer@example.com'] });
  expect(sendEmail).toHaveBeenCalledOnce();
  const mail = sendEmail.mock.calls[0][1];
  for (const value of [mail.html, mail.text]) {
    expect(value).toContain(`Zakres zwrotu: ${isFullRefund === 'true' ? 'pełny' : 'częściowy'}.`);
    expect(value).toContain('123.00 PLN');
    expect(value).not.toContain('[ukryte]');
  }
});

it.each([true, false, 'true', 'false', '[ukryte]', undefined, '', 'yes'])('renders only a known refund scope: %j', value => {
  const body = getTemplate('refund')!.render(brand, { ...refund, isFullRefund: value } as unknown as TemplateData);
  for (const text of [body.bodyHtml, body.bodyText]) {
    if (value === true || value === 'true') expect(text).toContain('Zakres zwrotu: pełny.');
    else if (value === false || value === 'false') expect(text).toContain('Zakres zwrotu: częściowy.');
    else expect(text).not.toContain('Zakres zwrotu:');
  }
});

it.each([
  ['payment', { amount: '123.00', currency: 'PLN', item: 'Pakiet Żółw', orderId: 'order-1', date: '2026-10-28' }],
  ['refund', { ...refund, isFullRefund: 'true' }],
  ['license', { productName: 'Pakiet Żółw', tier: 'Pro' }],
  ['notice', {}], ['welcome', {}],
] as const)('uses template defaults for %s while retaining private fields as masked', async (id, visible) => {
  const input = structuredClone(example);
  delete (input.logging.defaults as { show?: string[] }).show;
  const logging = parseConfig(input).logging;
  logging.defaults.level = 'masked';
  const { policy } = await resolvePolicy(logging, 'acme', id);
  expect(policy.show).toEqual(Object.keys(visible).length ? expect.arrayContaining(Object.keys(visible)) : []);
  const data = { ...visible, name: 'PRIVATE-NAME', email: 'private@example.com', licenseKey: 'PRIVATE-LICENSE-1234',
    activationUrl: 'https://example.com/private-activation', ctaUrl: 'https://example.com/private-token',
    reason: 'PRIVATE-REASON', paragraphs: 'PRIVATE-BODY', body: 'PRIVATE-BODY', heading: 'PRIVATE-HEADING' };
  const archive = projectArchive({ policy, patterns: [], brand, template: getTemplate(id)!, data });
  if (!archive || archive.level === 'meta') throw Error('Expected content archive');
  for (const output of [archive.html, archive.text]) {
    for (const value of Object.values(visible)) {
      if (value !== 'true') expect(output).toContain(value);
    }
    if (id === 'refund') expect(output).toContain('Zakres zwrotu: pełny.');
    for (const value of ['PRIVATE-NAME', 'private@example.com', 'PRIVATE-LICENSE', 'private-activation', 'private-token', 'PRIVATE-BODY', 'PRIVATE-HEADING', 'PRIVATE-REASON']) expect(output).not.toContain(value);
    expect(output).toContain('[ukryte]');
  }
});

it('lets explicit show lists replace defaults at every configuration layer', async () => {
  for (const show of [[], ['amount'], ['amount', 'currency', 'item', 'orderId', 'date', 'custom']]) {
    for (const layer of ['global', 'brand', 'template']) {
      const input = structuredClone(example);
      delete (input.logging.defaults as { show?: string[] }).show;
      const logging = parseConfig(input).logging;
      if (layer === 'global') logging.defaults.show = show;
      else logging.brands.acme = layer === 'brand' ? { defaults: { show } } : { templates: { payment: { show } } };
      expect((await resolvePolicy(logging, 'acme', 'payment')).policy.show).toEqual(show);
    }
  }
});

it('omits the refund scope when an explicit show list hides it', () => {
  const policy = { ...parseConfig(example).logging.defaults, level: 'masked' as const, show: [] };
  const archive = projectArchive({ policy, patterns: [], brand, template: getTemplate('refund')!, data: { ...refund, isFullRefund: 'true' } });
  if (!archive || archive.level === 'meta') throw Error('Expected content archive');
  for (const output of [archive.html, archive.text]) {
    expect(output).not.toContain('Zakres zwrotu:');
    expect(output).toContain('[ukryte]');
    expect(output).not.toContain('123.00');
  }
});
