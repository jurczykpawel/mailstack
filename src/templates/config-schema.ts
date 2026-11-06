import { z } from "zod";
import { normalizeLocale } from "./language-tag.ts";
import { MANIFEST } from "./manifest.ts";

export const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);
const field = z.string().min(1).max(128).refine(v => safeKey(v) && !/[.{}\u0000-\u001f\u007f-\u009f]/.test(v));
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(safeKey);
const plain = z.string().refine(v => !/\{[^{}]*\}/.test(v) && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(v));
const label = plain.max(160).refine(v => !/[\n\t]/.test(v));

const language = z.string().transform((v, ctx) => {
  const tag = normalizeLocale(v);
  if (tag === null) { ctx.addIssue({ code: "custom", message: "invalid language tag" }); return z.NEVER; }
  return tag;
});
const map = <T extends z.ZodType>(key: z.ZodString, value: T) => z.record(key, value);
export const locales = <T extends z.ZodType>(value: T) => map(z.string(), value).transform((v, ctx) => {
  const result: Record<string, z.output<T>> = {};
  for (const [key, patch] of Object.entries(v)) {
    const tag = normalizeLocale(key);
    if (!tag || Object.hasOwn(result, tag)) ctx.addIssue({ code: "custom", path: [key], message: "invalid or repeated language tag" });
    else result[tag] = patch;
  }
  return result;
});
const templateString = z.string().max(5000).refine(v => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(v) &&
  !/[{}]/.test(v.replace(/\{[^{}]+\}/g, "")));
const fragment = z.strictObject({ field: z.string(), prefix: plain.optional(), suffix: plain.optional(), empty: plain.optional() });
const text = z.union([templateString, z.array(z.union([templateString, fragment])).min(1).max(24)])
  .refine(v => (typeof v === "string" ? v.length : v.reduce((n, part) => n + (typeof part === "string" ? part.length :
    part.field.length + 2 + (part.prefix?.length ?? 0) + (part.suffix?.length ?? 0) + (part.empty?.length ?? 0)), 0)) <= 5000);
const reference = z.string().min(1).max(128);
export const httpUrl = (value: string) => {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f-\u009f]/.test(value) || new TextEncoder().encode(value).length > 2048) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
};
const block = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("paragraph"), text }),
  z.strictObject({ id, kind: z.literal("fieldTable"), rows: z.array(z.strictObject({ field: reference, label: label.optional() })).max(43).optional(),
    allFields: z.literal(true).optional(), exclude: z.array(field).max(43).optional(), includeMeta: z.boolean().optional(), textStyle: z.enum(["inline", "stacked"]).optional() }),
  z.strictObject({ id, kind: z.literal("message"), field: reference, label: label.optional() }),
  z.strictObject({ id, kind: z.literal("metadata"), items: z.array(z.enum(["receivedAt", "origin", "ip"])) }),
  z.strictObject({ id, kind: z.literal("cta"), url: z.union([z.strictObject({ literal: z.string().refine(httpUrl) }), z.strictObject({ field: reference })]), label: label.refine(v => !!v.trim()) }),
  z.strictObject({ id, kind: z.literal("code"), field: reference, label: label.optional() }),
]);
const body = z.strictObject({ blocks: z.array(block).max(24), htmlJoin: z.enum(["", "\n"]).optional(), textJoin: z.enum(["\n", "\n\n"]).optional() });
const presentationShape = { subject: text.optional(), heading: text.optional(), previewText: text.optional(),
  copy: map(field, text).optional(), labels: map(field, label).optional(), ctaLabels: map(field, label.refine(v => !!v.trim())).optional(), body: body.optional() };
const presentation = z.strictObject(presentationShape);
const localizedPresentation = presentation.extend({ locales: locales(presentation).optional() });
const template = localizedPresentation.extend({ fields: map(field, z.strictObject({ kind: z.enum(["text", "email", "url"]) })).optional(), secretFields: z.array(field).max(43).optional() });
const templateId = z.string().refine(key => Object.hasOwn(MANIFEST, key));
const common = z.strictObject({ copy: map(field, text).optional(), labels: map(field, label).optional() });
export const mailTemplatesSchema = z.strictObject({ version: z.literal(1), defaults: common.optional(), templates: map(templateId, template).optional() });
export const brandMailTemplatesSchema = z.strictObject({ defaults: common.optional(), templates: map(templateId, template).optional(),
  languages: z.strictObject({ default: language, allowed: z.array(language).min(1).max(8),
    layout: locales(z.strictObject({ sentBy: label, phoneLabel: label })).optional() }).optional(),
  forms: z.strictObject({ selector: z.strictObject({ byTemplate: map(templateId, field), values: map(z.string().min(1).refine(v => safeKey(v) && v.trim() === v), id), empty: id, otherwise: id }),
    kinds: map(id, z.strictObject({ templates: map(templateId, localizedPresentation) })) }).optional(),
});
export type Presentation = z.infer<typeof presentation>;
export type TemplatePatch = z.infer<typeof template>;
export type BrandMailTemplates = z.infer<typeof brandMailTemplatesSchema>;
