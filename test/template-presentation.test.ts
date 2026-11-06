import { URL } from "node:url";
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema.ts';
import { templatePlans } from '../src/templates/config.ts';
import { prepareEmail } from '../src/templates/prepare.ts';
import { getTemplate } from '../src/templates/index.ts';
const configured = (templates: object = {}, local: object = {}) => parseConfig({ ...structuredClone(example), mailTemplates: { version: 1, templates }, brands: { acme: { ...example.brands.acme, mailTemplates: local } } });
function render(cfg: ReturnType<typeof configured>, id: string, data: Record<string, string> = {}, locale?: string, subject?: string) {
  return prepareEmail(cfg.brands.acme, getTemplate(id)!, data, { plans: templatePlans(cfg), locale, subject });
}
describe('configured template delivery', () => {
  it('preserves complete legacy output for each recipe', () => {
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/templates/legacy.json', import.meta.url), 'utf8'));
    for (const fixture of fixtures.filter((f: { brand: { id: string } }) => f.brand.id !== 'selfware')) {
      const cfg = parseConfig({ ...structuredClone(example), mailTemplates: { version: 1 }, brands: { [fixture.brand.id]: fixture.brand } });
      const result = prepareEmail(fixture.brand, getTemplate(fixture.template)!, fixture.data, { plans: templatePlans(cfg) });
      expect({ subject: result.subject, html: result.html, text: result.text }).toEqual({ subject: fixture.expected.subject.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "), html: fixture.expected.html, text: fixture.expected.text });
    }
  });
  it('keeps branch outputs independent and labels the invoice action', () => {
    const result = render(configured({ payment: { copy: { branchHeading: 'Paid' }, heading: 'Receipt', ctaLabels: { invoice: 'Invoice' }, labels: { amount: 'Total' } } }), 'payment', { amount: '10', orderId: '42', invoiceUrl: 'https://example.com/invoice' });
    expect(result.subject).toBe('Paid - 42'); expect(result.html).toContain('Receipt'); expect(result.html).toContain('Paid: 10 PLN');
    expect(result.text).toContain('Total: 10 PLN'); expect(result.html).toContain('Invoice'); expect(result.html).not.toContain('Pobierz fakturę');
  });
  it('uses configured contact subject as heading before explicit subject', () => {
    const result = render(configured({ contact: { subject: 'Form {name}' } }), 'contact', { name: 'Jane' }, undefined, 'Explicit');
    expect(result.subject).toBe('Explicit'); expect(result.html).toContain('<title>Form Jane</title>');
  });
  it('selects forms on original confirmation data before applying caps', () => {
    const cfg = configured({}, { forms: {
      selector: { byTemplate: { contact: 'type', received: 'summary' }, values: { ['x'.repeat(201)]: 'long' }, empty: 'other', otherwise: 'other' },
      kinds: {
        long: { templates: { received: { heading: 'Long', body: { blocks: [{ id: 'summary', kind: 'paragraph', text: '{summary}' }] } } } },
        other: { templates: {} },
      },
    } });
    const result = prepareEmail(cfg.brands.acme, getTemplate('received')!, { name: ' Jane ', summary: 'x'.repeat(201) }, { plans: templatePlans(cfg), confirmation: true });
    expect(result.formKind).toBe('long'); expect(result.data.summary).toHaveLength(200); expect(result.html).toContain('<title>Long</title>');
  });
  it('uses canonical locale, custom aliases and layout copy', () => {
    const result = render(configured({ contact: { locales: { en: { subject: 'Message', labels: { name: 'Name', 'Imię i nazwisko': 'Full name', phone: 'Phone' }, copy: { messageLabel: 'Message' } } } } }, { languages: { default: 'pl', allowed: ['pl', 'en'] } }), 'contact', { NAME: 'Jane', 'Imię i nazwisko': 'Doe', phone: '123' }, 'EN-us');
    expect(result.html).toContain('lang="en"'); expect(result.text).toContain('Name: Jane'); expect(result.text).toContain('Full name: Doe'); expect(result.text).toContain('Sent by mailstack'); expect(result.html).toContain('https://mailstack.techskills.academy/pl');
  });
  it.each(['', ' ', '\n'])('uses a configured CTA fallback for %j', ctaLabel => {
    for (const id of ['notice', 'welcome']) {
      const result = render(configured({ [id]: { ctaLabels: { main: 'Open page' } } }), id, { ctaUrl: 'https://example.com', ctaLabel });
      expect(result.html).toContain('Open page'); expect(result.text).toContain('Open page: https://example.com');
    }
  });
  it('refuses final empty headers and measures configured expansion', () => {
    expect(() => render(configured({ payment: { heading: '{name}' } }), 'payment')).toThrow('template_empty_heading');
    expect(() => render(configured({ payment: { subject: '{name}' } }), 'payment')).toThrow('invalid_subject');
    const body = { blocks: [{ id: 'p', kind: 'paragraph', text: '{name}'.repeat(128) }] };
    expect(() => render(configured({ payment: { body } }), 'payment', { name: '"'.repeat(5000) })).toThrow('template_output_limit');
  });
  it('normalizes generated headers and refuses explicit control characters', () => {
    expect(render(configured(), 'payment', { orderId: 'a\r\nb' }).subject).toBe('Potwierdzenie płatności - a b');
    expect(() => render(configured(), 'payment', {}, undefined, 'a\nb')).toThrow('invalid_subject');
  });
});

it('escapes a configured reference label once', () => {
  const result = render(configured({ received: { copy: { refLabel: '<Ref & id>' } } }), 'received', { refId: '<42>' });
  expect(result.html).toContain('&lt;Ref &amp; id&gt;: <strong>&lt;42&gt;</strong>');
  expect(result.text).toContain('<Ref & id>: <42>');
});
it('replaces notice parsing with the configured body', () => {
  const result = render(configured({ notice: { body: { blocks: [{ id: 'p', kind: 'paragraph', text: 'Configured' }] } } }), 'notice', { heading: 'Heading', paragraphs: '## Legacy\n\nOld paragraph' });
  expect(result.html).toContain('Configured'); expect(result.html).not.toContain('Legacy');
});
it('uses every recipe slot on its corresponding branch', () => {
  const cases: [string, Record<string, string>, string[]][] = [
    ['received', { name: 'Jane', refId: '42', summary: 'Summary' }, ['greetingWithName', 'intro', 'refLabel']],
    ['received', {}, ['greetingWithoutName', 'intro']],
    ['welcome', { name: 'Jane' }, ['headingWithName']], ['welcome', {}, ['headingWithoutName']],
    ['payment', { name: 'Jane' }, ['branchHeading', 'greetingWithName', 'intro']],
    ['payment', { settledVia: 'bank_transfer' }, ['transferHeading', 'transferIntro', 'greetingWithoutName']],
    ['license', { name: 'Jane', licenseKey: '123' }, ['branchHeading', 'intro', 'greetingWithName', 'keyLabel', 'preview']],
    ['license', {}, ['greetingWithoutName']],
    ['notice', {}, ['fallbackHeading', 'fallbackSubject']],
    ['refund', { isFullRefund: 'true', reason: 'Reason' }, ['branchHeading', 'amount', 'transaction', 'payment', 'refund', 'status', 'scopeFull', 'total', 'date', 'reason']],
    ['refund', { isFullRefund: 'false' }, ['scopePartial']],
    ['bank-transfer', {}, ['branchHeading', 'intro']],
    ['bank-transfer', { reminder: 'true' }, ['reminderHeading', 'reminderIntro']],
    ['contact', { message: 'Message' }, ['messageLabel', 'receivedAtLabel', 'originLabel', 'ipLabel']],
  ];
  for (const [id, data, slots] of cases) {
    const copy = Object.fromEntries(slots.map(slot => [slot, `Slot-${slot}`]));
    const result = render(configured({ [id]: { copy } }), id, data);
    for (const slot of slots) expect(result.html + result.text + result.subject, `${id}/${slot}`).toContain(`Slot-${slot}`);
  }
});

it.each(['  VALUE-123456  ', 'A\nB'])('checks the complete header representation for %j', licenseKey => {
  const cfg = configured();
  expect(() => render(cfg, 'license', { licenseKey, productName: licenseKey.trim().replace(/\n/g, ' ') })).toThrow('template_sensitive_header');
});
it('keeps the chosen form and language in a masked projection', async () => {
  const { projectArchive } = await import('../src/core/logging/projection.ts');
  const cfg = configured({}, { languages: { default: 'pl', allowed: ['pl', 'en'] }, forms: {
    selector: { byTemplate: { contact: 'type' }, values: { Question: 'question' }, empty: 'other', otherwise: 'other' },
    kinds: { question: { templates: { contact: { locales: { en: { heading: 'Question EN' } } } } }, other: { templates: { contact: { locales: { en: { heading: 'Other EN' } } } } } },
  } });
  const plans = templatePlans(cfg), brand = cfg.brands.acme, template = getTemplate('contact')!, data = { type: 'Question', name: 'Jane' };
  const prepared = prepareEmail(brand, template, data, { plans, locale: 'en' });
  const archive = projectArchive({ policy: { ...cfg.logging.defaults, level: 'masked', show: [] }, patterns: [], brand, template: prepared.template, data,
    metadata: { render: { formKind: prepared.formKind, locale: prepared.locale! } },
    render: projected => prepareEmail(brand, template, projected, { plans, selected: prepared, projection: true, explicitJsonLd: [] }),
  });
  expect(archive).toMatchObject({ metadata: { render: { formKind: 'question', locale: 'en' } } });
  if (!archive || archive.level === 'meta') throw Error('missing content');
  expect(archive.html).toContain('<title>Question EN</title>'); expect(archive.html).toContain('lang="en"'); expect(archive.html).not.toContain('Other EN');
});
