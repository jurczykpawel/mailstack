import { Lexer, Tokenizer, type Token, type Tokens } from "marked";
import type { Brand, TemplateData } from "../types.ts";
import { codeBox, ctaButton, escapeHtml as e, summaryTable } from "./layout.ts";
import { httpUrl } from "./config-schema.ts";
import { WorkBudget } from "./output.ts";

type Component = { kind: "component"; name: string; args: string; tokens?: Token[] };
export type Chunk = { kind: "markdown"; tokens: Token[] } | Component;
export interface MarkdownPlan { chunks: Chunk[]; fields: string[]; urlFields: string[]; partialUrlFields: string[] }
type Out = { html: string; text: string };

const COMPONENTS = ["button", "code", "fields", "note", "items", "totals"];
const COMPONENT = /^\[\[([a-z]+)(?::(.*))?\]\]$/;
const FIELD = /( ?)\{([A-Za-z_][\w.-]{0,127})(?:\|([^{}]*))?\}/g;
const WHOLE = /^\{([A-Za-z_][\w.-]{0,127})\}$/;
const P = "margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.6;";
const RULE = "border-top:1px solid #e6e1d3;";
const EMPTY: Out = { html: "", text: "" };
const join = (outs: Out[], text = ""): Out => ({ html: outs.map(o => o.html).join(""), text: outs.map(o => o.text).join(text) });
const split = (args: string, sep: string) => args.split(sep).map(s => s.trim()).filter(Boolean);
/** Percent-encodes a value; a lone surrogate becomes U+FFFD instead of throwing. */
export const encodeValue = (value: string) => encodeURIComponent(value.toWellFormed());
export const fieldNames = (text: string) => [...text.matchAll(FIELD)].map(m => m[2]);
const MAX_TABLE_CELLS = 1000;
/** Counts the cells every GFM table would allocate (header width times rows) before the lexer pads them. */
class TableBudget extends Tokenizer {
  cells = 0;
  override table(src: string) {
    const cap = this.rules.block.table.exec(src), other = this.rules.other;
    const columns = cap && other.tableDelimiter.test(cap[2]) ? cap[2].replace(other.tableAlignChars, "").split("|").length : 0;
    const rows = columns && cap![3]?.trim() ? cap![3].replace(other.tableRowBlankLine, "").split("\n").length : 0;
    if ((this.cells += columns * (1 + rows)) > MAX_TABLE_CELLS) throw new Error("markdown table limit");
    return super.table(src);
  }
}

/** `bundled` plans are stored as JSON, so they keep exactly what a JSON round trip preserves. */
export function compileMarkdown(source: string, bundled = true): MarkdownPlan {
  const plain = (tokens: Token[]): Token[] => bundled ? JSON.parse(JSON.stringify(tokens)) : tokens;
  const chunks: Chunk[] = [], buffer: string[] = [], partial = new Set<string>(), whole = new Set<string>(), keys = new Set<string>();
  const tokenizer = new TableBudget();
  const flush = () => { if (buffer.length) chunks.push({ kind: "markdown", tokens: plain(Lexer.lex(buffer.join("\n"), { gfm: true, tokenizer })) }); buffer.length = 0; };
  const href = (raw: string) => { const field = WHOLE.exec(raw.trim())?.[1]; if (field) whole.add(field); else fieldNames(raw).forEach(name => partial.add(name)); };
  let fence = "";
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1], info = marker ? line.trim().slice(marker.length) : "";
    if (fence ? marker?.startsWith(fence) && !info.trim() : marker && !(marker[0] === "`" && info.includes("`"))) fence = fence ? "" : marker!;
    // Lines indented four or more spaces belong to code (indented or nested in a list item).
    const match = !fence && !marker && !/^(?: {4}|\t)/.test(line) && COMPONENT.exec(line.trim());
    if (!match) { buffer.push(line); continue; }
    const name = match[1], args = (match[2] ?? "").trim(), parts = split(args, "|");
    if (!COMPONENTS.includes(name) || name === "button" && parts.length !== 2 || name === "items" && !WHOLE.test(args.trim()))
      throw new Error(`invalid component ${name}`);
    if (name === "button") href(parts[1]);
    if (name === "fields") split(args, ",").forEach(pair => keys.add(pair.split("=")[0].trim()));
    flush();
    chunks.push({ kind: "component", name, args, ...(name === "note" ? { tokens: plain(Lexer.lexInline(args, { gfm: true })) } : {}) });
  }
  flush();
  const visit = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) node.forEach(child => visit(child, depth));
    else if (node && typeof node === "object") {
      if (depth > 24) throw new Error("markdown nesting limit");
      if ((node as Token).type === "link") href((node as Tokens.Link).href);
      for (const key of ["tokens", "items", "header", "rows"]) visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(chunks, 0);
  return { chunks, fields: [...new Set([...fieldNames(source), ...keys])], urlFields: [...whole], partialUrlFields: [...partial] };
}

