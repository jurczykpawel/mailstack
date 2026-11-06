import { Recipe } from "../recipe.ts";
import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types.ts";
import { ctaText } from "../layout.ts";

/** Welcome / onboarding email with an optional CTA button. */
export const welcomeTemplate: TemplateDef = {
  id: "welcome",
  maskedFields: [],

  subject(brand: Brand, _data: TemplateData): string {
    return `Witaj w ${brand.name}`;
  },

  render(brand: Brand, data: TemplateData, recipe = new Recipe()): RenderedBody {
    const name = (data.name || "").trim();
    const heading = name ? recipe.copy("headingWithName", `Witaj, ${name} w ${brand.name}!`) : recipe.copy("headingWithoutName", `Witaj w ${brand.name}!`);

    const intro = (data.intro || "").trim();
    const body = (data.body || "").trim();
    const ctaUrl = (data.ctaUrl || "").trim();
    const ctaLabel = recipe.cta("main", "Zaczynamy", data.ctaLabel);

    const htmlParts: string[] = [];
    if (intro) htmlParts.push(recipe.paragraph(intro));
    if (body) htmlParts.push(recipe.paragraph(body));
    htmlParts.push(recipe.button(brand, ctaUrl, ctaLabel));

    const textParts: string[] = [];
    if (intro) textParts.push(intro);
    if (body) textParts.push(body);
    const cta = ctaText(ctaUrl, ctaLabel);
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: recipe.html(htmlParts),
      bodyText: recipe.text(textParts),
      previewText: intro || body || heading,
    };
  },
};
