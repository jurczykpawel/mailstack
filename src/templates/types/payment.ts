import { purchaseLicenseSecrets, purchaseLicenseSlots } from "../../purchase-licenses.ts";
import type {
  Brand,
  JsonLdBlock,
  RenderedBody,
  TemplateData,
  TemplateDef,
} from "../../types.ts";
import { codeBox, ctaButton, ctaText, paragraph, summaryTable } from "../layout.ts";
import { viewAction } from "../../markup/index.ts";

/** Payment confirmation with an amount summary and optional invoice CTA. */
export const paymentTemplate: TemplateDef = {
  id: "payment",
  optionalSecretFields: purchaseLicenseSecrets,

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

    const licenses = purchaseLicenseSlots.filter(slot => data[slot.key]);
    if (licenses.length) {
      const instruction = "Wklej każdy klucz w ustawieniach licencji właściwego produktu. Każdy komponent aktywuje się oddzielnie.";
      const contact = `Jeśli potrzebujesz pomocy, napisz do: ${brand.to[0]}.`;
      htmlParts.push(paragraph("Twoje licencje"), paragraph(instruction));
      textParts.push("Twoje licencje", instruction);
      for (const slot of licenses) {
        const product = data[slot.product] || "Produkt";
        const label = `Otwórz aktywację: ${product}`;
        htmlParts.push(paragraph(product), codeBox(data[slot.key]), ctaButton(brand, data[slot.url] || "", label));
        textParts.push(`${product}:\n${data[slot.key]}`, ctaText(data[slot.url] || "", label));
      }
      htmlParts.push(paragraph(contact));
      textParts.push(contact);
    }

    // Auto-markup: a Gmail action button. Prefer an explicit order URL; fall back
    // to the invoice URL. Absent both -> no block (fail-soft, email unchanged).
    const orderUrl = (data.orderUrl || "").trim();
    const actionUrl = orderUrl || invoiceUrl;
    const jsonLd: JsonLdBlock[] = [];
    if (actionUrl) {
      const action = viewAction({
        name: orderUrl ? "Zobacz zamówienie" : "Pobierz fakturę",
        url: actionUrl,
      });
      if (action) jsonLd.push(action);
    }

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
      previewText: amountValue
        ? `Potwierdzenie płatności: ${amountValue}`
        : intro,
      jsonLd: jsonLd.length ? jsonLd : undefined,
    };
  },
};
