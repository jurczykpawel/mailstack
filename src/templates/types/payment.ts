import { Recipe } from "../recipe.ts";
import type {
  Brand,
  JsonLdBlock,
  RenderedBody,
  TemplateData,
  TemplateDef,
} from "../../types.ts";
import { ctaText } from "../layout.ts";
import { viewAction } from "../../markup/index.ts";

const paymentHeading = (data: TemplateData) => data.settledVia === 'bank_transfer' ? 'Płatność otrzymana' : 'Potwierdzenie płatności';

/** Payment confirmation with an amount summary and optional invoice CTA. */
export const paymentTemplate: TemplateDef = {
  id: "payment",
  maskedFields: ["amount", "currency", "item", "description", "orderId", "date"],
  requiredFields: ["amount", "currency", "item", "orderId"],

  subject(_brand: Brand, data: TemplateData, recipe = new Recipe()): string {
    const orderId = (data.orderId || "").trim();
    return `${recipe.copy(data.settledVia === "bank_transfer" ? "transferHeading" : "branchHeading", paymentHeading(data))}${orderId ? " - " + orderId : ""}`;
  },

  render(brand: Brand, data: TemplateData, recipe = new Recipe()): RenderedBody {
    const name = (data.name || "").trim();
    const amount = (data.amount || "").trim();
    const currency = (data.currency || "PLN").trim() || "PLN";
    const item = (data.item || data.description || "").trim();
    const orderId = (data.orderId || "").trim();
    const date = (data.date || "").trim();
    const invoiceUrl = (data.invoiceUrl || "").trim();

    const heading = recipe.copy(data.settledVia === "bank_transfer" ? "transferHeading" : "branchHeading", paymentHeading(data));
    const greeting = name ? recipe.copy("greetingWithName", `Witaj ${name},`) : recipe.copy("greetingWithoutName", "Witaj,");
    const intro = recipe.copy(data.settledVia === 'bank_transfer' ? 'transferIntro' : 'intro', data.settledVia === 'bank_transfer' ? 'Otrzymaliśmy Twój przelew. Dziękujemy za płatność. Poniżej podsumowanie:' : 'Dziękujemy za płatność. Poniżej podsumowanie:');

    const amountValue = amount ? `${amount} ${currency}`.trim() : "";
    const rows = [
      { label: recipe.label("amount", "Kwota"), value: amountValue },
      { label: recipe.label("item", "Pozycja"), value: item },
      { label: recipe.label("orderId", "Nr zamówienia"), value: orderId },
      { label: recipe.label("date", "Data"), value: date },
    ];

    const htmlParts: string[] = [
      recipe.paragraph(greeting),
      recipe.paragraph(intro),
      recipe.table(rows),
      recipe.button(brand, invoiceUrl, recipe.cta("invoice", "Pobierz fakturę")),
    ];

    const textParts: string[] = [greeting, intro];
    for (const r of rows) {
      if (r.value.trim() !== "") textParts.push(`${r.label}: ${r.value}`);
    }
    const cta = ctaText(invoiceUrl, recipe.cta("invoice", "Pobierz fakturę"));
    if (cta) textParts.push(cta);

    // Auto-markup: a Gmail action button. Prefer an explicit order URL; fall back
    // to the invoice URL. Absent both -> no block (fail-soft, email unchanged).
    const orderUrl = (data.orderUrl || "").trim();
    const actionUrl = orderUrl || invoiceUrl;
    const jsonLd: JsonLdBlock[] = [];
    if (actionUrl) {
      const action = viewAction({
        name: orderUrl ? recipe.cta("orderMarkup", "Zobacz zamówienie") : recipe.cta("invoice", "Pobierz fakturę"),
        url: actionUrl,
      });
      if (action) jsonLd.push(action);
    }

    return {
      heading,
      bodyHtml: recipe.html(htmlParts),
      bodyText: recipe.text(textParts),
      previewText: amountValue
        ? `${heading}: ${amountValue}`
        : intro,
      jsonLd: jsonLd.length ? jsonLd : undefined,
    };
  },
};
