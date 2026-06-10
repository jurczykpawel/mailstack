import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { ctaButton, ctaText, paragraph } from "../layout";

/** Welcome / onboarding email with an optional CTA button. */
export const welcomeTemplate: TemplateDef = {
  id: "welcome",

  subject(brand: Brand, _data: TemplateData): string {
    return `Witaj w ${brand.name}`;
  },

  render(brand: Brand, data: TemplateData): RenderedBody {
    const name = (data.name || "").trim();
    const heading = `Witaj${name ? ", " + name : ""} w ${brand.name}!`;

    const intro = (data.intro || "").trim();
    const body = (data.body || "").trim();
    const ctaUrl = (data.ctaUrl || "").trim();
    const ctaLabel = (data.ctaLabel || "Zaczynamy").trim();

    const htmlParts: string[] = [];
    if (intro) htmlParts.push(paragraph(intro));
    if (body) htmlParts.push(paragraph(body));
    htmlParts.push(ctaButton(brand, ctaUrl, ctaLabel));

    const textParts: string[] = [];
    if (intro) textParts.push(intro);
    if (body) textParts.push(body);
    const cta = ctaText(ctaUrl, ctaLabel);
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
      previewText: intro || body || heading,
    };
  },
};
