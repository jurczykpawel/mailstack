import { tokenize, type Token } from "./tokens.ts";
import type { Config } from "../core/config/schema.ts";
import { TEMPLATES } from "./index.ts";
import { COMMON_SLOTS, CONTEXT_FIELDS, HEADER_FIELDS, MANIFEST, type TemplateId } from "./manifest.ts";
import { safeKey, type Presentation, type TemplatePatch } from "./config-schema.ts";

type Path = (string | number)[];
type Layer = { patch: TemplatePatch; path: Path };
export interface TemplatePlans {
  fragments: TemplatePatch[];
  texts: Record<string, Token[]>;
  routes: Record<string, Record<string, Record<string, Record<string, number[]>>>>;
  warnings: string[];
}
const HEADER_SLOTS: Partial<Record<TemplateId, Record<string, string[]>>> = {
  welcome: { heading: ["headingWithName", "headingWithoutName"] },
  payment: { subject: ["branchHeading", "transferHeading"], heading: ["branchHeading", "transferHeading"], previewText: ["branchHeading", "transferHeading"] },
  license: { subject: ["branchHeading"], heading: ["branchHeading"], previewText: ["preview"] },
  notice: { subject: ["fallbackSubject", "fallbackHeading"], heading: ["fallbackHeading"], previewText: ["fallbackHeading"] },
  refund: { subject: ["branchHeading"], heading: ["branchHeading"], previewText: ["branchHeading"] },
  "bank-transfer": { subject: ["branchHeading", "reminderHeading"], heading: ["branchHeading", "reminderHeading"], previewText: ["branchHeading", "reminderHeading"] },
};
type Fail = (path: Path, message: string) => void;
const cache = new WeakMap<Config, TemplatePlans>();
export function freezePlans<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePlans(child);
    Object.freeze(value);
  }
  return value;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => map && Object.hasOwn(map, key) ? map[key] : undefined;
const refs = (value: Presentation["subject"]): string[] => value === undefined ? [] : (typeof value === "string" ? [value] : value)
  .flatMap(part => typeof part === "string" ? tokenize(part).flatMap(token => typeof token === "string" ? [] : [token.field]) : [part.field]);
