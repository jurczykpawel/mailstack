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
