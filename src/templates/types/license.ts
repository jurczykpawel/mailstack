import { Recipe } from "../recipe.ts";
import type { TemplateDef } from "../../types.ts";
import { ctaText } from "../layout.ts";

export const licenseTemplate: TemplateDef = {
  id: "license",
  maskedFields: ["productName", "tier"],
  requiredFields: ["productName", "licenseKey"],
  secretFields: ["licenseKey", "activationUrl"],
  subject(_brand, data, recipe = new Recipe()) {
    return `${recipe.copy("branchHeading", "Twój klucz licencji")}: ${data.productName || ""}`;
  },
  render(brand, data, recipe = new Recipe()) {
    const greeting = data.name ? recipe.copy("greetingWithName", `Witaj ${data.name},`) : recipe.copy("greetingWithoutName", "Witaj,");
    const intro = recipe.copy("intro", "Twoja licencja jest gotowa. Poniżej znajdziesz jej szczegóły:");
    const rows = [
      { label: recipe.label("productName", "Produkt"), value: data.productName || "" },
      { label: recipe.label("tier", "Plan"), value: data.tier || "" },
      { label: recipe.label("domain", "Domena"), value: data.domain || "" },
    ];
    const licenseKey = data.licenseKey || "";
    const licenseHtml = licenseKey.trim() ? recipe.paragraph(recipe.copy("keyLabel", "Klucz licencji")) + recipe.code(licenseKey) : "";
    const activationUrl = data.activationUrl || "";
    const label = recipe.cta("activation", "Aktywuj licencję");
    return {
      heading: recipe.copy("branchHeading", "Twój klucz licencji"),
      bodyHtml: recipe.html([recipe.paragraph(greeting), recipe.paragraph(intro), recipe.table(rows), licenseHtml,
        recipe.button(brand, activationUrl, label), data.instructions ? recipe.paragraph(data.instructions) : ""]),
      bodyText: recipe.text([greeting, intro, ...[...rows, { label: recipe.copy("keyLabel", "Klucz licencji"), value: licenseKey }].filter((row) => row.value).map((row) => `${row.label}: ${row.value}`),
        ctaText(activationUrl, label), data.instructions || ""].filter(Boolean)),
      previewText: recipe.copy("preview", `Licencja: ${data.productName || ""}`),
    };
  },
};