const dictionaries = ["copy", "labels", "ctaLabels", "fields"] as const;
export function mergeDefinitions(layers: TemplatePatch[]): TemplatePatch {
  const result: TemplatePatch = {};
  for (const { locales: _locales, ...patch } of layers) for (const key of Object.keys(patch) as (keyof Omit<TemplatePatch, "locales">)[]) {
    const value = dictionaries.includes(key as typeof dictionaries[number]) ? { ...result[key] as object, ...patch[key] as object }
      : key === "secretFields" ? [...new Set([...result.secretFields ?? [], ...patch.secretFields ?? []])] : patch[key];
    Object.assign(result, { [key]: value });
  }
  return result;
}
export function definition(plans: TemplatePlans, brand: string, template: string, kind = "", locale = ""): TemplatePatch {
  const indices = own(own(own(own(plans.routes, brand), template), kind), locale);
  if (!indices) throw new Error("unknown template combination");
  return mergeDefinitions(indices.map(index => plans.fragments[index]));
}
function checkPatch(id: TemplateId, patch: TemplatePatch, fields: NonNullable<TemplatePatch["fields"]>, secrets: string[], eligible: boolean, confirmation: boolean, path: Path, fail: Fail) {
  const manifest = MANIFEST[id];
  const checkRefs = (values: string[], at: Path, header = false) => {
    if (values.some(key => !CONTEXT_FIELDS.includes(key) && (!Object.hasOwn(fields, key) || !safeKey(key)) || header && secrets.includes(key))) fail(at, "invalid field reference");
    if (confirmation && values.some(key => ![...CONTEXT_FIELDS, "name", "summary"].includes(key))) fail(at, "confirmation field unavailable");
  };
  for (const key of ["subject", "heading", "previewText"] as const) if (patch[key] !== undefined) {
    checkRefs(refs(patch[key]), [...path, key], true);
    const parts = typeof patch[key] === "string" ? [patch[key]] : patch[key]!;
    if (key !== "previewText" && !refs(patch[key]).length && !parts.some(part => typeof part === "string" && part.trim())) fail([...path, key], "empty output");
    if (key === "subject" && (confirmation && (refs(patch.subject).length || parts.some(part => typeof part !== "string")) ||
      parts.some(part => /[\u0000-\u001f\u007f-\u009f]/.test(typeof part === "string" ? part : `${part.prefix ?? ""}${part.suffix ?? ""}${part.empty ?? ""}`)))) fail([...path, key], "literal single-line subject required");
  }
  for (const [key, value] of Object.entries(patch.copy ?? {})) {
    if (!manifest.copy.includes(key) && !COMMON_SLOTS.includes(key)) fail([...path, "copy", key], "unknown slot");
    checkRefs(refs(value), [...path, "copy", key]);
    if (refs(value).some(field => secrets.includes(field)) && Object.entries(HEADER_SLOTS[id] ?? {}).some(([header, slots]) =>
      patch[header as "subject"] === undefined && slots.includes(key))) fail([...path, "copy", key], "header dependency requires override");
  }
  for (const key of Object.keys(patch.ctaLabels ?? {})) if (!manifest.ctas.includes(key)) fail([...path, "ctaLabels", key], "unknown CTA");
  const blocks = patch.body?.blocks ?? [];
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) fail([...path, "body"], "repeated block id");
  let rows = 0, references = 0;
  for (const [index, block] of blocks.entries()) {
    const at = [...path, "body", "blocks", index];
    references += block.kind === "fieldTable" ? block.rows?.length ?? 0 : "field" in block ? 1 : block.kind === "cta" && "field" in block.url ? 1 : 0;
    if (block.kind === "paragraph") checkRefs(refs(block.text), at);
    else if (block.kind === "fieldTable") {
      if (!!block.rows === !!block.allFields || block.includeMeta && id !== "contact") fail(at, "invalid field table");
      rows += block.allFields ? 43 : block.rows?.length ?? 0;
      checkRefs([...(block.rows ?? []).map(row => row.field), ...block.exclude ?? []], at);
    } else if (block.kind === "metadata") { if (id !== "contact") fail(at, "metadata requires contact"); }
    else if (block.kind === "cta") {
      if ("field" in block.url && (eligible || fields[block.url.field]?.kind !== "url")) fail(at, "literal or URL field required");
      if ("field" in block.url) checkRefs([block.url.field], at);
    } else checkRefs([block.field], at);
  }
  if (rows > 43 || Object.keys(fields).length > 43) fail(path, "effective field limit");
  const texts = [patch.subject, patch.heading, patch.previewText, ...Object.values(patch.copy ?? {}), ...blocks.filter(b => b.kind === "paragraph").map(b => b.text)];
  if (texts.reduce((sum, value) => sum + refs(value).length, references) > 128 || bytes(mergeDefinitions([patch])) > 12 * 1024) fail(path, "effective definition limit");
}
export function compileTemplatePlans(config: Config, fail: Fail): TemplatePlans {
  const plans: TemplatePlans = { fragments: [], texts: Object.create(null), routes: {}, warnings: [] };
  const global = config.mailTemplates;
  const layers = new Map<object, number>();
  const empty: TemplatePatch = {};
  const collect = (text: Presentation["subject"]) => {
    for (const part of typeof text === "string" ? [text] : text ?? []) if (typeof part === "string" && !Object.hasOwn(plans.texts, part)) plans.texts[part] = tokenize(part);
  };
  const fragment = (patch: TemplatePatch) => {
    let index = layers.get(patch);
    if (index === undefined) {
      index = plans.fragments.length; layers.set(patch, index); plans.fragments.push(patch);
      for (const text of [patch.subject, patch.heading, patch.previewText, ...Object.values(patch.copy ?? {}), ...patch.body?.blocks.flatMap(block => block.kind === "paragraph" ? [block.text] : []) ?? []]) collect(text);
    }
    return index;
  };
  const section = [global, ...Object.values(config.brands).map(brand => brand.mailTemplates)];
  if (bytes(section) > 256 * 1024) fail(["mailTemplates"], "configuration byte limit");
  const configured = Object.values(config.brands).filter(brand => global || brand.mailTemplates);
  if (configured.length > 64) fail(["mailTemplates"], "brand limit");
  let count = 0;
  const baseManifest = (id: TemplateId, parts: Layer[]) => {
    const fields = { ...MANIFEST[id].fields };
    const secrets = [...TEMPLATES[id].secretFields ?? [], ...TEMPLATES[id].optionalSecretFields ?? []];
    for (const { patch, path } of parts) {
      for (const [key, value] of Object.entries(patch.fields ?? {})) {
        if (Object.hasOwn(fields, key) && fields[key].kind !== value.kind) fail([...path, "fields", key], "field kind differs");
        fields[key] = value;
      }
      secrets.push(...patch.secretFields ?? []);
    }
    for (const { patch, path } of parts) for (const key of patch.secretFields ?? []) if (!Object.hasOwn(fields, key)) fail([...path, "secretFields"], "unknown field");
    return { fields, secretFields: [...new Set(secrets)] };
  };
  const checkCommon = (patch: typeof global, path: Path) => {
    for (const [slot, text] of Object.entries(patch?.defaults?.copy ?? {})) if (!COMMON_SLOTS.includes(slot) || refs(text).some(key => !["name", ...CONTEXT_FIELDS].includes(key))) fail([...path, "defaults", "copy", slot], "invalid common slot");
  };
  checkCommon(global, ["mailTemplates"]);
  for (const [id, patch] of Object.entries(global?.templates ?? {})) {
    const path = ["mailTemplates", "templates", id];
    const manifest = baseManifest(id as TemplateId, [{ patch, path }]);
    checkPatch(id as TemplateId, patch, manifest.fields, manifest.secretFields, ["contact", "received"].includes(id), id === "received", path, fail);
    for (const [locale, value] of Object.entries(patch.locales ?? {})) checkPatch(id as TemplateId, value, manifest.fields, manifest.secretFields, ["contact", "received"].includes(id), id === "received", [...path, "locales", locale], fail);
  }
  for (const [brandId, brand] of Object.entries(config.brands)) {
    const local = brand.mailTemplates;
    const root = ["brands", brandId, "mailTemplates"];
    if (local && !global) fail(root, "root mailTemplates version required");
    checkCommon(local && { ...local, version: 1 }, root);
    const langs = local?.languages;
    if (langs) {
      if (!langs.allowed.includes(langs.default) || new Set(langs.allowed).size !== langs.allowed.length) fail([...root, "languages"], "invalid language set");
      for (const locale of Object.keys(langs.layout ?? {})) if (!langs.allowed.includes(locale)) fail([...root, "languages", "layout", locale], "language not allowed");
      for (const locale of langs.allowed) if (!["pl", "en"].includes(locale.split("-")[0]) && !own(langs.layout, locale) && !own(langs.layout, locale.split("-")[0])) fail([...root, "languages", "layout"], "layout copy required");
    }
    for (const [patch, path] of [[global?.defaults, ["mailTemplates", "defaults"]], [local?.defaults, [...root, "defaults"]]] as const) {
      if (langs && (Object.keys(patch?.copy ?? {}).length || Object.keys(patch?.labels ?? {}).length)) fail([...path], "move copy and labels to templates/locales");
    }
    const confirmation = brand.autoReplyTemplate ?? "received";
    const eligible = new Set(["contact", "received", confirmation]);
    if (!Object.hasOwn(MANIFEST, confirmation)) fail([...root, "templates"], "unknown confirmation template");
    const forms = local?.forms;
    if (forms) {
      if (Object.keys(forms.kinds).length > 16 || Object.keys(forms.selector.values).length > 64) fail([...root, "forms"], "form limit");
      for (const kind of [forms.selector.empty, forms.selector.otherwise, ...Object.values(forms.selector.values)]) if (!Object.hasOwn(forms.kinds, kind)) fail([...root, "forms", "selector"], "unknown kind");
      for (const id of Object.keys(forms.selector.byTemplate)) if (!eligible.has(id)) fail([...root, "forms", "selector", "byTemplate", id], "ineligible template");
      for (const [kind, value] of Object.entries(forms.kinds)) for (const id of Object.keys(value.templates)) if (!eligible.has(id) || !Object.hasOwn(forms.selector.byTemplate, id)) fail([...root, "forms", "kinds", kind, "templates", id], "template has no selector");
    }
    if (!global && !local) continue;
    plans.routes[brandId] = {};
    for (const id of Object.keys(MANIFEST) as TemplateId[]) {
      const common: Layer[] = [{ patch: global?.defaults ?? empty, path: ["mailTemplates", "defaults"] }, { patch: own(global?.templates, id) ?? empty, path: ["mailTemplates", "templates", id] },
        { patch: local?.defaults ?? empty, path: [...root, "defaults"] }, { patch: own(local?.templates, id) ?? empty, path: [...root, "templates", id] }];
      const manifest = baseManifest(id, common);
      const kinds = forms && Object.hasOwn(forms.selector.byTemplate, id) ? Object.keys(forms.kinds) : [];
      plans.routes[brandId][id] = {};
      for (const kind of ["", ...kinds]) {
        const parts = kind ? [...common, { patch: forms!.kinds[kind].templates[id] ?? empty, path: [...root, "forms", "kinds", kind, "templates", id] }] : common;
        for (const { patch, path } of parts.slice(3)) {
          checkPatch(id, patch, manifest.fields, manifest.secretFields, eligible.has(id), id === confirmation, path, fail);
          for (const [locale, value] of Object.entries(patch.locales ?? {})) checkPatch(id, value, manifest.fields, manifest.secretFields, eligible.has(id), id === confirmation, [...path, "locales", locale], fail);
        }
        const selector = forms?.selector.byTemplate[id];
        if (selector && !Object.hasOwn(manifest.fields, selector)) fail([...root, "forms", "selector", "byTemplate", id], "unknown selector field");
        for (const { patch, path } of parts.slice(3)) for (const locale of Object.keys(patch.locales ?? {})) if (!langs || !langs.allowed.includes(locale) || locale === langs.default) fail([...path, "locales", locale], "invalid brand locale");
        const routes: Record<string, number[]> = {};
        plans.routes[brandId][id][kind] = routes;
        for (const locale of langs?.allowed ?? [""]) {
          const translated = !!langs && locale !== langs.default;
          const overlays = parts.map(layer => ({ patch: own(layer.patch.locales, locale) ?? empty, path: [...layer.path, "locales", locale] }));
          let available = !translated || parts.some(layer => own(layer.patch.locales, locale) !== undefined);
          if (translated) for (let index = 3; index < parts.length; index++) for (const key of ["body", "subject", "heading", "previewText"] as const) {
            if (parts[index].patch[key] !== undefined && !overlays.slice(index).some(layer => layer.patch[key] !== undefined)) {
              available = false; plans.warnings.push(`$.${[...parts[index].path, key].join(".")}: locale coverage required`);
            }
          }
          const selected = translated ? [...parts, ...overlays] : parts;
          const effective = mergeDefinitions([manifest, ...selected.map(layer => layer.patch)]);
          const at = [...root, "templates", id];
          if (translated && available) plans.warnings.push(`$.${at.join(".")}.locales.${locale}: inherited base literals`);
          if (effective.body && Object.keys(effective.copy ?? {}).length) plans.warnings.push(`$.${at.join(".")}.copy: unused body slots`);
          checkPatch(id, effective, manifest.fields, manifest.secretFields, eligible.has(id), id === confirmation, at, fail);
          if (id === confirmation) {
            for (const key of ["subject", "heading", "previewText"] as const) if (effective[key] === undefined && HEADER_FIELDS[id][key].some(field => !["name", "summary"].includes(field)) && !(id === "contact" && key === "heading" && effective.subject !== undefined)) fail([...at, key], "confirmation output requires override");
            if (id !== "received" && !effective.body) fail([...at, "body"], "confirmation requires safe body");
          }
          for (const key of ["subject", "heading", "previewText"] as const) if (effective[key] === undefined && manifest.secretFields.some(field => HEADER_FIELDS[id][key].includes(field))) fail([...at, key], "secret header dependency requires override");
          const policy = { ...config.logging.defaults, ...config.logging.brands[brandId]?.defaults, ...config.logging.brands[brandId]?.templates?.[id] };
          if (policy.resend === "replay" && [...TEMPLATES[id].secretFields ?? [], ...effective.secretFields?.filter(key => !TEMPLATES[id].optionalSecretFields?.includes(key)) ?? []].length) fail(at, "template requires source or off");
          if ((policy.level === "masked" || policy.level === "full") && selected.some(layer => Object.keys(layer.patch).some(key => !["fields", "secretFields", "locales"].includes(key))) && config.logging.patterns.some(pattern => "regex" in pattern)) fail(["logging", "patterns"], "active presentation requires literal patterns");
          if (available) { if (++count > 1024) fail(["mailTemplates"], "combination limit"); routes[locale] = [fragment(manifest), ...selected.map(layer => fragment(layer.patch))]; }
        }
      }
    }
  }
  if (bytes(plans) > 8 * 1024 * 1024) fail(["mailTemplates"], "plan byte limit");
  cache.set(config, freezePlans(plans));
  return plans;
}
export function templatePlans(config: Config): TemplatePlans {
  const plans = cache.get(config);
  if (!plans) throw new Error("template configuration was not compiled");
  return plans;
}
