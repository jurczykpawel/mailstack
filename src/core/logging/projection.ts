import { containsSecret, secretCandidates } from "../../templates/privacy.ts";
import { WorkBudget } from "../../templates/output.ts";
import type { Config, Policy } from "../config/schema.ts";
import type { Brand, TemplateData, TemplateDef } from "../../types.ts";
import { escapeHtml, renderLayout } from "../../templates/layout.ts";

export interface ArchiveMetadata {
  clientId?: string;
  status?: string;
  createdAt?: string;
  sentAt?: string;
  providerId?: string;
  render?: { formKind?: string; locale?: string };
  attachments?: { count: number; types: string[]; sizes: number[] };
}
export interface ProjectionInput {
  policy: Policy;
  patterns: Config["logging"]["patterns"];
  brand: Brand;
  template: TemplateDef;
  data: TemplateData;
  subject?: string;
  metadata?: ArchiveMetadata;
  budget?: WorkBudget;
  render?: (data: TemplateData) => { html: string; text: string; subject: string };
}
type Metadata = ArchiveMetadata & { brand: string; template: string };
export type ArchiveProjection = { level: "meta"; metadata: Metadata }
  | { level: "masked" | "full"; metadata: Metadata; subject: string; html: string; text: string };

function maskPatterns(value: string, patterns: ProjectionInput["patterns"], budget: WorkBudget): string {
  for (const pattern of patterns) {
    budget.spend(value.length);
    if ("regex" in pattern) {
      value = value.replace(new RegExp(pattern.regex, "g"), "[ukryte]");
    } else {
      const names = new Set(pattern.urlParams.map((name) => name.toLowerCase()));
      value = value.replace(/([?&](?:amp;)?)([^\s&=<>"']+)=([^\s&<>"']*)/gi, (match, prefix: string, name: string) => {
        try {
          return names.has(decodeURIComponent(name).toLowerCase()) ? `${prefix}${name}=[ukryte]` : match;
        } catch { return match; }
      });
    }
  }
  return value;
}

export function projectArchive(input: ProjectionInput): ArchiveProjection | null {
  const { policy, patterns, brand, template, data } = input;
  if (policy.level === "none") return null;
  const metadata = { ...structuredClone(input.metadata), brand: brand.id, template: template.id };
  if (policy.level === "meta") return { level: "meta", metadata };
  const budget = input.budget ?? new WorkBudget();
  const includeSecrets = policy.level === "full" && policy.includeSecrets;
  const secretFields = new Set([...template.secretFields ?? [], ...template.optionalSecretFields ?? []]);
  const show = new Set(policy.show ?? template.maskedFields ?? []);
  const secretValues = secretCandidates(template, data, budget);
  const partial = (value: string): string => {
    if (!value.trim()) return "";
    budget.spend(value.length * 2);
    const candidate = "••••" + (Array.from(value).length > 4 ? Array.from(value).slice(-4).join("") : "");
    return [candidate, "••••", ""].find(masked => !containsSecret(masked, secretValues, budget) && !containsSecret(escapeHtml(masked), secretValues, budget))!;
  };
  const fields = policy.level === "masked" ? Object.entries(data)
    : [...secretFields].map((field) => [field, data[field] ?? ""] as const);
  const replacements = fields
    .filter(([field, value]) => value && (secretFields.has(field) || policy.level === "masked" && !show.has(field)))
    .flatMap(([field, value]) => (secretFields.has(field) ? secretCandidates({ ...template, secretFields: [field], optionalSecretFields: [] }, data, budget) : [...new Set([value, escapeHtml(value)])]).map((representation) => ({
      representation, replacement: secretFields.has(field) ? partial(value) : "[ukryte]",
      secret: secretFields.has(field), short: !secretFields.has(field) && policy.level === "masked" && Array.from(value).length < 3,
    })));
  if (policy.level === "masked") replacements.sort((a, b) => b.representation.length - a.representation.length);
  const secretReplacements = replacements.filter(({ secret }) => secret);
  const mask = (value: string, html = false, values = replacements): string => {
    if (includeSecrets) return value;
    for (const { representation, replacement, short } of values) {
      budget.spend(value.length);
      const masked = html ? escapeHtml(replacement) : replacement;
      if (short) {
        const literal = representation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        value = value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "gu"), () => masked);
      } else value = value.split(representation).join(masked);
    }
    return maskPatterns(value, patterns, budget);
  };
  const projected = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    !includeSecrets && secretFields.has(key) ? partial(value)
      : policy.level === "masked" && !show.has(key) ? "[ukryte]" : mask(value, false, secretReplacements),
  ]));
  const render = () => {
    if (input.render) return input.render(projected);
    const body = template.render(brand, projected);
    return { ...renderLayout(brand, body), subject: template.subject(brand, projected) };
  };
  const rendered = render();
  const subject = input.subject ?? rendered.subject;
  const post = (value: string, html = false, all = false) => {
    if (includeSecrets) return value;
    if (html) {
      budget.spend(value.length);
      for (const tag of value.matchAll(/<[^>]*>/g)) if (containsSecret(tag[0].replace(/"[^"]*"|'[^']*'/g, ""), secretValues, budget)) return '';
    }
    const result = mask(value, html, all ? replacements : secretReplacements);
    return containsSecret(result, secretValues, budget) ? '' : result;
  };
  return {
    level: policy.level, metadata,
    subject: post(policy.level === "masked" ? subject.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, "[ukryte]") : subject, false, true),
    html: post(rendered.html, true), text: post(rendered.text),
  };
}
