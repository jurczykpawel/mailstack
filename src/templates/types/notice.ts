import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { ctaButton, ctaText, escapeHtml, paragraph } from "../layout";

/** Generic catch-all notice: heading + paragraphs + optional CTA. */
export const noticeTemplate: TemplateDef = {
  id: "notice",

  subject(brand: Brand, data: TemplateData): string {
    const subject = (data.subject || "").trim();
    const heading = (data.heading || "").trim();
    return subject || heading || brand.name;
  },

  render(brand: Brand, data: TemplateData): RenderedBody {
    const heading = (data.heading || "").trim() || brand.name;
    const blocks = parseBlocks(data.paragraphs);
    const rendered = blocks.map((block) => renderBlock(brand, block));
    const ctaUrl = (data.ctaUrl || "").trim();
    const ctaLabel = (data.ctaLabel || "Dowiedz się więcej").trim();

    const htmlParts = rendered.map((block) => block.html);
    htmlParts.push(ctaButton(brand, ctaUrl, ctaLabel));

    const textParts = rendered.map((block) => block.text);
    const cta = ctaText(ctaUrl, ctaLabel);
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
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

function boldHtml(escaped: string): string {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function boldText(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function renderBlock(brand: Brand, block: NoticeBlock): { html: string; text: string; preview: string } {
  const value = block.value;
  if (block.kind === "code") {
    return {
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;"><tr><td style="background:#f6f7f9;border:1px solid #e0e3e8;border-radius:8px;padding:16px;"><pre style="margin:0;font-family:Consolas,Monaco,'Courier New',monospace;font-size:13px;color:#1a1a1a;line-height:1.6;word-break:break-all;white-space:pre-wrap;user-select:text;">${escapeHtml(value)}</pre></td></tr></table>`,
      text: value, preview: value,
    };
  }
  if (value.startsWith("## ")) {
    const title = boldText(value.slice(3));
    return {
      html: `<h2 style="margin:24px 0 12px 0;font-size:18px;line-height:1.4;color:${escapeHtml(brand.theme.accent)};">${boldHtml(escapeHtml(value.slice(3)))}</h2>`,
      text: `${title}\n${"-".repeat(title.length)}`, preview: title,
    };
  }
  const html: string[] = [];
  const lines = value.split("\n");
  for (let i = 0; i < lines.length;) {
    const list = lines[i].startsWith("- ");
    const run: string[] = [];
    while (i < lines.length && lines[i].startsWith("- ") === list) run.push(lines[i++]);
    if (list) {
      html.push(`<ul style="margin:0 0 14px 0;padding-left:24px;font-size:14px;color:#1a1a1a;line-height:1.6;">${run.map((line) => `<li style="margin:0 0 6px 0;">${boldHtml(escapeHtml(line.slice(2)))}</li>`).join("")}</ul>`);
    } else {
      // Reuse the exact legacy paragraph markup, adding only paired bold markers.
      html.push(boldHtml(paragraph(run.join("\n"))));
    }
  }
  return { html: html.join("\n"), text: boldText(value), preview: boldText(value) };
}
