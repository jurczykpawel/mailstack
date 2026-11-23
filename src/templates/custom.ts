import type { Config, TemplatePolicies } from "../core/config/schema.ts";
import type { Brand, TemplateData, TemplateDef } from "../types.ts";
import type { CustomVariantDefinition, Presentation } from "./config-schema.ts";
import { own, type TemplatePlans } from "./config.ts";
import { expandText } from "./blocks.ts";
import { compileMarkdown, fieldNames, fill, renderMarkdown, type MarkdownPlan } from "./markdown.ts";
import { compileHtml, renderHtml, renderHtmlText, type HtmlPlan } from "./html.ts";
import { MANIFEST } from "./manifest.ts";
import { textFields } from "./tokens.ts";
import { utf8Size } from "./output.ts";

type Text = Presentation["subject"];
type Path = (string | number)[];
export type Body = { markdown: MarkdownPlan } | { html: HtmlPlan; text?: string };
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

function compileBody(value: CustomVariantDefinition, secrets: string[], document: boolean, path: Path, fail: (path: Path, message: string) => void): Body | undefined {
  if ((value.markdown === undefined) === (value.html === undefined)) { fail(path, "markdown or html required"); return undefined; }
  if (value.html !== undefined) {
    try { return { html: compileHtml(value.html, { document, secrets }), ...(value.text !== undefined ? { text: value.text } : {}) }; }
    catch (error) { fail([...path, "html"], error instanceof Error ? error.message : "invalid body"); return undefined; }
  }
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
      const languages = owner ? config.brands[owner].mailTemplates?.languages : undefined;
      const variant = (value: CustomVariantDefinition, at: Path, required: boolean): Variant => {
        const headers: Variant = {};
        for (const key of HEADERS) if (value[key] !== undefined) {
          headers[key] = value[key];
          if (textFields(value[key]).some(field => secrets.includes(field) || rowFields.includes(field))) fail([...at, key], "invalid header field");
        }
        if (value.subject !== undefined && !textFields(value.subject).length && !(typeof value.subject === "string" ? [value.subject] : value.subject)
          .some(part => typeof part === "string" && part.trim())) fail([...at, "subject"], "empty output");
        if (definition.layout && value.markdown !== undefined) fail([...at, "layout"], "layout none requires html");
        const body = required || value.markdown !== undefined || value.html !== undefined ? compileBody(value, secrets, !!definition.layout, at, fail) : undefined;
        return { ...headers, ...(body ? { body } : {}) };
      };
      const base = variant(definition, path, true);
      const locales = Object.fromEntries(Object.entries(definition.locales ?? {}).map(([tag, value]) => {
        if (owner && (!languages?.allowed.includes(tag) || tag === languages.default)) fail([...path, "locales", tag], "invalid brand locale");
        return [tag, variant(value, [...path, "locales", tag], false)];
      }));
      result[owner][id] = { ...base, subject: definition.subject, heading: definition.heading, body: base.body!, secretFields: secrets,
        requiredFields: definition.requiredFields ?? [], rowFields, ...(definition.layout ? { layout: definition.layout } : {}), locales };
    }
  }
  for (const [brandId, brand] of Object.entries(config.brands)) {
    const id = brand.autoReplyTemplate;
    if (id === undefined || Object.hasOwn(MANIFEST, id)) continue;
    const owner = own(result[brandId], id) ? brandId : "", plan = own(result[owner], id);
    if (!plan) { fail(["brands", brandId, "autoReplyTemplate"], "unknown confirmation template"); continue; }
    const variants = [plan, ...Object.values(plan.locales)];
    const used = variants.flatMap(item => [...HEADERS.flatMap(key => textFields(item[key])), ...item.body ? Object.values(item.body).flatMap(body => typeof body === "string" ? fieldNames(body) : body.fields) : []]);
    const urls = variants.flatMap(item => item.body ? Object.values(item.body).flatMap(body => [...body.urlFields ?? [], ...body.partialUrlFields ?? []]) : []);
    if (urls.length || used.some(field => !["name", "summary", "brand.id", "brand.name", "brand.subjectPrefix"].includes(field)))
      fail([...(owner ? ["brands", owner, "mailTemplates"] : ["mailTemplates"]), "custom", id], "confirmation field unavailable");
  }
  return result;
}

export const customPlan = (plans: TemplatePlans | undefined, brand: string | undefined, id: string): CustomPlan | undefined =>
  own(own(plans?.custom, brand ?? ""), id) ?? own(own(plans?.custom, ""), id);

export function renderBody(body: Body, brand: Brand, data: TemplateData): { html: string; text: string } {
  if ("markdown" in body) return renderMarkdown(body.markdown, brand, data);
  return { html: renderHtml(body.html, data, brand), text: body.text !== undefined ? fill(body.text, brand, data) : renderHtmlText(body.html, data, brand) };
}

export interface RequestContent { raw: Record<string, string>; body: Body }
const MAX_CONTENT_BYTES = 16 * 1024;
/** Validates trusted request `content` ({markdown} or {html, text?}) and compiles it with the same allow list. */
export function requestContent(value: unknown): RequestContent | { status: number; code: string } {
  const invalid = { status: 422, code: "content_invalid" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw);
  if (keys.some(key => !["markdown", "html", "text"].includes(key) || typeof raw[key] !== "string") || keys.includes("markdown") === keys.includes("html") ||
    keys.includes("markdown") && keys.includes("text")) return invalid;
  const content = raw as Record<string, string>;
  if (Object.values(content).some(text => utf8Size(text) > MAX_CONTENT_BYTES)) return { status: 413, code: "content_too_large" };
  // Dense delimiter or quote runs make Markdown parsing quadratic; ordinary prose stays far below these counts.
  const counts = content.markdown?.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map(block => block.match(/[*_~`[>]/g)?.length ?? 0) ?? [];
  if (counts.some(count => count > 128) || counts.reduce((sum, count) => sum + count, 0) > 2048) return invalid;
  try {
    return { raw: content, body: content.markdown !== undefined ? { markdown: compileMarkdown(content.markdown, false) }
      : { html: compileHtml(content.html), ...(content.text !== undefined ? { text: content.text } : {}) } };
  } catch { return invalid; }
}
let placeholder: Body | undefined;
/** Archived instead of request content below the full logging level. */
export const contentPlaceholder = () => placeholder ??= { markdown: compileMarkdown("\\[treść z żądania ukryta\\]") };

const definitions = new WeakMap<CustomPlan, TemplateDef>();
export function customTemplate(id: string, plan: CustomPlan, plans: TemplatePlans): TemplateDef {
  let definition = definitions.get(plan);
  if (definition) return definition;
  const variant = (locale?: string | null): CustomPlan => ({ ...plan, ...own(plan.locales, locale?.split("-")[0] ?? ""), ...own(plan.locales, locale ?? "") });
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
