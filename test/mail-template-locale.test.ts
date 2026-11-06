import { expect, it } from "vitest";
import example from "../config/mailstack.example.json";
import { parseConfig } from "../src/core/config/schema.ts";
import { templatePlans } from "../src/templates/config.ts";
import { normalizeLocale, resolvePresentation } from "../src/templates/locale.ts";

function setup(allowed = ["pl", "en", "en-US"], translated: object = { en: { heading: "English" } }, defaultLocale = "pl") {
  const config = parseConfig({ ...example, mailTemplates: { version: 1, templates: { payment: { locales: translated } } },
    brands: { acme: { ...example.brands.acme, mailTemplates: { languages: { default: defaultLocale, allowed } } } } });
  const plans = templatePlans(config);
  return { config, plans, resolve: (input: unknown, id = "payment", kind = "") => resolvePresentation(plans, config.brands.acme, id, kind, input) };
}
it.each([
  ["EN-us", "en-US"], [" EN ", "en"], ["pl", "pl"], [" PL-pl ", null], ["zh-Hant-TW", null], ["es-419", null],
  ["en_US", null], ["en,pl", null], ["en\n", null], ["\ten", null], ["\u00a0en", null], ["", null], [false, null], [{}, null], [null, null], ["fr", "fr"],
])("normalizes a bounded locale: %j", (input, output) => expect(normalizeLocale(input)).toBe(output));
it.each([
  ["en-US", { en: { heading: "English" }, "en-US": { heading: "US" } }, ["pl", "en", "en-US"], "en-US"],
  ["en-US", { en: { heading: "English" } }, ["pl", "en", "en-US"], "en"],
  ["en-US", { "en-GB": { heading: "UK" } }, ["pl", "en-GB"], "pl"],
  ["en", {}, ["pl", "en"], "pl"], ["fr", { en: {} }, ["pl", "en"], "pl"],
  ["EN", { en: {} }, ["pl", "en"], "en"], [null, { en: {} }, ["pl", "en"], "pl"],
])("resolves exact, base and default per type %#", (input, translated, allowed, output) => {
  const s = setup(allowed, translated);
  expect(s.resolve(input).locale).toBe(output);
  expect(s.resolve(input, "contact").locale).toBe("pl");
});
it("uses a neutral base without languages and makes no historical language assumption", () => {
  const config = parseConfig({ ...example, mailTemplates: { version: 1 } });
  expect(resolvePresentation(templatePlans(config), config.brands.acme, "payment", "", "en").locale).toBeNull();
  expect(setup(["en", "pl"], {}, "en").resolve(null).locale).toBe("en");
});
it("returns one immutable handle per configured route for any number of inputs", () => {
  const s = setup();
  const first = s.resolve("en-US");
  expect(s.resolve("EN")).toBe(first);
  expect(Object.isFrozen(first.definition)).toBe(true);
  for (let i = 0; i < 2000; i++) expect(s.resolve(`unknown-${i}`)).toBe(s.resolve(null));
  const artifact = JSON.parse(JSON.stringify(s.plans));
  expect(resolvePresentation(artifact, s.config.brands.acme, "payment", "", "en-US")).toEqual(first);
});
it("uses the chosen kind and provenance when selecting a locale", () => {
  const s = setup();
  const draft = { ...example, mailTemplates: { version: 1, templates: { contact: { locales: { en: { heading: "Question" } } } } }, brands: { acme: {
    ...example.brands.acme, mailTemplates: { languages: { default: "pl", allowed: ["pl", "en"] }, forms: {
      selector: { byTemplate: { contact: "type" }, values: {}, empty: "question", otherwise: "question" },
      kinds: { question: { templates: { contact: { body: { blocks: [] } } } }, other: { templates: {} } },
    } },
  } } };
  const config = parseConfig(draft), plans = templatePlans(config);
  expect(resolvePresentation(plans, config.brands.acme, "contact", "question", "en").locale).toBe("pl");
  expect(resolvePresentation(plans, config.brands.acme, "contact", "other", "en").locale).toBe("en");
  expect(() => s.resolve("en", "constructor")).toThrow("unknown template combination");
  expect(() => s.resolve("en", "payment", "other")).toThrow("unknown template combination");
});
