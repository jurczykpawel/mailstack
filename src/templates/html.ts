import { parse, parseFragment, type DefaultTreeAdapterTypes as T } from "parse5";
import type { Brand, TemplateData } from "../types.ts";
import { escapeHtml as e } from "./layout.ts";
import { httpUrl } from "./config-schema.ts";
import { encodeValue, fieldValue, renderBudget } from "./markdown.ts";

type Hole = { field: string; fallback: string; context: "text" | "attr" | "url" | "part"; space?: " " };
export type Part = string | Hole;
export interface HtmlPlan { parts: Part[]; fields: string[]; urlFields: string[]; partialUrlFields: string[]; document?: true }

const TAGS = new Set("p h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th a img span div strong em b i u s br hr".split(" "));
const DOCUMENT_TAGS = new Set(["html", "head", "body", "title", "meta"]);
const ATTRIBUTES = new Set("style href src alt width height align valign role cellpadding cellspacing colspan border title lang dir".split(" "));
const VOID = new Set(["br", "hr", "img", "meta"]);
const BLOCKS = new Set("p div h1 h2 h3 h4 h5 h6 ul ol table hr".split(" "));
const FIELD = /( ?)\{([A-Za-z_][\w.-]{0,127})(?:\|([^{}]*))?\}/g;
const WHOLE = /^\{([A-Za-z_][\w.-]{0,127})\}$/;
const STYLE = /url\s*\(|expression\s*\(|image-set|javascript:|[\\@{}]|\/\*/i;
const XHTML = "http://www.w3.org/1999/xhtml";
const attribute = (element: T.Element, name: string) => element.attrs.find(attr => attr.name === name)?.value ?? "";

/** Parses HTML into a tree and serializes only allowed elements and attributes, with fields as escaped holes. */
export function compileHtml(source: string, options: { document?: boolean; secrets?: string[] } = {}): HtmlPlan {
  const parts: Part[] = [], fields = new Set<string>(), partial = new Set<string>(), urls = new Set<string>();
  const push = (text: string, context: Hole["context"]) => {
    let last = 0;
    for (const m of text.matchAll(FIELD)) {
      const space = context === "text" && m[1] ? " " as const : undefined;
      parts.push(e(text.slice(last, m.index) + (space ? "" : m[1])), { field: m[2], fallback: m[3] ?? "", context, ...(space ? { space } : {}) });
      fields.add(m[2]);
      if (context === "part") partial.add(m[2]);
      last = m.index + m[0].length;
    }
    parts.push(e(text.slice(last)));
  };
  const url = (name: string, value: string) => {
    const whole = WHOLE.exec(value.trim());
    if (whole) { parts.push({ field: whole[1], fallback: "", context: "url" }); fields.add(whole[1]); urls.add(whole[1]); return; }
    const skeleton = value.trim().replace(FIELD, "$1x");
    if (!httpUrl(skeleton) && !(name === "href" && /^(?:mailto:[^\s<>"'{}]+|#[\w-]*)$/i.test(skeleton))) throw new Error(`html_url:${name}`);
    push(value.trim(), "part");
  };
  const visit = (node: T.Node, depth = 0): void => {
    if (depth > 48) throw new Error("html_nesting_limit");
    if (node.nodeName === "#document") parts.push("<!doctype html>");
    if (node.nodeName === "#document" || node.nodeName === "#document-fragment") return (node as T.ParentNode).childNodes.forEach(child => visit(child, depth + 1));
    if (node.nodeName === "#documentType") return;
    if (node.nodeName === "#comment") { if (/[{}]/.test((node as T.CommentNode).data)) throw new Error("html_field_in_comment"); return; }
    if (node.nodeName === "#text") return push((node as T.TextNode).value, "text");
    const element = node as T.Element, name = element.tagName;
    if (element.namespaceURI !== XHTML || !(TAGS.has(name) || options.document && DOCUMENT_TAGS.has(name))) throw new Error(`html_tag:${name}`);
    parts.push(`<${name}`);
    for (const { name: key, value } of element.attrs) {
      if (!ATTRIBUTES.has(key) && !(name === "meta" && ["charset", "name", "content"].includes(key))) throw new Error(`html_attribute:${key}`);
      parts.push(` ${key}="`);
      if (key === "href" || key === "src") url(key, value);
      else if (key === "style" && STYLE.test(value)) throw new Error("html_style");
      else push(value, "attr");
      parts.push('"');
    }
    parts.push(">");
    if (VOID.has(name)) return;
    element.childNodes.forEach(child => visit(child, depth + 1));
    parts.push(`</${name}>`);
  };
  visit(options.document ? parse(source) : parseFragment(source));
  if ([...partial].some(field => options.secrets?.includes(field))) throw new Error("html_secret_in_url");
  const merged = parts.reduce<Part[]>((all, part) => {
    if (typeof part === "string" && typeof all.at(-1) === "string") all[all.length - 1] += part; else if (part !== "") all.push(part);
    return all;
  }, []);
  return { parts: merged, fields: [...fields], urlFields: [...urls], partialUrlFields: [...partial], ...(options.document ? { document: true as const } : {}) };
}

export function renderHtml(plan: HtmlPlan, data: TemplateData, brand?: Brand, budget = renderBudget()): string {
  return plan.parts.map(part => {
    if (typeof part === "string") return part;
    const value = (brand ? fieldValue(brand, data, part.field) : (Object.hasOwn(data, part.field) ? data[part.field] : "").trim()) || part.fallback.trim();
    const out = part.context === "url" ? httpUrl(value) ? e(value) : "#" : part.context === "part" ? e(encodeValue(value))
      : part.context === "attr" ? e(value) : value ? (part.space ?? "") + e(value).replace(/\n/g, "<br>") : "";
    budget.spend(out.length);
    return out;
  }).join("");
}

/** Plain-text alternative of rendered (allowed) HTML: blocks on separate lines, links as "label (address)". */
export function htmlText(html: string, document = false): string {
  let out = "";
  const walk = (node: T.Node): void => {
    if (node.nodeName === "#text") { out += (node as T.TextNode).value.replace(/\s+/g, " "); return; }
    if (!("childNodes" in node)) return;
    const name = (node as T.Element).tagName;
    if (name === "head") return;
    if (name === "br") out += "\n";
    if (name === "img") out += attribute(node as T.Element, "alt");
    if (BLOCKS.has(name)) out += "\n\n";
    if (name === "li") out += "\n- ";
    if (name === "tr") out += "\n";
    const start = out.length;
    node.childNodes.forEach(walk);
    const href = name === "a" ? attribute(node as T.Element, "href").replace(/^mailto:/i, "") : "";
    if (href && href !== "#" && out.slice(start).trim() !== href) out += ` (${href})`;
    if (name === "td" || name === "th") out += "  ";
    if (BLOCKS.has(name)) out += "\n\n";
  };
  walk(document ? parse(html) : parseFragment(html));
  return out.split("\n").map(line => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export const renderHtmlText = (plan: HtmlPlan, data: TemplateData, brand?: Brand) => htmlText(renderHtml(plan, data, brand), plan.document);
