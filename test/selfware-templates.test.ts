import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTemplate } from '../src/templates/index';
import { getBrand } from '../src/core/config';
import { templatePlans } from '../src/templates/config';
import { prepareEmail } from '../src/templates/prepare';
import { escapeHtml } from '../src/templates/layout';
import { formConfig } from './fixtures/form-config';
import type { Brand, TemplateData } from '../src/types';
const brand = { ...getBrand('acme')!, id: 'selfware', name: 'Selfware', subjectPrefix: 'Nowe zlecenie' };
const fixtures = JSON.parse(readFileSync('test/fixtures/templates/legacy.json', 'utf8')) as { id: string; brand: Brand; template: string; data: TemplateData; expected: { subject: string; html: string; text: string } }[];
const configured = (brand: Brand, template: string, data: TemplateData, confirmation = false) => {
  const cfg = formConfig(brand); return prepareEmail(cfg.brands[brand.id], getTemplate(template)!, data, { plans: templatePlans(cfg), confirmation });
};
describe('configured form presentation', () => {
  it('uses the ordinary recipe for an id without configured presentation', () => {
    expect(getTemplate('received')!.subject(brand, {})).toBe('Potwierdzenie: otrzymaliśmy Twoje zgłoszenie');
    expect(getTemplate('received')!.render(brand, {}).bodyText).toContain('odezwiemy się wkrótce');
  });
  for (const f of fixtures.filter(f => f.brand.id === 'selfware')) it(f.id, () => {
    if (f.id.endsWith('unicode-5000')) { expect(() => configured(f.brand, f.template, f.data)).toThrow('template_output_limit'); return; }
    const mail = configured(f.brand, f.template, f.data);
    expect({ subject: mail.subject, html: mail.html, text: mail.text }).toEqual({ subject: f.expected.subject, html: f.expected.html, text: f.expected.text });
  });
  it('applies the same presentation to any registry id', () => {
    for (const f of fixtures.filter(f => f.brand.id === 'selfware' && f.template === 'contact')) {
      const mail = configured({ ...f.brand, id: 'demo-form' }, f.template, f.data);
      expect(mail.html).toBe(f.expected.html); expect(mail.text).toBe(f.expected.text);
    }
  });
  it('caps confirmation input against the recorded long output', () => {
    const f = fixtures.find(f => f.id === 'selfware/received/unicode-5000')!;
    const pairs = Object.entries(f.data).map(([key, value]) => [value.trim(), Array.from(value.trim()).slice(0, key === 'name' ? 100 : 200).join('')]);
    const shorten = (value: string, html: boolean) => pairs.reduce((text, [from, to]) => text.replaceAll(html ? escapeHtml(from) : from, html ? escapeHtml(to) : to), value);
    const mail = configured(f.brand, f.template, f.data, true);
    expect(mail.html).toBe(shorten(f.expected.html, true)); expect(mail.text).toBe(shorten(f.expected.text, false));
  });
});
