import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { ctaButton, ctaText, paragraph, summaryTable } from "../layout";

/** Payment confirmation with an amount summary and optional invoice CTA. */
export const paymentTemplate: TemplateDef = {
  id: "payment",

  subject(_brand: Brand, data: TemplateData): string {
    const orderId = (data.orderId || "").trim();
    return `Potwierdzenie płatności${orderId ? " - " + orderId : ""}`;
  },

  render(brand: Brand, data: TemplateData): RenderedBody {
    const name = (data.name || "").trim();
    const amount = (data.amount || "").trim();
    const currency = (data.currency || "PLN").trim() || "PLN";
    const item = (data.item || data.description || "").trim();
    const orderId = (data.orderId || "").trim();
    const date = (data.date || "").trim();
    const invoiceUrl = (data.invoiceUrl || "").trim();

    const heading = "Potwierdzenie płatności";
    const greeting = name ? `Witaj ${name},` : "Witaj,";
    const intro = "Dziękujemy za płatność. Poniżej podsumowanie:";

    const amountValue = amount ? `${amount} ${currency}`.trim() : "";
    const rows = [
      { label: "Kwota", value: amountValue },
      { label: "Pozycja", value: item },
      { label: "Nr zamówienia", value: orderId },
      { label: "Data", value: date },
    ];

    const htmlParts: string[] = [
      paragraph(greeting),
      paragraph(intro),
      summaryTable(rows),
      ctaButton(brand, invoiceUrl, "Pobierz fakturę"),
    ];

    const textParts: string[] = [greeting, intro];
    for (const r of rows) {
      if (r.value.trim() !== "") textParts.push(`${r.label}: ${r.value}`);
    }
    const cta = ctaText(invoiceUrl, "Pobierz fakturę");
    if (cta) textParts.push(cta);

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
      previewText: amountValue
        ? `Potwierdzenie płatności: ${amountValue}`
        : intro,
    };
  },
};
