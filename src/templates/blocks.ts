import type { Brand, TemplateData } from "../types.ts";
import type { Presentation, TemplatePatch } from "./config-schema.ts";
import { httpUrl } from "./config-schema.ts";
import type { TemplatePlans } from "./config.ts";
import { own } from "./config.ts";
import { tokenize } from "./tokens.ts";
import { Output, length, parts, type Content, type Emit } from "./output.ts";
import { emitParagraph, codeBox, ctaButton, humanizeLabel, summaryTable, messageBlock, metadataBlock, renderLayout } from "./layout.ts";

export function expandText(text: Presentation["subject"], brand: Brand, data: TemplateData, plans: TemplatePlans): readonly string[] {
  const field = (key: string) => key.startsWith("brand.") ? String(own(brand as unknown as Record<string, string>, key.slice(6)) ?? "") : (own(data, key) ?? "").trim();
  return (typeof text === "string" ? [text] : text ?? []).flatMap(part => {
    if (typeof part !== "string") {
      const value = field(part.field);
      return value ? [part.prefix ?? "", value, part.suffix ?? ""] : [part.empty ?? ""];
    }
    return (own(plans.texts, part) ?? tokenize(part)).map(token => typeof token === "string" ? token : field(token.field));
  });
}
type Pair = { html: Emit; text: Emit };
function configuredBody(brand: Brand, patch: TemplatePatch, plans: TemplatePlans, data: TemplateData): Pair {
  const blocks: Pair[] = [];
  const label = (key: string) => own(patch.labels, key) ?? humanizeLabel(key);
  for (const block of patch.body?.blocks ?? []) {
    const value = "field" in block ? own(data, block.field) ?? "" : "";
    if (block.kind === "paragraph") {
      const text = expandText(block.text, brand, data, plans);
      if (length(text)) blocks.push({ html: out => emitParagraph(text, out), text: out => out.raw(text) });
    } else if (block.kind === "fieldTable") {
      const selected: { field: string; label?: string }[] = block.rows ?? Object.keys(data).filter(key => block.includeMeta || !["_receivedAt", "_origin", "_ip"].includes(key)).map(field => ({ field }));
      const rows = selected
        .filter(row => !block.exclude?.includes(row.field) && (own(data, row.field) ?? "").trim())
        .map(row => ({ label: row.label ?? label(row.field), value: own(data, row.field)! }));
      if (rows.length) blocks.push({ html: out => summaryTable(rows, out), text: out => rows.forEach((row, i) => {
        if (i) out.raw(block.textStyle === "stacked" ? "\n\n" : "\n");
        out.raw([row.label, block.textStyle === "stacked" ? "\n" : ": ", row.value]);
      }) });
    } else if (block.kind === "metadata") {
      const names = { receivedAt: "Otrzymano", origin: "Źródło", ip: "IP" };
      const items = block.items.map(key => ({ label: patch.copy?.[`${key}Label`] === undefined ? [names[key]] : expandText(patch.copy[`${key}Label`], brand, data, plans),
        value: (own(data, `_${key}`) ?? "").trim() ? data[`_${key}`] : "-" }));
      if (items.length) blocks.push({ html: out => metadataBlock(items, out), text: out => metadataBlock(items, out, true) });
    } else if (block.kind === "cta") {
      const url = "literal" in block.url ? block.url.literal : (own(data, block.url.field) ?? "").trim();
      if (httpUrl(url)) blocks.push({ html: out => ctaButton(brand, url, block.label, out), text: out => out.raw([block.label, ": ", url]) });
    } else if (value.trim()) {
      if (block.kind === "message") {
        const title = block.label ?? label(block.field), text = value.trim();
        blocks.push({ html: out => messageBlock(text, title, out), text: out => out.raw([title, ":\n", text]) });
      } else blocks.push({ html: out => { if (block.label) emitParagraph(block.label, out); codeBox(value, out); },
        text: out => out.raw([...(block.label ? [block.label, "\n"] : []), value]) });
    }
  }
  const emit = (key: keyof Pair): Emit => out => blocks.forEach((block, i) => {
    if (i) out.raw(key === "html" ? patch.body?.htmlJoin ?? "\n" : patch.body?.textJoin ?? "\n\n");
    block[key](out);
  });
  return { html: emit("html"), text: emit("text") };
}
export function renderConfigured(brand: Brand, patch: TemplatePatch, plans: TemplatePlans, data: TemplateData,
  input: { subject: Content; heading: Content; previewText?: Content; headHtml?: string }) {
  const encodings = new Output().encodings;
  const subject = new Output(998, false, false, encodings);
  subject.raw(input.subject);
  if (length(input.heading) > 5000 || length(input.previewText ?? "") > 5000) throw new RangeError("template_output_limit");
  const body = configuredBody(brand, patch, plans, data);
  const layout = { ...input, bodyHtml: body.html, bodyText: body.text };
  renderLayout(brand, layout, { html: new Output(512 * 1024, false, false, encodings), text: new Output(256 * 1024, false, false, encodings) });
  const result = renderLayout(brand, layout, { html: new Output(512 * 1024, true, false, encodings), text: new Output(256 * 1024, true, false, encodings) });
  return { ...result, subject: parts(input.subject).join("") };
}
