import type { Config, TemplatePolicies } from "../core/config/schema.ts";
import type { Brand, TemplateData, TemplateDef } from "../types.ts";
import type { CustomVariantDefinition, Presentation } from "./config-schema.ts";
import { own, type TemplatePlans } from "./config.ts";
import { expandText } from "./blocks.ts";
import { compileMarkdown, renderMarkdown, type MarkdownPlan } from "./markdown.ts";
import { MANIFEST } from "./manifest.ts";
import { textFields } from "./tokens.ts";

type Text = Presentation["subject"];
type Path = (string | number)[];
export type Body = { markdown: MarkdownPlan };
interface Variant { subject?: Text; heading?: Text; previewText?: Text; body?: Body }
export interface CustomPlan extends Variant {
  subject: Text; heading: Text; body: Body; secretFields: string[]; requiredFields: string[]; rowFields: string[];
  layout?: "none"; locales: Record<string, Variant>;
}
const HEADERS = ["subject", "heading", "previewText"] as const;

function sections(config: Config) {
  return [["", config.mailTemplates?.custom, ["mailTemplates", "custom"]] as const,
    ...Object.entries(config.brands).map(([id, brand]) => [id, brand.mailTemplates?.custom, ["brands", id, "mailTemplates", "custom"]] as const)];
}
/** Secret and required fields of named templates, for source and policy validation. */
export function customPolicies(config: Config): TemplatePolicies {
  const result: TemplatePolicies = {};
  for (const [, custom] of sections(config)) for (const [id, definition] of Object.entries(custom ?? {})) {
    const known = result[id] ??= {};
    known.secretFields = [...new Set([...known.secretFields ?? [], ...definition.secretFields ?? []])];
    known.requiredFields = [...new Set([...known.requiredFields ?? [], ...definition.requiredFields ?? []])];
  }
  return result;
}

function compileBody(value: CustomVariantDefinition, secrets: string[], path: Path, fail: (path: Path, message: string) => void): Body | undefined {
  if ((value.markdown === undefined) === (value.html === undefined)) { fail(path, "markdown or html required"); return undefined; }
  try {
    const plan = compileMarkdown(value.markdown!);
    if (value.text !== undefined) fail([...path, "text"], "text requires html");
    if (plan.partialUrlFields.some(field => secrets.includes(field))) fail(path, "secret field inside URL");
    return { markdown: plan };
  } catch (error) { fail([...path, "markdown"], error instanceof Error ? error.message : "invalid body"); return undefined; }
}

export function compileCustom(config: Config, fail: (path: Path, message: string) => void): Record<string, Record<string, CustomPlan>> {
  const result: Record<string, Record<string, CustomPlan>> = {};
  for (const [owner, custom, root] of sections(config)) if (custom) {
    result[owner] = {};
    for (const [id, definition] of Object.entries(custom)) {
      const path = [...root, id];
      if (Object.hasOwn(MANIFEST, id)) { fail(path, "built-in template name"); continue; }
      const secrets = definition.secretFields ?? [];
      const rowFields = Object.entries(definition.fields ?? {}).filter(([, field]) => field.kind === "rows").map(([key]) => key);
      if (definition.layout && definition.markdown !== undefined) fail([...path, "layout"], "layout none requires html");
      const variant = (value: CustomVariantDefinition, at: Path, required: boolean): Variant => {
        const headers: Variant = {};
        for (const key of HEADERS) if (value[key] !== undefined) {
          headers[key] = value[key];
          if (textFields(value[key]).some(field => secrets.includes(field) || rowFields.includes(field))) fail([...at, key], "invalid header field");
        }
        if (value.subject !== undefined && !textFields(value.subject).length && !(typeof value.subject === "string" ? [value.subject] : value.subject)
          .some(part => typeof part === "string" && part.trim())) fail([...at, "subject"], "empty output");
        const body = required || value.markdown !== undefined || value.html !== undefined ? compileBody(value, secrets, at, fail) : undefined;
        return { ...headers, ...(body ? { body } : {}) };
      };
      const base = variant(definition, path, true);
      const locales = Object.fromEntries(Object.entries(definition.locales ?? {}).map(([tag, value]) => [tag, variant(value, [...path, "locales", tag], false)]));
      result[owner][id] = { ...base, subject: definition.subject, heading: definition.heading, body: base.body!, secretFields: secrets,
        requiredFields: definition.requiredFields ?? [], rowFields, ...(definition.layout ? { layout: definition.layout } : {}), locales };
    }
  }
  return result;
}

export const customPlan = (plans: TemplatePlans | undefined, brand: string | undefined, id: string): CustomPlan | undefined =>
  own(own(plans?.custom, brand ?? ""), id) ?? own(own(plans?.custom, ""), id);

export function renderBody(body: Body, brand: Brand, data: TemplateData): { html: string; text: string } {
  return renderMarkdown(body.markdown, brand, data);
}

const definitions = new WeakMap<CustomPlan, TemplateDef>();
export function customTemplate(id: string, plan: CustomPlan, plans: TemplatePlans): TemplateDef {
  let definition = definitions.get(plan);
  if (definition) return definition;
  const variant = (locale?: string | null): CustomPlan => ({ ...plan, ...own(plan.locales, locale ?? "") });
  const text = (value: Text, brand: Brand, data: TemplateData) => expandText(value, brand, data, plans).join("");
  definition = {
    id, secretFields: plan.secretFields, requiredFields: plan.requiredFields, rowFields: plan.rowFields,
    subject: (brand, data, recipe) => text(variant(recipe?.locale).subject, brand, data),
    render: (brand, data, recipe) => {
      const selected = variant(recipe?.locale), body = renderBody(selected.body, brand, data);
      return { heading: text(selected.heading, brand, data), bodyHtml: body.html, bodyText: body.text, ...(plan.layout ? { document: true as const } : {}),
        ...(selected.previewText !== undefined ? { previewText: text(selected.previewText, brand, data) } : {}) };
    },
  };
  definitions.set(plan, definition);
  return definition;
}
