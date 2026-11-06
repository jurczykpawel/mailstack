import { describe, expect, it } from "vitest";
import example from "../config/mailstack.example.json";
import { loadConfig } from "../src/core/config/load.ts";
import { configSchema, parseConfig } from "../src/core/config/schema.ts";
import { templatePlans, definition } from "../src/templates/config.ts";

function input(global: unknown = {}, local: unknown = {}) {
  return { ...structuredClone(example), mailTemplates: { version: 1, ...global as object },
    brands: { acme: { ...structuredClone(example.brands.acme), mailTemplates: local as object } } as Record<string, typeof example.brands.acme & { mailTemplates: object }> };
}
const languages = { default: "pl", allowed: ["pl", "en", "en-US"] };
const textBlock = { id: "intro", kind: "paragraph", text: "Hello {name}" };
const body = { blocks: [textBlock] };
describe("mail template configuration", () => {
  it("keeps the old configuration and version-only presentation empty", () => {
    expect(parseConfig(example).brands).toEqual(example.brands);
    expect(definition(templatePlans(parseConfig(input())), "acme", "payment")).toMatchObject({ fields: { amount: { kind: "text" } } });
    expect(definition(templatePlans(parseConfig(input())), "acme", "payment").body).toBeUndefined();
  });
  it("merges dictionaries, replaces body and keeps declarations in the base", () => {
    const value = parseConfig(input({ defaults: { labels: { name: "Name" } }, templates: { payment: {
      fields: { extra: { kind: "text" } }, secretFields: ["extra"], labels: { amount: "Amount" }, body,
    } } }, { templates: { payment: { labels: { amount: "Total" }, body: { blocks: [] } } } }));
    const result = definition(templatePlans(value), "acme", "payment");
    expect(result.labels).toEqual({ name: "Name", amount: "Total" });
    expect(result.body?.blocks).toEqual([]);
    expect(result.secretFields).toContain("extra");
    expect(result.fields?.extra.kind).toBe("text");
    expect(JSON.parse(JSON.stringify(templatePlans(value)))).toEqual(templatePlans(value));
    expect(templatePlans(value)).toBe(templatePlans(value));
  });
  it.each(["body", "subject", "heading", "previewText"])("requires matching locale coverage for neutral %s", key => {
    const neutral = key === "body" ? body : "Polski tekst";
    for (const scope of ["template", "kind"]) {
      const patch = { [key]: neutral };
      const local = scope === "template" ? { templates: { payment: patch } } : {
        forms: { selector: { byTemplate: { contact: "type" }, values: {}, empty: "question", otherwise: "question" },
          kinds: { question: { templates: { contact: patch } } } },
      };
      const id = scope === "template" ? "payment" : "contact";
      const kind = scope === "template" ? "" : "question";
      const global = { templates: { [id]: { locales: { en: { heading: "English" }, "en-US": {} } } } };
      const plans = templatePlans(parseConfig(input(global, { languages, ...local })));
      expect(plans.routes.acme[id][kind].en).toBeUndefined();
      expect(plans.routes.acme[id][kind].pl).toBeDefined();
      expect(plans.warnings.some(w => w.includes(key))).toBe(true);
      const withCoverage = { ...patch, locales: { en: { [key]: neutral } } };
      const covered = scope === "template" ? { templates: { payment: withCoverage } } : {
        forms: { ...local.forms!, kinds: { question: { templates: { contact: withCoverage } } } },
      };
      expect(templatePlans(parseConfig(input(global, { languages, ...covered }))).routes.acme[id][kind].en).toBeDefined();
    }
  });
  it("accepts six block kinds and the form selector", () => {
    const blocks = [textBlock, { id: "table", kind: "fieldTable", rows: [{ field: "email" }] },
      { id: "message", kind: "message", field: "message" }, { id: "meta", kind: "metadata", items: ["ip"] },
      { id: "cta", kind: "cta", url: { literal: "HTTPS://example.com/path" }, label: "Read" },
      { id: "code", kind: "code", field: "type" }];
    const value = parseConfig(input({}, { forms: {
      selector: { byTemplate: { contact: "type", received: "summary" }, values: { Question: "question" }, empty: "question", otherwise: "question" },
      kinds: { question: { templates: { contact: { body: { blocks } }, received: { subject: "Received" } } } },
    } }));
    expect(definition(templatePlans(value), "acme", "contact", "question").body?.blocks).toHaveLength(6);
  });
  it.each([
    [{ version: 2 }, {}, "mailTemplates.version"],
    [{ unknown: true }, {}, "mailTemplates.unknown"],
    [{ templates: { unknown: {} } }, {}, "mailTemplates.templates.unknown"],
    [{ defaults: { copy: { intro: "x" } } }, {}, "mailTemplates.defaults.copy.intro"],
    [{ templates: { payment: { copy: { typo: "x" } } } }, {}, "mailTemplates.templates.payment.copy.typo"],
    [{ templates: { payment: { heading: "{unknown}" } } }, {}, "mailTemplates.templates.payment.heading"],
    [{ templates: { payment: { heading: "{brand.name.constructor}" } } }, {}, "mailTemplates.templates.payment.heading"],
    [{ templates: { payment: { subject: "Line\nbreak" } } }, {}, "mailTemplates.templates.payment.subject"],
    [{ templates: { payment: { heading: " " } } }, {}, "mailTemplates.templates.payment.heading"],
    [{ templates: { payment: { fields: { amount: { kind: "url" } } } } }, {}, "mailTemplates.templates.payment.fields.amount"],
    [{ templates: { payment: { labels: { amount: null } } } }, {}, "mailTemplates.templates.payment.labels.amount"],
    [{ templates: { payment: { heading: "{{name}}" } } }, {}, "mailTemplates.templates.payment.heading"],
    [{ templates: { payment: { heading: ["a".repeat(3000), "b".repeat(2001)] } } }, {}, "mailTemplates.templates.payment.heading"],
    [{ templates: { payment: { body: { blocks: [textBlock, textBlock] } } } }, {}, "mailTemplates.templates.payment.body"],
    [{ templates: { payment: { body: { blocks: [{ id: "x", kind: "metadata", items: ["ip"] }] } } } }, {}, "mailTemplates.templates.payment.body"],
    [{ templates: { payment: { body: { blocks: [{ id: "x", kind: "cta", url: { field: "amount" }, label: "Read" }] } } } }, {}, "mailTemplates.templates.payment.body"],
    [{ templates: { contact: { body: { blocks: [{ id: "x", kind: "cta", url: { field: "email" }, label: "Read" }] } } } }, {}, "mailTemplates.templates.contact.body"],
    [{ templates: { received: { subject: "Hello {name}" } } }, {}, "mailTemplates.templates.received.subject"],
    [{ templates: { license: { heading: "{licenseKey}" } } }, {}, "mailTemplates.templates.license.heading"],
    [{}, { languages, defaults: { labels: { name: "Name" } } }, "brands.acme.mailTemplates.defaults"],
    [{ defaults: { copy: { greetingWithName: "Hi {name}" } } }, { languages }, "mailTemplates.defaults"],
    [{}, { languages: { default: "pl", allowed: ["en"] } }, "brands.acme.mailTemplates.languages"],
    [{}, { languages: { default: "pl", allowed: ["pl", "EN", "en"] } }, "brands.acme.mailTemplates.languages"],
    [{}, { languages: { default: "pl", allowed: ["pl", "zh-Hant-TW"] } }, "brands.acme.mailTemplates.languages"],
    [{}, { languages: { default: "pl", allowed: ["pl", "fr"] } }, "brands.acme.mailTemplates.languages.layout"],
    [{}, { templates: { payment: { locales: { en: {} } } } }, "brands.acme.mailTemplates.templates.payment.locales"],
    [{}, { languages, templates: { payment: { locales: { pl: {} } } } }, "brands.acme.mailTemplates.templates.payment.locales"],
    [{ templates: { payment: { locales: { en: { fields: { extra: { kind: "text" } } } } } } }, {}, "mailTemplates.templates.payment.locales.en.fields"],
    [{ templates: { payment: { locales: { en: { to: "a@example.com" } } } } }, {}, "mailTemplates.templates.payment.locales.en.to"],
  ])("rejects invalid declarations at their path %#", (global, local, path) => {
    const value = input(global, local);
    expect(() => loadConfig(JSON.stringify(value))).toThrow(path);
    expect(configSchema.safeParse(value).success).toBe(false);
  });
  it("checks global locales even when no brand uses them", () => {
    expect(() => parseConfig(input({ templates: { payment: { locales: { en: { heading: "{typo}" } } } } }))).toThrow("locales.en.heading");
  });
  it("rejects reserved dictionary keys without echoing their values", () => {
    const value = input({ templates: { payment: { fields: JSON.parse('{"constructor":{"kind":"text"}}') } } });
    expect(() => parseConfig(value)).toThrow("fields.constructor");
  });
  it("keeps compiled fragments immutable", () => {
    const plans = templatePlans(parseConfig(input({ templates: { payment: { heading: "Paid" } } })));
    expect(Object.isFrozen(plans)).toBe(true);
    expect(plans.fragments.every(fragment => Object.isFrozen(fragment))).toBe(true);
    expect(() => { plans.routes.acme.payment[""].other = []; }).toThrow();
  });
});

