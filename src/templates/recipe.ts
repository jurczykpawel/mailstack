import type { Brand, TemplateData } from '../types.ts';
import type { TemplatePatch } from './config-schema.ts';
import type { TemplatePlans } from './config.ts';
import { own } from './config.ts';
import { expandText } from './blocks.ts';
import { Output, type Emit } from './output.ts';
import * as layout from './layout.ts';

const EN_CTA: Record<string, string> = { notice: "Learn more", welcome: "Get started" };

export class Recipe {
  locale: string | null; templateId?: string;
  htmlOutput: Output;
  textOutput: Output;
  patch: TemplatePatch; brand?: Brand; data: TemplateData; plans?: TemplatePlans; measuring: boolean;
  constructor(patch: TemplatePatch = {}, brand?: Brand, data: TemplateData = {}, plans?: TemplatePlans, measuring = false, locale: string | null = null, templateId?: string) {
    this.locale = locale; this.templateId = templateId;
    this.patch = patch; this.brand = brand; this.data = data; this.plans = plans; this.measuring = measuring;
    this.htmlOutput = new Output(512 * 1024, !measuring); this.textOutput = new Output(256 * 1024, !measuring);
  }
  copy(key: string, fallback: string): string {
    const value = own(this.patch.copy, key);
    if (value === undefined) return fallback;
    const content = expandText(value, this.brand!, this.data, this.plans!);
    const output = new Output(256 * 1024, false); output.raw(content);
    return content.join('');
  }
  label(key: string, fallback = layout.humanizeLabel(key, this.locale)): string {
    return layout.labelFor(this.patch.labels, key, fallback);
  }
  cta(key: string, fallback: string, supplied?: string): string {
    const english = this.locale?.split('-')[0] === 'en' && key === 'main' ? EN_CTA[this.templateId ?? ''] : undefined;
    return supplied?.trim() || own(this.patch.ctaLabels, key) || english || (supplied === undefined || !supplied ? fallback : 'Otwórz');
  }
  paragraph = (value: string) => { if (this.patch.body) return ""; if (!this.measuring) return layout.paragraph(value); layout.emitParagraph(value, this.htmlOutput); return ''; };
  table = (rows: { label: string; value: string }[]) => this.patch.body ? "" : layout.summaryTable(rows, this.measuring ? this.htmlOutput : undefined);
  code = (value: string) => this.patch.body ? "" : layout.codeBox(value, this.measuring ? this.htmlOutput : undefined);
  message = (value: string, label: string) => this.patch.body ? "" : layout.messageBlock(value, label, this.measuring ? this.htmlOutput : undefined);
  metadata = (items: { label: string; value: string }[]) => this.patch.body ? "" : layout.metadataBlock(items, this.measuring ? this.htmlOutput : undefined);
  button = (brand: Brand, url: string, label: string) => this.patch.body ? "" : layout.ctaButton(brand, url, label, this.measuring ? this.htmlOutput : undefined);
  combine(values: string[], separator: string) {
    const sink = new Output(256 * 1024, false);
    values.forEach((value, i) => { if (i) sink.raw(separator); sink.raw(value); }); return values.join(separator);
  }
  html(values: (string | Emit)[], separator = '\n') { if (this.patch.body) return ''; return this.join(values, separator, this.htmlOutput); }
  text(values: string[], separator = '\n\n') { if (this.patch.body) return ''; return this.join(values, separator, this.textOutput); }
  private join(values: (string | Emit)[], separator: string, sink: Output) {
    const output = this.measuring ? sink : new Output();
    values.forEach((value, i) => { if (i) output.raw(separator); if (typeof value === 'function') value(output); else output.raw(value); });
    return output.result();
  }
}
