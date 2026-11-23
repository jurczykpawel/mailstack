import { expect, it } from "vitest";
import { compiledTemplates, getBrand } from "../src/core/config";
import { TEMPLATES } from "../src/templates/index";
import { prepareEmail } from "../src/templates/prepare";

const data = {
  name: "Jane & Smith", email: "jane@example.com", message: "Hello\nWorld", type: "Consultation", intro: "Welcome", body: "Details",
  ctaUrl: "https://example.com/start", ctaLabel: "Open", refId: "REF-1", summary: "Consultation", amount: "149.00", currency: "USD",
  item: "Pro", orderId: "DR-1042", date: "2026-06-10", invoiceUrl: "https://example.com/invoice", heading: "Notice", paragraphs: "First\n\nSecond",
  productName: "Pro Plan", tier: "Team", domain: "acme.example", licenseKey: "KEY-1234-5678", activationUrl: "https://example.com/activate",
  transactionId: "pi_1", paymentId: "cs_1", refundId: "re_1", isFullRefund: "true", totalRefunded: "149.00", refundedAt: "2026-06-11",
  holder: "Acme", account: "PL00 0000", bank: "Bank", title: "DR-1042", deadline: "2026-06-12", orderUrl: "https://example.com/order",
};
it.each(Object.keys(TEMPLATES))("%s renders byte for byte without theme options", id => {
  const { html, text, subject } = prepareEmail(getBrand("acme")!, TEMPLATES[id], data, { plans: compiledTemplates });
  expect({ subject, html, text }).toMatchSnapshot();
});
