import { expect, it } from "vitest";
import { getBrand } from "../src/registry";
import { getTemplate, renderLayout } from "../src/templates/index";

const data = {
  name: "Jane & Smith", email: "jane@example.com", message: "Hello\nWorld", type: "Consultation",
  intro: "Welcome", body: "Details", ctaUrl: "https://example.com/start", ctaLabel: "Open",
  refId: "REF-1", summary: "Consultation", amount: "149.00", currency: "USD", item: "Pro",
  orderId: "ORD-1", date: "2026-06-10", invoiceUrl: "https://example.com/invoice",
  heading: "Notice", paragraphs: "First\n\nSecond",
};
for (const brandId of ["acme", "demo"]) {
  for (const id of ["contact", "welcome", "received", "payment", "notice"]) {
    it(`${brandId}/${id} retains its rendering`, () => {
      const brand = getBrand(brandId)!;
      const template = getTemplate(id)!;
      const body = template.render(brand, data);
      expect({ subject: template.subject(brand, data), body, ...renderLayout(brand, body) }).toMatchSnapshot();
    });
  }
}