export const fieldValue = (brand: Brand, data: TemplateData, key: string) => (key.startsWith("brand.") && ["brand.id", "brand.name", "brand.subjectPrefix"].includes(key)
  ? String(brand[key.slice(6) as "id"]) : Object.hasOwn(data, key) ? data[key] : "").trim();
/** Field output allowed per body render (HTML and text together); the final size limits are checked later. */
export const renderBudget = () => new WorkBudget(768 * 1024);
/** Substitute `{field}` and `{field|fallback}`; an empty field also removes the space before it. */
export function fill(text: string, brand: Brand, data: TemplateData, html = false, budget = renderBudget()): string {
  let out = "", last = 0;
  const literal = (value: string) => html ? e(value).replace(/&amp;(#?[A-Za-z0-9]{1,32};)/g, "&$1") : value;
  for (const m of text.matchAll(FIELD)) {
    const value = fieldValue(brand, data, m[2]) || (m[3] ?? "").trim();
    const shown = !html ? value : /^[^\s-]{1,24}(?:-[^\s-]{1,24}){1,3}$/.test(value) ? `<span style="white-space:nowrap;">${e(value)}</span>` : e(value).replace(/\n/g, "<br>");
    budget.spend(shown.length);
    out += literal(text.slice(last, m.index)) + (value ? m[1] + shown : "");
    last = m.index + m[0].length;
  }
  return out + literal(text.slice(last));
}
function url(raw: string, brand: Brand, data: TemplateData, budget: WorkBudget, mailto = true): string {
  const whole = WHOLE.exec(raw.trim());
  const href = whole ? fieldValue(brand, data, whole[1]) : raw.trim().replace(/&amp;/g, "&").replace(FIELD, (_, space: string, key: string) => space + encodeValue(fieldValue(brand, data, key)));
  budget.spend(href.length);
  return httpUrl(href) || mailto && !whole && /^mailto:[^\s<>"'{}]+$/i.test(href) ? href : "";
}

function inline(tokens: Token[] | undefined, brand: Brand, data: TemplateData, budget: WorkBudget): Out {
  return join((tokens ?? []).map((t): Out => {
    if (t.type === "text" && t.tokens) return inline(t.tokens, brand, data, budget);
    if (t.type === "strong" || t.type === "em" || t.type === "del") {
      const r = inline(t.tokens, brand, data, budget), tag = { strong: "strong", em: "em", del: "s" }[t.type];
      return { html: `<${tag}>${r.html}</${tag}>`, text: r.text };
    }
    if (t.type === "codespan") { const v = fill(t.text, brand, data, false, budget); return { html: `<code style="font-family:Consolas,Monaco,monospace;background:#f2f3f5;padding:1px 4px;border-radius:4px;">${e(v)}</code>`, text: v }; }
    if (t.type === "br") return { html: "<br>", text: "\n" };
    if (t.type === "link") {
      const r = inline(t.tokens, brand, data, budget), href = url(t.href, brand, data, budget);
      if (!href) return r;
      const shown = href.replace(/^mailto:/i, "");
      return { html: `<a href="${e(href)}" style="color:${e(brand.theme.labelColor ?? brand.theme.accent)};">${r.html}</a>`, text: r.text === shown ? shown : `${r.text} (${shown})` };
    }
    const raw = t.type === "image" ? t.text : t.type === "html" ? t.raw : "text" in t ? String(t.text) : t.raw;
    return { html: fill(raw, brand, data, true, budget), text: fill(raw, brand, data, false, budget) };
  }));
}
const section = (r: Out, color: string): Out => ({ html: `<p style="margin:22px 0 8px 0;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${e(color)};">${r.html}</p>`, text: r.text.toUpperCase() });
const note = (r: Out, brand: Brand): Out => ({ html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;"><tr><td style="border-left:4px solid ${e(brand.theme.accent2 ?? brand.theme.accent)};background:#f7f8fa;border-radius:6px;padding:12px 16px;font-size:14px;color:#1a1a1a;line-height:1.6;">${r.html.replace(/margin:0 0 14px 0;/g, "margin:0;")}</td></tr></table>`, text: r.text });

function block(t: Token, brand: Brand, data: TemplateData, budget: WorkBudget): Out {
  const run = (tokens: Token[] | undefined) => inline(tokens, brand, data, budget);
  const blocks = (tokens: Token[]) => join(tokens.map(c => c.type === "text" ? run(c.tokens ?? [c]) : block(c, brand, data, budget)), "\n");
  switch (t.type) {
    case "space": case "def": return EMPTY;
    case "paragraph": { const r = run(t.tokens); return r.text.trim() ? { html: `<p style="${P}">${r.html}</p>`, text: r.text } : EMPTY; }
    case "heading": {
      const r = run(t.tokens);
      return t.depth >= 3 ? section(r, brand.theme.labelColor ?? "#666") : { html: `<h2 style="margin:22px 0 10px 0;font-size:18px;color:#1a1a1a;">${r.html}</h2>`, text: r.text };
    }
    case "list": {
      const list = t as Tokens.List, tag = list.ordered ? "ol" : "ul", items = list.items.map(item => blocks(item.tokens));
      return { html: `<${tag} style="margin:0 0 14px 0;padding-left:22px;font-size:14px;color:#1a1a1a;line-height:1.6;">${items.map(i => `<li style="margin:0 0 4px 0;">${i.html}</li>`).join("")}</${tag}>`,
        text: items.map((i, n) => `${list.ordered ? `${Number(list.start || 1) + n}.` : "-"} ${i.text}`).join("\n") };
    }
    case "blockquote": return note(blocks(t.tokens ?? []), brand);
    case "hr": return { html: `<hr style="border:none;${RULE}margin:20px 0;">`, text: "-".repeat(20) };
    case "code": { const v = fill(t.text, brand, data, false, budget); return { html: codeBox(v), text: v }; }
    case "table": {
      const table = t as Tokens.Table, cell = (c: Tokens.TableCell) => run(c.tokens);
      const td = (c: Out, i: number, th = false) => `<td align="${table.align[i] ?? "left"}" style="padding:8px 10px;border-bottom:1px solid #eaeaea;font-size:14px;${th ? "font-weight:700;" : ""}">${c.html}</td>`;
      const head = table.header.map(cell), rows = table.rows.map(r => r.map(cell));
      return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;border-collapse:collapse;"><tr>${head.map((c, i) => td(c, i, true)).join("")}</tr>${rows.map(r => `<tr>${r.map((c, i) => td(c, i)).join("")}</tr>`).join("")}</table>`,
        text: [head, ...rows].map(r => r.map(c => c.text).join(" | ")).join("\n") };
    }
    default: { const v = fill(t.raw, brand, data, false, budget); return v.trim() ? { html: `<p style="${P}">${e(v).replace(/\n/g, "<br>")}</p>`, text: v } : EMPTY; }
  }
}

function component(c: Component, brand: Brand, data: TemplateData, budget: WorkBudget): Out {
  const parts = split(c.args, "|"), value = (text: string) => fill(text, brand, data, false, budget);
  if (c.name === "button") {
    const href = url(parts[1], brand, data, budget, false), label = value(parts[0]);
    return href ? { html: ctaButton(brand, href, label), text: `${label}: ${href}` } : EMPTY;
  }
  if (c.name === "code") {
    const code = value(parts.at(-1) ?? ""), title = parts.length > 1 ? value(parts[0]) : "";
    return code ? { html: (title ? `<p style="${P}margin-bottom:6px;font-weight:600;">${e(title)}</p>` : "") + codeBox(code), text: (title ? `${title}:\n` : "") + code } : EMPTY;
  }
  if (c.name === "fields") {
    const rows = split(c.args, ",").map(pair => { const [key, label] = pair.split("=").map(s => s.trim()); return { label: label || key, value: fieldValue(brand, data, key) }; }).filter(r => r.value);
    budget.spend(rows.reduce((sum, r) => sum + r.value.length * 2, 0));
    return rows.length ? { html: summaryTable(rows) + `<div style="height:14px"></div>`, text: rows.map(r => `${r.label}: ${r.value}`).join("\n") } : EMPTY;
  }
  if (c.name === "note") { const r = inline(c.tokens, brand, data, budget); return r.text.trim() ? note(r, brand) : EMPTY; }
  if (c.name === "items") {
    let rows: Record<string, string>[] = [];
    const raw = fieldValue(brand, data, WHOLE.exec(c.args.trim())![1]);
    budget.spend(raw.length * 2);
    try { rows = JSON.parse(raw || "[]"); } catch { return EMPTY; }
    if (!Array.isArray(rows) || !rows.length) return EMPTY;
    const cell = (row: Record<string, string>, key: string) => typeof row?.[key] === "string" ? row[key] : "";
    const title = (row: Record<string, string>, times: string) => [cell(row, "qty") && `${cell(row, "qty")} ${times}`, cell(row, "name")].filter(Boolean).join(" ");
    return {
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.map(row => {
        const description = cell(row, "description");
        return `<tr><td style="${RULE}padding:10px 0 ${description ? 2 : 10}px 0;font-size:14px;font-weight:600;color:#1a1a1a;">${e(title(row, "×"))}</td><td align="right" style="${RULE}padding:10px 0 2px 0;font-size:14px;white-space:nowrap;vertical-align:top;">${e(cell(row, "amount"))}</td></tr>` +
          (description ? `<tr><td colspan="2" style="padding:0 0 10px 0;font-size:13px;color:#555a6b;">${e(description).replace(/\n/g, "<br>")}</td></tr>` : "");
      }).join("")}</table>`,
      text: rows.map(row => `${title(row, "x")}   ${cell(row, "amount")}${cell(row, "description") ? `\n   ${cell(row, "description")}` : ""}`).join("\n\n"),
    };
  }
  const rows = split(c.args, ";").map(pair => {
    const [left, right = ""] = pair.split("="), bold = /^\*\*.*\*\*$/.test(left.trim());
    return { label: left.trim().replace(/^\*\*|\*\*$/g, ""), value: value(right), bold };
  }).filter(r => r.value);
  return rows.length ? { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${RULE}margin:0 0 14px 0;">${rows.map(r => {
    const weight = r.bold ? "font-weight:700;" : "";
    return `<tr><td style="padding:8px 0;font-size:14px;color:#1a1a1a;${weight}">${e(r.label)}</td><td align="right" style="padding:8px 0;font-size:14px;color:#1a1a1a;white-space:nowrap;${weight}">${e(r.value)}</td></tr>`;
  }).join("")}</table>`, text: rows.map(r => `${r.label}: ${r.value}`).join("\n") } : EMPTY;
}

export function renderMarkdown(plan: MarkdownPlan, brand: Brand, data: TemplateData, budget = renderBudget()): Out {
  const outs = plan.chunks.flatMap(chunk => chunk.kind === "component" ? [component(chunk, brand, data, budget)] : chunk.tokens.map(t => block(t, brand, data, budget))).filter(o => o.html);
  return { html: outs.map(o => o.html).join("\n"), text: outs.map(o => o.text).join("\n\n") };
}