it("validates common declarations even with an empty brand registry", () => {
  expect(() => parseConfig({ ...input({ defaults: { copy: { typo: "x" } } }), brands: {} })).toThrow("mailTemplates.defaults.copy.typo");
});
it("checks neutral and unused locale patches before later overrides", () => {
  expect(() => parseConfig(input({}, { languages, templates: { payment: { heading: "{unknown}", locales: { en: { heading: "Hello" } } } } }))).toThrow("heading");
});
it.each(["branchHeading", "transferHeading"])("checks %s dependencies of builtin headers", slot => {
  expect(() => parseConfig(input({ templates: { payment: { fields: { private: { kind: "text" } }, secretFields: ["private"], copy: { [slot]: "{private}" } } } }))).toThrow("copy");
  expect(() => parseConfig(input({ templates: { payment: { fields: { private: { kind: "text" } }, secretFields: ["private"], copy: { [slot]: "{private}" }, subject: "Paid", heading: "Paid", previewText: "Paid" } } }))).not.toThrow();
});
it("does not read inherited names in field declarations", () => {
  expect(() => parseConfig(input({ templates: { payment: { fields: { toString: { kind: "text" } }, heading: "{toString}" } } }))).not.toThrow();
});
it("accepts literal braces in labels and fragment decorations", () => {
  expect(() => parseConfig(input({ templates: { payment: { labels: { item: "Item {" }, heading: [{ field: "name", prefix: "{", suffix: "}" }] } } }))).not.toThrow();
});
it("warns about sparse locales and unused body slots", () => {
  const plans = templatePlans(parseConfig(input({ templates: { payment: { body: { blocks: [] }, copy: { intro: "Hello" }, locales: { en: { heading: "Paid" } } } } }, { languages })));
  expect(plans.warnings.some(w => w.includes("inherited"))).toBe(true);
  expect(plans.warnings.some(w => w.includes("unused"))).toBe(true);
});
it("counts table, code and CTA references in the effective token budget", () => {
  const rows = Array.from({ length: 43 }, () => ({ field: "amount" }));
  const blocks = [{ id: "table", kind: "fieldTable", rows }, { id: "code", kind: "code", field: "amount" }];
  const heading = "{amount}".repeat(85);
  expect(() => parseConfig(input({ templates: { payment: { heading, body: { blocks } } } }))).toThrow("effective definition limit");
});
it.each([-1, 0, 1])("enforces the effective reference boundary %+i", offset => {
  const value = input({ templates: { payment: { heading: "{amount}".repeat(128 + offset) } } });
  expect(configSchema.safeParse(value).success).toBe(offset <= 0);
});
it.each([-1, 0, 1])("enforces the block boundary %+i", offset => {
  const blocks = Array.from({ length: 24 + offset }, (_, i) => ({ id: `p${i}`, kind: "paragraph", text: "x" }));
  expect(configSchema.safeParse(input({ templates: { payment: { body: { blocks } } } })).success).toBe(offset <= 0);
});
it.each([-1, 0, 1])("enforces label and Text boundaries %+i", offset => {
  for (const patch of [{ heading: "x".repeat(5000 + offset) }, { labels: { name: "x".repeat(160 + offset) } },
    { heading: Array.from({ length: 24 + offset }, () => "x") }]) {
    expect(configSchema.safeParse(input({ templates: { payment: patch } })).success).toBe(offset <= 0);
  }
});
it("bundles tokens before requests without re-reading inserted data", () => {
  const plans = templatePlans(parseConfig(input({ templates: { payment: { heading: "Hello {name}" } } })));
  expect(plans).toHaveProperty("texts");
  expect((plans as unknown as { texts: Record<string, unknown> }).texts["Hello {name}"]).toEqual(["Hello ", { field: "name" }]);
});
it.each([-1, 0, 1])("enforces merged fields and rows boundaries %+i", offset => {
  const fields = Object.fromEntries(Array.from({ length: 43 - 10 + offset }, (_, i) => [`f${i}`, { kind: "text" }]));
  expect(configSchema.safeParse(input({ templates: { payment: { fields } } })).success).toBe(offset <= 0);
  const rows = Array.from({ length: 43 + offset }, () => ({ field: "amount" }));
  expect(configSchema.safeParse(input({ templates: { payment: { body: { blocks: [{ id: "rows", kind: "fieldTable", rows }] } } } })).success).toBe(offset <= 0);
});
it.each([-1, 0, 1])("enforces form kinds, values and brand boundaries %+i", offset => {
  const kinds = Object.fromEntries(Array.from({ length: 16 + offset }, (_, i) => [`k${i}`, { templates: {} }]));
  const selector = { byTemplate: {}, values: {}, empty: "k0", otherwise: "k0" };
  expect(configSchema.safeParse(input({}, { forms: { selector, kinds } })).success).toBe(offset <= 0);
  const values = Object.fromEntries(Array.from({ length: 64 + offset }, (_, i) => [`v${i}`, "k0"]));
  expect(configSchema.safeParse(input({}, { forms: { selector: { ...selector, values }, kinds: { k0: { templates: {} } } } })).success).toBe(offset <= 0);
  const value = input();
  value.brands = Object.fromEntries(Array.from({ length: 64 + offset }, (_, i) => [`b${i}`, { ...structuredClone(example.brands.acme), id: `b${i}`, mailTemplates: {} }]));
  expect(configSchema.safeParse(value).success).toBe(offset <= 0);
});
it.each([-1, 0, 1])("enforces combined definition byte boundaries %+i", offset => {
  const patch = { heading: "x".repeat(4000), previewText: "y".repeat(4000), body: { blocks: [{ id: "p", kind: "paragraph", text: "z" }] } };
  const size = JSON.stringify(definition(templatePlans(parseConfig(input({ templates: { payment: patch } }))), "acme", "payment")).length;
  patch.body.blocks[0].text = "z".repeat(1 + 12 * 1024 - size + offset);
  expect(configSchema.safeParse(input({ templates: { payment: patch } })).success).toBe(offset <= 0);
});
it.each([-1, 0, 1])("enforces compiled combination boundaries %+i", offset => {
  const value = input();
  const forms = (n: number) => ({ selector: { byTemplate: { contact: "type" }, values: {}, empty: "k0", otherwise: "k0" }, kinds: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, { templates: {} }])) });
  value.brands = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`b${i}`, { ...structuredClone(example.brands.acme), id: `b${i}`, mailTemplates: { forms: forms(i === 63 ? 8 + offset : 8) } }]));
  const result = configSchema.safeParse(value);
  expect(result.success).toBe(offset <= 0);
  if (result.success) expect(JSON.stringify(templatePlans(result.data)).length).toBeLessThan(8 * 1024 * 1024);
});
it("validates a complete presentation with dictionaries, fragments and a replacement body", () => {
  expect(() => parseConfig(input({ templates: { payment: { labels: { amount: "Total" }, ctaLabels: { invoice: "Open invoice" } } } }, {
    templates: { payment: { subject: ["Purchase", { field: "orderId", prefix: " - " }], heading: "Thank you {name}",
      body: { blocks: [textBlock, { id: "details", kind: "fieldTable", rows: [{ field: "item" }, { field: "orderId" }] },
        { id: "invoice", kind: "cta", url: { field: "invoiceUrl" }, label: "Open invoice" }] } } },
  }))).not.toThrow();
});
it.each([-1, 0, 1])("enforces source UTF-8 byte boundaries %+i", offset => {
  const locales = Object.fromEntries(Array.from({ length: 53 }, (_, i) => [`${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`, { heading: "x".repeat(i === 52 ? 1 : 5000) }]));
  const value = input({ templates: { payment: { locales } } });
  locales.aa.heading = "x".repeat(4000);
  const sections: unknown[] = [value.mailTemplates, value.brands.acme.mailTemplates];
  for (const action of Object.values(example.sources.sellf.events)) if ("fieldsByLocale" in action) sections.push(action.fieldsByLocale);
  const size = new TextEncoder().encode(JSON.stringify(sections)).length;
  locales.ca.heading = "x".repeat(1 + 256 * 1024 - size + offset);
  expect(configSchema.safeParse(value).success).toBe(offset <= 0);
});
it("requires complete reachable confirmation outputs for an alternate template", () => {
  const value = input({}, { templates: { refund: { body: { blocks: [{ ...textBlock, text: "Received" }] } } } });
  Object.assign(value.brands.acme, { autoReplyTemplate: "refund" });
  expect(() => parseConfig(value)).toThrow("previewText");
  Object.assign(value.brands.acme.mailTemplates, { templates: { refund: { previewText: "Received", body: { blocks: [{ ...textBlock, text: "Received" }] } } } });
  expect(() => parseConfig(value)).not.toThrow();
});

it('retains an explicit declaration of an otherwise optional field', () => {
  const draft = input({ templates: { notice: { secretFields: ['ctaUrl'] } } });
  const logging = { ...draft.logging, brands: { acme: { templates: { notice: { level: 'masked', resend: 'replay' } } } } };
  expect(() => parseConfig({ ...draft, logging })).toThrow('template requires source or off');
});
