import { expect, it } from "vitest";
import { parseConfig } from "../src/core/config/schema";
import { getTemplate, renderLayout } from "../src/templates";
import example from "../config/mailstack.example.json";

const brand = example.brands.acme;
const config = () => parseConfig(structuredClone(example));

it("classifies registered templates and validates license replay", () => {
  expect(getTemplate("contact")?.subjectRoles).toEqual(["email"]);
  expect(getTemplate("license")?.secretFields).toEqual(["licenseKey", "activationUrl"]);
  expect(getTemplate("payment")?.secretFields ?? []).toEqual([]);
  const value = config();
  value.logging.brands.acme = { templates: { license: { level: "masked", resend: "replay" } } };
  expect(() => parseConfig(value)).toThrow("$.logging.brands.acme.templates.license.resend");
});

it("renders the license template with shared layout", () => {
  const template = getTemplate("license")!;
  const input = { name: "Jane & Smith", productName: "Example Pro", tier: "Pro", domain: "example.com", licenseKey: "EXAMPLE-1234", activationUrl: "https://example.com/activate", instructions: "Wklej klucz w ustawieniach.\nZapisz zmiany." };
  const body = template.render(brand, input);
  const { html, text } = renderLayout(brand, body);
  expect({ subject: template.subject(brand, input), html: html.replace(/^[ \t]+$/gm, ""), text }).toMatchSnapshot();
});

it("renders long license keys in a wrapping code box below the summary", () => {
  const licenseKey = "EXAMPLE-" + "a".repeat(358) + "1234";
  expect(licenseKey).toHaveLength(370);
  const body = getTemplate("license")!.render(brand, { productName: "Example Pro", licenseKey });
  const code = body.bodyHtml.match(/<pre style="([^"]*)">([^<]*)<\/pre>/);
  expect(code).not.toBeNull();
  expect(code![1]).toContain("word-break:break-all");
  expect(code![1]).toContain("white-space:pre-wrap");
  expect(code![1]).toContain("user-select:text");
  expect(code![2]).toBe(licenseKey);
  const summary = body.bodyHtml.match(/<table\b[^>]*style="[^"]*overflow:hidden;[^"]*"[^>]*>[\s\S]*?<\/table>/)?.[0];
  expect(summary).toBeDefined();
  expect(summary).not.toContain(licenseKey);
  expect(summary).not.toContain("Klucz licencji");
  expect(body.bodyHtml).toMatch(/Klucz licencji<\/p>\s*<table\b/);
  expect(body.bodyText).toBe(`Witaj,\n\nTwoja licencja jest gotowa. Poniżej znajdziesz jej szczegóły:\n\nProdukt: Example Pro\n\nKlucz licencji: ${licenseKey}`);
});
