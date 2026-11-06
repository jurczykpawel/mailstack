import type { Brand, TemplateData, TemplateDef } from '../types.ts';
import type { TemplatePlans } from './config.ts';
import { own } from './config.ts';
import { normalizeLocale, resolvePresentation } from './locale.ts';
import { Recipe } from './recipe.ts';
import { expandText, renderConfigured } from './blocks.ts';
import { Output } from './output.ts';
import { renderLayout } from './layout.ts';
import { serializeToHead } from '../markup/index.ts';

export function selectKind(brand: Brand, template: string, data: TemplateData): string {
  const forms = brand.mailTemplates?.forms;
  const field = own(forms?.selector.byTemplate, template);
  if (!field) return '';
  const value = (own(data, field) ?? '').trim();
  return value ? own(forms!.selector.values, value) ?? forms!.selector.otherwise : forms!.selector.empty;
}
export function prepareEmail(brand: Brand, template: TemplateDef, original: TemplateData, options: {
  plans: TemplatePlans; locale?: unknown; subject?: string; explicitJsonLd?: import('../types.ts').JsonLdBlock[]; confirmation?: boolean;
}) {
  const formKind = selectKind(brand, template.id, original);
  const localeInput = brand.mailTemplates?.languages ? normalizeLocale(options.locale) : null;
  const { definition, locale } = resolvePresentation(options.plans, brand, template.id, formKind, localeInput);
  const data = options.confirmation ? Object.fromEntries(Object.entries(original).map(([key, value]) =>
    [key, Array.from(value.trim()).slice(0, key === 'name' ? 100 : 200).join('')])) : original;
  const active = ['subject', 'heading', 'previewText', 'body', 'copy', 'labels', 'ctaLabels'].some(key => Object.hasOwn(definition, key));
  const header = (value: Parameters<typeof expandText>[0]) => {
    const content = expandText(value, brand, data, options.plans), sink = new Output(512 * 1024, false); sink.raw(content); return content.join('');
  };
  const dry = new Recipe(definition, brand, data, options.plans, active);
  const recipeSubject = template.subject(brand, data, dry);
  // A replacement body doesn't need the recipe's body serialization.
  const rendered = template.render(brand, data, dry);
  const templateSubject = definition.subject === undefined ? recipeSubject : header(definition.subject);
  const heading = definition.heading === undefined ? template.id === 'contact' && definition.subject !== undefined ? templateSubject : rendered.heading : header(definition.heading);
  const previewText = definition.previewText === undefined ? rendered.previewText : header(definition.previewText);
  if (options.subject && /[\u0000-\u001f\u007f-\u009f]/.test(options.subject)) throw new Error('invalid_subject');
  const subject = options.subject?.trim() || templateSubject.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  if (!subject.trim()) throw new Error('invalid_subject');
  if (!heading.trim()) throw new Error('template_empty_heading');
  const base = locale?.split('-')[0];
  const copy = own(brand.mailTemplates?.languages?.layout, locale ?? '') ?? own(brand.mailTemplates?.languages?.layout, base ?? '')
    ?? (base === 'en' ? { sentBy: 'Sent by', phoneLabel: 'Phone:' } : { sentBy: 'Wysłano przez', phoneLabel: 'tel:' });
  const headHtml = serializeToHead(options.explicitJsonLd ?? rendered.jsonLd ?? []);
  const layout = { subject, heading, previewText, headHtml, locale, layoutCopy: copy };
  let result;
  if (definition.body) result = renderConfigured(brand, definition, options.plans, data, layout);
  else {
    if (active) {
      new Output(998, false).raw(subject);
      if (heading.length > 5000 || (previewText?.length ?? 0) > 5000) throw new RangeError('template_output_limit');
      renderLayout(brand, { ...layout, bodyHtml: out => out.addBytes(dry.htmlOutput.bytes), bodyText: out => out.addBytes(dry.textOutput.bytes) },
        { html: new Output(512 * 1024, false), text: new Output(256 * 1024, false) });
    }
    const body = dry.measuring ? template.render(brand, data, new Recipe(definition, brand, data, options.plans)) : rendered;
    result = renderLayout(brand, { ...body, ...layout });
  }
  return { ...result, subject, heading, previewText, data, formKind, locale, localeInput, definition };
}
