import type { TemplateDef } from "../../types.ts";
import { codeBox, ctaButton, ctaText, paragraph, summaryTable } from "../layout.ts";

export const licenseTemplate: TemplateDef = {
  id: "license",
  secretFields: ["licenseKey", "activationUrl"],
  subject(_brand, data) {
    return `Twój klucz licencji: ${data.productName || ""}`;
  },
  render(brand, data) {
    const greeting = data.name ? `Witaj ${data.name},` : "Witaj,";
    const intro = "Twoja licencja jest gotowa. Poniżej znajdziesz jej szczegóły:";
    const rows = [
      { label: "Produkt", value: data.productName || "" },
      { label: "Plan", value: data.tier || "" },
      { label: "Domena", value: data.domain || "" },
    ];
    const licenseKey = data.licenseKey || "";
    const licenseHtml = licenseKey.trim() ? paragraph("Klucz licencji") + codeBox(licenseKey) : "";
    const activationUrl = data.activationUrl || "";
    const label = "Aktywuj licencję";
    return {
      heading: "Twój klucz licencji",
      bodyHtml: [paragraph(greeting), paragraph(intro), summaryTable(rows), licenseHtml,
        ctaButton(brand, activationUrl, label), data.instructions ? paragraph(data.instructions) : ""].join("\n"),
      bodyText: [greeting, intro, ...[...rows, { label: "Klucz licencji", value: licenseKey }].filter((row) => row.value).map((row) => `${row.label}: ${row.value}`),
        ctaText(activationUrl, label), data.instructions || ""].filter(Boolean).join("\n\n"),
      previewText: `Licencja: ${data.productName || ""}`,
    };
  },
};
