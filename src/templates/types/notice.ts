import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { ctaButton, ctaText, paragraph } from "../layout";

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
    const paragraphs = normalizeParagraphs(data.paragraphs);
    const ctaUrl = (data.ctaUrl || "").trim();
    const ctaLabel = (data.ctaLabel || "Dowiedz się więcej").trim();

    const htmlParts: string[] = paragraphs.map((p) => paragraph(p));
    htmlParts.push(ctaButton(brand, ctaUrl, ctaLabel));

    const textParts: string[] = [...paragraphs];
    const cta = ctaText(ctaUrl, ctaLabel);
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
      previewText: paragraphs[0] || heading,
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
