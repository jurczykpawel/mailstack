import type { Config, Policy } from "../config/schema.ts";
import type { Brand, TemplateData, TemplateDef } from "../../types.ts";
import { escapeHtml, renderLayout } from "../../templates/layout.ts";

export interface ArchiveMetadata {
  clientId?: string;
  status?: string;
  createdAt?: string;
  sentAt?: string;
  providerId?: string;
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
}
type Metadata = ArchiveMetadata & { brand: string; template: string };
export type ArchiveProjection = { level: "meta"; metadata: Metadata }
  | { level: "masked" | "full"; metadata: Metadata; subject: string; html: string; text: string };

function maskPatterns(value: string, patterns: ProjectionInput["patterns"]): string {
  for (const pattern of patterns) {
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
  const includeSecrets = policy.level === "full" && policy.includeSecrets;
  const secretFields = new Set(template.secretFields);
  const show = new Set(policy.show);
  const partial = (value: string) => "••••" + Array.from(value).slice(-4).join("");
  const fields = policy.level === "masked" ? Object.entries(data)
    : [...secretFields].map((field) => [field, data[field] ?? ""] as const);
  const replacements = fields
    .filter(([field, value]) => value && (secretFields.has(field) || policy.level === "masked" && !show.has(field)))
    .flatMap(([field, value]) => [...new Set([value, escapeHtml(value)])].map((representation) => ({
      representation, replacement: secretFields.has(field) ? partial(value) : "[ukryte]",
      secret: secretFields.has(field), short: policy.level === "masked" && Array.from(value).length < 3,
    })));
  if (policy.level === "masked") replacements.sort((a, b) => b.representation.length - a.representation.length);
  const secretReplacements = replacements.filter(({ secret }) => secret);
  const mask = (value: string, html = false, values = replacements): string => {
    if (includeSecrets) return value;
    for (const { representation, replacement, short } of values) {
      const masked = html ? escapeHtml(replacement) : replacement;
      if (short) {
        const literal = representation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        value = value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "gu"), () => masked);
      } else value = value.split(representation).join(masked);
    }
    return maskPatterns(value, patterns);
  };
  const projected = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    !includeSecrets && secretFields.has(key) ? partial(value)
      : policy.level === "masked" && !show.has(key) ? "[ukryte]" : mask(value, false, secretReplacements),
  ]));
  const body = template.render(brand, projected);
  const rendered = renderLayout(brand, {
    heading: body.heading, bodyHtml: body.bodyHtml, bodyText: body.bodyText, previewText: body.previewText,
  });
  const subject = input.subject ?? template.subject(brand, projected);
  return {
    level: policy.level, metadata,
    subject: mask(policy.level === "masked" ? subject.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, "[ukryte]") : subject),
    html: (policy.level === "masked" ? maskPatterns(rendered.html, patterns) : mask(rendered.html, true))
      .replace(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi, ""),
    text: policy.level === "masked" ? maskPatterns(rendered.text, patterns) : mask(rendered.text),
  };
}
