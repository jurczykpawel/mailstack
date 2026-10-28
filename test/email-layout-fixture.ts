import type { Brand, TemplateData } from "../src/types.ts";
import { getTemplate, renderLayout } from "../src/templates/index.ts";

export const longUrl = "https://selfware.example/request?ref=" + "a".repeat(180);
export const longKey = "LICENSE-" + "X".repeat(370) + "-END4";
export const layoutBrand: Brand = {
  id: "acme", name: "Acme", from: "Acme <hello@acme.example>", to: ["inbox@acme.example"],
  allowedOrigins: ["https://acme.example"], subjectPrefix: "Wiadomość testowa",
  theme: { accent: "#0064BC", siteUrl: longUrl, address: "Ż".repeat(400), phone: "+00 000 000 000" },
};

export const layoutCases: Array<{ id: string; template: string; data: TemplateData; values: string[] }> = [
  ...["Link do zgłoszenia " + longUrl, "Ż".repeat(50), "Ż".repeat(400), "Ż ".repeat(200).trim()].map((message, i) => ({
    id: `contact-${i}`, template: "contact", data: { name: "Jane", email: "jane@acme.example", message,
      ["label".repeat(30)]: "value".repeat(80), gdpr: "no", qaField: "<script>END4</script>" },
    values: [message, "value".repeat(80), "<script>END4</script>"],
  })),
  { id: "contact-40", template: "contact", data: {
    message: "Ż".repeat(400),
    ...Object.fromEntries(Array.from({ length: 39 }, (_, i) => [`field${i}`, `Pole ${i} END4`])),
  }, values: ["Ż".repeat(400), ...Array.from({ length: 39 }, (_, i) => `Pole ${i} END4`)] },
  { id: "notice", template: "notice", data: { heading: "Ż".repeat(100), paragraphs: longUrl + "\n\n" + "Ż".repeat(400), ctaUrl: longUrl, ctaLabel: "Ż".repeat(100) }, values: [longUrl, "Ż".repeat(400)] },
  { id: "notice-blocks", template: "notice", data: { paragraphs: `## ${longUrl}\n\n- ${"Ż".repeat(400)}\n\n\`\`\`\n${longKey}\n\`\`\`` }, values: [longUrl, "Ż".repeat(400), longKey] },
  { id: "license", template: "license", data: { name: "Jane", productName: "Produkt Żółw", licenseKey: longKey, activationUrl: longUrl, instructions: "Instrukcje END4" }, values: [longKey, "Instrukcje END4"] },
  { id: "payment", template: "payment", data: { amount: "49.99", currency: "USD", orderId: "ORDER-END4", invoiceUrl: longUrl }, values: ["49.99", "USD", "ORDER-END4"] },
  { id: "welcome", template: "welcome", data: { name: "Jane", intro: longUrl, body: "Ż".repeat(400), ctaUrl: longUrl, ctaLabel: "Otwórz END4" }, values: [longUrl, "Ż".repeat(400), "Otwórz END4"] },
  { id: "received", template: "received", data: { name: "Jane", refId: "REF-END4", summary: longUrl }, values: [longUrl, "REF-END4"] },
];

export function renderLayoutCase(entry: typeof layoutCases[number]) {
  return renderLayout(layoutBrand, getTemplate(entry.template)!.render(layoutBrand, entry.data));
}
