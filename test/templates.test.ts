import { describe, it, expect } from "vitest";
import { escapeHtml, humanizeLabel, renderEmail } from "../src/templates";
import { getBrand } from "../src/registry";
import type { RenderInput } from "../src/types";

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`< > & " '`)).toBe("&lt; &gt; &amp; &quot; &#39;");
  });

  it("escapes & first so entities are not double-broken", () => {
    expect(escapeHtml("<a&b>")).toBe("&lt;a&amp;b&gt;");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("Jan Kowalski 123")).toBe("Jan Kowalski 123");
  });
});

describe("humanizeLabel", () => {
  it("maps known keys to Polish labels", () => {
    expect(humanizeLabel("email")).toBe("E-mail");
    expect(humanizeLabel("name")).toBe("Imię i nazwisko");
    expect(humanizeLabel("phone")).toBe("Telefon");
    expect(humanizeLabel("type")).toBe("Rodzaj konsultacji");
    expect(humanizeLabel("topic")).toBe("Temat");
    expect(humanizeLabel("person")).toBe("Specjalista");
    expect(humanizeLabel("message")).toBe("Wiadomość");
    expect(humanizeLabel("gdpr")).toBe("Zgoda RODO");
  });

  it("matches known keys case-insensitively", () => {
    expect(humanizeLabel("EMAIL")).toBe("E-mail");
    expect(humanizeLabel("Imię i nazwisko")).toBe("Imię i nazwisko");
  });

  it("Title-Cases unknown keys and splits separators", () => {
    expect(humanizeLabel("company_name")).toBe("Company Name");
    expect(humanizeLabel("preferred-date")).toBe("Preferred Date");
    expect(humanizeLabel("foo")).toBe("Foo");
  });
});

function baseInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    subject: "Test subject",
    fields: [
      { key: "name", value: "Jane Smith" },
      { key: "email", value: "jane@example.com" },
    ],
    meta: { receivedAt: "2026-06-10T10:00:00.000Z", origin: "https://acme.example", ip: "1.2.3.4" },
    ...overrides,
  };
}

describe("renderEmail", () => {
  // Use the acme demo brand (has logoUrl, address, phone in theme)
  const brand = getBrand("acme")!;

  it("includes the brand name", () => {
    const { html, text } = renderEmail(brand, baseInput());
    expect(html).toContain("Acme Inc.");
    expect(text).toContain("Acme Inc.");
  });

  it("renders a known field label", () => {
    const { html } = renderEmail(brand, baseInput());
    expect(html).toContain("Imię i nazwisko");
    expect(html).toContain("Jane Smith");
  });

  it("escapes a field value containing <script>", () => {
    const { html } = renderEmail(
      brand,
      baseInput({
        fields: [{ key: "name", value: "<script>alert(1)</script>" }],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("omits empty fields", () => {
    const { html, text } = renderEmail(
      brand,
      baseInput({
        fields: [
          { key: "name", value: "Jane" },
          { key: "phone", value: "" },
        ],
      }),
    );
    expect(html).not.toContain("Telefon");
    expect(text).not.toContain("Telefon");
  });

  it("renders the message as its own block when present", () => {
    const { html, text } = renderEmail(
      brand,
      baseInput({ message: "Hello, I have a question." }),
    );
    expect(html).toContain("Wiadomość");
    expect(html).toContain("Hello, I have a question.");
    expect(text).toContain("Hello, I have a question.");
  });

  it("uses the brand logo when logoUrl is set", () => {
    const { html } = renderEmail(brand, baseInput());
    expect(html).toContain(brand.theme.logoUrl!);
  });

  it("includes meta footer details", () => {
    const { html } = renderEmail(brand, baseInput());
    expect(html).toContain("2026-06-10T10:00:00.000Z");
    expect(html).toContain("1.2.3.4");
  });
});
