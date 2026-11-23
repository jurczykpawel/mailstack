import type { TemplateData, TemplateDef } from '../types.ts';
import { escapeHtml } from './layout.ts';
import { WorkBudget } from './output.ts';
import { encodeValue } from './markdown.ts';
import { rowCells } from './rows.ts';
const parts = (template: TemplateDef, field: string, value: string) =>
  [value, ...(template.rowFields?.includes(field) ? rowCells(value).filter(cell => cell.trim().length >= 3) : [])];
/** Row cells shorter than three characters, which substring matching would also find inside unrelated text. */
export const shortCells = (template: TemplateDef, field: string, value: string) => template.rowFields?.includes(field)
  ? [...new Set(rowCells(value).map(cell => cell.trim()).filter(cell => cell && cell.length < 3))] : [];
/** Forms in which a value can appear in output: raw, row cells, HTML-escaped and percent-encoded. */
export const representations = (template: TemplateDef, field: string, value: string) => [...new Set(parts(template, field, value)
  .flatMap(item => [item, escapeHtml(item), encodeValue(item), escapeHtml(encodeValue(item))]))];
export const normalizeHeader = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
export function secretCandidates(template: TemplateDef, data: TemplateData, budget: WorkBudget): string[] {
  const values = new Set<string>();
  for (const field of [...template.secretFields ?? [], ...template.optionalSecretFields ?? []]) {
    const raw = data[field];
    if (!raw?.trim()) continue;
    budget.spend(raw.length * 5);
    for (const value of parts(template, field, raw).flatMap(item => [item, item.trim(), normalizeHeader(item), normalizeHeader(item.trim()), encodeValue(item.trim())])) {
      values.add(value); const html = escapeHtml(value); values.add(html); values.add(html.replace(/\n/g, '<br>'));
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
export function containsSecret(value: string, candidates: string[], budget: WorkBudget): boolean {
  for (const secret of candidates) { budget.spend(value.length); if (value.includes(secret)) return true; }
  return false;
}
export function effectiveTemplate(template: TemplateDef, secrets: readonly string[] = []): TemplateDef {
  return { ...template, secretFields: [...new Set([...template.secretFields ?? [], ...secrets])] };
}
