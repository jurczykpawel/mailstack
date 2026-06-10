import { describe, it, expect } from "vitest";
import { getTemplate } from "../src/templates/index";
import { renderLayout } from "../src/templates/layout";
import { getBrand } from "../src/registry";
import type { TemplateData, TemplateDef } from "../src/types";

// Use the demo `acme` brand (has name, address, phone, autoReply, theme)
const brand = getBrand("acme")!;

/** Render a template through the shared layout, like the handler does. */
function render(def: TemplateDef, data: TemplateData) {
  const body = def.render(brand, data);
  const wrapped = renderLayout(brand, body);
  return { ...wrapped, body, subject: def.subject(brand, data) };
}

describe("template registry", () => {
  it("returns known templates", () => {
    for (const id of ["contact", "welcome", "received", "payment", "notice"]) {
      expect(getTemplate(id)?.id).toBe(id);
    }
  });

  it("returns undefined for an unknown template", () => {
    expect(getTemplate("nope")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
  });

  it("marks only contact as publicAllowed", () => {
    expect(getTemplate("contact")?.publicAllowed).toBe(true);
    expect(getTemplate("welcome")?.publicAllowed).toBeFalsy();
    expect(getTemplate("payment")?.publicAllowed).toBeFalsy();
    expect(getTemplate("received")?.publicAllowed).toBeFalsy();
    expect(getTemplate("notice")?.publicAllowed).toBeFalsy();
  });
});

describe("every template stays on-brand and escapes input", () => {
  const cases: Array<[string, TemplateData]> = [
    ["contact", { name: "<script>alert(1)</script>", email: "a@b.com" }],
    ["welcome", { name: "<script>alert(1)</script>", intro: "Hello" }],
    ["received", { name: "<script>alert(1)</script>", refId: "R-1" }],
    ["payment", { name: "<script>alert(1)</script>", amount: "100" }],
    ["notice", { heading: "<script>alert(1)</script>", paragraphs: "Content" }],
  ];

  it.each(cases)("%s includes the brand name", (id, data) => {
    const { html, text } = render(getTemplate(id)!, data);
    expect(html).toContain("Acme Inc.");
    expect(text).toContain("Acme Inc.");
  });

  it.each(cases)("%s escapes a <script> field", (id, data) => {
    const { html } = render(getTemplate(id)!, data);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("welcome", () => {
  it("greets by name and shows a CTA when ctaUrl is given", () => {
    const { html, text, subject } = render(getTemplate("welcome")!, {
      name: "Alice",
      intro: "Good to see you.",
      ctaUrl: "https://example.com/start",
      ctaLabel: "Get started",
    });
    expect(subject).toBe("Witaj w Acme Inc.");
    expect(html).toContain("Witaj, Alice w Acme Inc.!");
    expect(html).toContain("https://example.com/start");
    expect(html).toContain("Get started");
    expect(text).toContain("Get started: https://example.com/start");
  });

  it("omits the CTA button when no ctaUrl (footer link still present)", () => {
    const { html, body } = render(getTemplate("welcome")!, { intro: "Hey" });
    // The rendered body carries no CTA button markup...
    expect(body.bodyHtml).not.toContain("<a href");
    // ...though the layout footer always links the brand site.
    expect(html).toContain('<a href="https://acme.example"');
  });
});

describe("received", () => {
  it("renders the ack copy and optional refId", () => {
    const { html, subject } = render(getTemplate("received")!, {
      name: "Jan",
      refId: "ZG-2026-001",
    });
    expect(subject).toBe("Potwierdzenie: otrzymaliśmy Twoje zgłoszenie");
    expect(html).toContain("Dziękujemy za wiadomość");
    expect(html).toContain("odezwiemy się wkrótce");
    expect(html).toContain("ZG-2026-001");
  });
});

describe("payment", () => {
  it("shows the amount and order id in subject + body", () => {
    const { html, text, subject } = render(getTemplate("payment")!, {
      name: "Jan",
      amount: "149.00",
      currency: "PLN",
      item: "Webinar TSR",
      orderId: "ORD-5512",
      date: "2026-06-10",
    });
    expect(subject).toBe("Potwierdzenie płatności - ORD-5512");
    expect(html).toContain("Potwierdzenie płatności");
    expect(html).toContain("149.00 PLN");
    expect(html).toContain("ORD-5512");
    expect(html).toContain("Webinar TSR");
    expect(text).toContain("Kwota: 149.00 PLN");
    expect(text).toContain("Nr zamówienia: ORD-5512");
  });

  it("defaults currency to PLN and omits empty rows", () => {
    const { html, subject } = render(getTemplate("payment")!, {
      amount: "50",
    });
    expect(subject).toBe("Potwierdzenie płatności");
    expect(html).toContain("50 PLN");
    expect(html).not.toContain("Nr zamówienia");
  });

  it("shows the invoice CTA only when invoiceUrl is present", () => {
    const withInvoice = render(getTemplate("payment")!, {
      amount: "50",
      invoiceUrl: "https://example.com/fv/1.pdf",
    });
    expect(withInvoice.html).toContain("Pobierz fakturę");
    expect(withInvoice.html).toContain("https://example.com/fv/1.pdf");

    const without = render(getTemplate("payment")!, { amount: "50" });
    expect(without.html).not.toContain("Pobierz fakturę");
  });
});

describe("notice", () => {
  it("renders multiple paragraphs and a CTA", () => {
    const { html, text, subject } = render(getTemplate("notice")!, {
      heading: "Maintenance",
      paragraphs: "First paragraph.\n\nSecond paragraph.",
      ctaUrl: "https://example.com/status",
      ctaLabel: "Status",
    });
    expect(subject).toBe("Maintenance");
    expect(html).toContain("Maintenance");
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
    expect(html).toContain("https://example.com/status");
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph.");
  });

  it("falls back to data.subject then brand name for the subject", () => {
    expect(getTemplate("notice")!.subject(brand, { subject: "X" })).toBe("X");
    expect(getTemplate("notice")!.subject(brand, { heading: "H" })).toBe("H");
    expect(getTemplate("notice")!.subject(brand, {})).toBe("Acme Inc.");
  });
});
