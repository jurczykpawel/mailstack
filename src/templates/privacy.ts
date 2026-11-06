import type { TemplateData, TemplateDef } from '../types.ts';
import { escapeHtml } from './layout.ts';
import { WorkBudget } from './output.ts';
export const normalizeHeader = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
export function secretCandidates(template: TemplateDef, data: TemplateData, budget: WorkBudget): string[] {
  const values = new Set<string>();
  for (const field of [...template.secretFields ?? [], ...template.optionalSecretFields ?? []]) {
    const raw = data[field];
    if (!raw?.trim()) continue;
    budget.spend(raw.length * 4);
    for (const value of [raw, raw.trim(), normalizeHeader(raw), normalizeHeader(raw.trim())]) {
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
