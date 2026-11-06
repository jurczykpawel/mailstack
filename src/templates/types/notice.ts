import { esc, type Emit, type Output } from "../output.ts";
import { Recipe } from "../recipe.ts";
import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types.ts";
import { codeBox, ctaText, emitParagraph } from "../layout.ts";

/** Generic catch-all notice: heading + paragraphs + optional CTA. */
export const noticeTemplate: TemplateDef = {
  id: "notice",
  maskedFields: [],
  requiredFields: ["heading", "paragraphs"],
  optionalSecretFields: ['ctaUrl'],

  subject(brand: Brand, data: TemplateData, recipe = new Recipe()): string {
    const subject = (data.subject || "").trim();
    const heading = (data.heading || "").trim();
    return subject || heading || recipe.copy("fallbackSubject", brand.name);
  },

  render(brand: Brand, data: TemplateData, recipe = new Recipe()): RenderedBody {
    const heading = (data.heading || "").trim() || recipe.copy("fallbackHeading", brand.name);
    const blocks = parseBlocks(recipe.patch.body ? undefined : data.paragraphs);
    const rendered = blocks.map((block) => renderBlock(brand, block));
    const ctaUrl = (data.ctaUrl || "").trim();
    const ctaLabel = recipe.cta("main", "Dowiedz się więcej", data.ctaLabel);

    const htmlParts: (string | Emit)[] = rendered.map((block) => block.html);
    htmlParts.push(recipe.button(brand, ctaUrl, ctaLabel));

    const textParts = rendered.map((block) => block.text);
    const cta = ctaText(ctaUrl, ctaLabel);
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: recipe.html(htmlParts),
      bodyText: recipe.text(textParts),
      previewText: rendered[0]?.preview || heading,
    };
  },
};

/**
 * `paragraphs` may arrive as a string (possibly newline-separated) or, when the
 * caller sends JSON, an array. After flattening through TemplateData it is a
 * string; split on blank lines so multi-paragraph notices render as blocks.
 */
function normalizeParagraphs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}


type NoticeBlock = { kind: "text" | "code"; value: string };

/** Extract complete, line-delimited fences before applying the legacy splitter. */
function parseBlocks(raw: string | undefined): NoticeBlock[] {
  if (!raw) return [];
  const blocks: NoticeBlock[] = [];
  const fences = /^```[^\S\r\n]*(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*(?=\r?$)/gm;
  let offset = 0;
  for (const match of raw.matchAll(fences)) {
    blocks.push(...normalizeParagraphs(raw.slice(offset, match.index)).map((value): NoticeBlock => ({ kind: "text", value })));
    blocks.push({ kind: "code", value: match[1] });
    offset = match.index! + match[0].length;
  }
  blocks.push(...normalizeParagraphs(raw.slice(offset)).map((value): NoticeBlock => ({ kind: "text", value })));
  return blocks;
}

function emitBold(value: string, output: Output, lines = false) {
  let offset = 0;
  for (const match of value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    output.escaped(value.slice(offset, match.index), lines);
    output.html`<strong>${esc(match[1])}</strong>`; offset = match.index! + match[0].length;
  }
  output.escaped(value.slice(offset), lines);
}

function boldText(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function renderBlock(brand: Brand, block: NoticeBlock): { html: Emit; text: string; preview: string } {
  const value = block.value;
  if (block.kind === "code") {
    return {
      html: out => { codeBox(value, out); },
      text: value, preview: value,
    };
  }
  if (value.startsWith("## ")) {
    const title = boldText(value.slice(3));
    return {
      html: out => out.html`<h2 style="margin:24px 0 12px 0;font-size:18px;line-height:1.4;color:${esc(brand.theme.accent)};">${out => emitBold(value.slice(3), out)}</h2>`,
      text: `${title}\n${"-".repeat(title.length)}`, preview: title,
    };
  }
  const html: Emit[] = [];
  const lines = value.split("\n");
  for (let i = 0; i < lines.length;) {
    const list = lines[i].startsWith("- ");
    const run: string[] = [];
    while (i < lines.length && lines[i].startsWith("- ") === list) run.push(lines[i++]);
    if (list) {
      html.push(out => out.html`<ul style="margin:0 0 14px 0;padding-left:24px;font-size:14px;color:#1a1a1a;line-height:1.6;">${out => run.forEach(line => out.html`<li style="margin:0 0 6px 0;">${out => emitBold(line.slice(2), out)}</li>`)}</ul>`);
    } else {
      // Reuse the exact legacy paragraph markup, adding only paired bold markers.
      html.push(out => emitParagraph("", out, out => emitBold(run.join("\n"), out, true)));
    }
  }
  return { html: out => html.forEach((emit, i) => { if (i) out.raw("\n"); emit(out); }), text: boldText(value), preview: boldText(value) };
}
