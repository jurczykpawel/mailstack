import { describe, expect, it } from "vitest";
import { configSchema, parseConfig } from "../src/core/config/schema";
import { loadConfig } from "../src/core/config/load";
import example from "../config/mailstack.example.json";
import { TEMPLATES } from "../src/templates/index";
const BRANDS = example.brands;
const clientDefaults = { id: "demo-client", tokenSha256: "a".repeat(64), scopes: ["send"], recipientOverride: false, attachments: false };

function config() {
  return {
    version: 1, brands: structuredClone(BRANDS),
    logging: {
      defaults: { level: "meta", contentDays: 30, metaDays: 90, requireLog: false, resend: "off", alertOn: [], show: [], includeSecrets: false },
      ceilings: { contentDays: 90, metaDays: 400, auditDays: 400 }, patterns: [], brands: {},
    },
  };
}
type Draft = ReturnType<typeof config>;
function invalid(change: (value: Draft) => void, path: string) {
  const value = config(); change(value);
  expect(() => parseConfig(value)).toThrow(path);
}

describe("configuration schema", () => {
  it("retains every Brand field", () => expect(parseConfig(config()).brands).toEqual(BRANDS));
  it.each([
    ["content retention order", (v: Draft) => { v.logging.defaults.contentDays = 100; }, "$.logging.defaults.contentDays"],
    ["content ceiling", (v: Draft) => { v.logging.ceilings.contentDays = 20; }, "$.logging.defaults.contentDays"],
    ["metadata ceiling", (v: Draft) => { v.logging.ceilings.metaDays = 80; }, "$.logging.defaults.metaDays"],
    ["replay level", (v: Draft) => { v.logging.defaults.resend = "replay"; }, "$.logging.defaults.resend"],
    ["source callback", (v: Draft) => { v.logging.defaults.resend = "source"; }, "$.logging.defaults.resend"],
    ["secret level", (v: Draft) => { v.logging.defaults.includeSecrets = true; }, "$.logging.defaults.includeSecrets"],
    ["fractional days", (v: Draft) => { v.logging.defaults.contentDays = 1.5; }, "$.logging.defaults.contentDays"],
    ["zero days", (v: Draft) => { v.logging.defaults.contentDays = 0; }, "$.logging.defaults.contentDays"],
  ] as const)("rejects invalid %s", (_name, change, path) => invalid(change, path));
  it("rejects unknown keys at every declared object", () => {
    for (const path of [[], ["logging"], ["logging", "defaults"], ["logging", "ceilings"], ["brands", "acme"], ["brands", "acme", "theme"], ["logging", "brands", "acme"], ["logging", "brands", "acme", "defaults"], ["logging", "brands", "acme", "templates", "payment"]]) {
      const value = { ...config(), logging: { ...config().logging, brands: { acme: { defaults: {}, templates: { payment: {} } } } } };
      let target: Record<string, unknown> = value;
      for (const key of path) target = target[key] as Record<string, unknown>;
      target.extra = true;
      expect(() => parseConfig(value)).toThrow([...path, "extra"].join("."));
    }
  });
  it("validates pattern definitions and regular expressions", () => {
    for (const pattern of [{ name: "x", regex: "[" }, { name: "x" }, { name: "x", regex: "x", urlParams: ["token"] }, { name: "x", urlParams: [] }, { name: "x", regex: "x", extra: true }]) {
      expect(() => parseConfig({ ...config(), logging: { ...config().logging, patterns: [pattern] } })).toThrow("$.logging.patterns.0");
    }
  });
  it("validates inherited brand and template policies", () => {
    for (const overrides of [{ defaults: { metaDays: 10 } }, { templates: { payment: { resend: "replay" } } }, { templates: { payment: { includeSecrets: true } } }]) {
      expect(() => parseConfig({ ...config(), logging: { ...config().logging, brands: { acme: overrides } } })).toThrow("$.logging.brands.acme");
    }
  });
  it("checks secretFields before accepting replay", () => {
    const value = config(); value.logging.defaults.level = "full"; value.logging.defaults.resend = "replay";
    expect(() => parseConfig(value, { payment: { secretFields: ["key"] } })).toThrow("$.logging.defaults.resend");
  });
  it("accepts replay for projected content without secretFields", () => {
    const value = config(); value.logging.defaults.level = "masked"; value.logging.defaults.resend = "replay";
    expect(parseConfig(value).logging.defaults.resend).toBe("replay");
  });
  it("requires a callback matching the effective brand and template", () => {
    const value = { ...config(), clients: [{ ...clientDefaults, brands: ["demo"], templates: ["payment"], resendCallback: { url: "https://example.com/resend", secretEnv: "RESEND_SECRET" } }] };
    const logging = { ...value.logging, brands: { acme: { templates: { payment: { resend: "source" } } } } };
    expect(() => parseConfig({ ...value, logging })).toThrow("$.logging.brands.acme.templates.payment.resend");
    value.clients[0].brands = ["acme"];
    expect(parseConfig({ ...value, logging }).clients).toEqual(value.clients);
  });
  it("accepts deferred sections without interpreting their unrelated fields", () => {
    expect(parseConfig({ ...config(), events: [], alerts: "later" }).alerts).toBe("later");
  });
  it("reports JSON and version errors without input values", () => {
    expect(() => loadConfig("{" )).toThrow("$: invalid JSON");
    expect(() => parseConfig({ ...config(), version: 2 })).toThrow("$.version");
    expect(() => parseConfig({ ...config(), brands: { acme: { ...BRANDS.acme, id: "demo" } } })).toThrow("$.brands.acme.id");
  });
  it("requires an audit sink for secret archives and emits the boot entry", () => {
    const value = config(); value.logging.defaults.level = "full"; value.logging.defaults.includeSecrets = true;
    const entries: string[] = [];
    expect(() => loadConfig(JSON.stringify(value))).toThrow("$.logging.defaults.includeSecrets");
    loadConfig(JSON.stringify(value), { audit: (event) => { entries.push(event); } });
    expect(entries).toContain("policy.secret_archive_enabled");
    expect(() => loadConfig(JSON.stringify(value), { audit: () => { throw new Error("unavailable"); } })).toThrow();
  });
});

it("applies policy validation through the exported zod schema", () => {
  const value = config(); value.logging.defaults.resend = "replay";
  expect(configSchema.safeParse(value).success).toBe(false);
});
it("accepts a global source policy covered by clients for every registered template", () => {
  const value = config(); value.logging.defaults.resend = "source";
  const client = { ...clientDefaults, brands: ["acme", "demo"], templates: ["contact", "welcome", "received", "payment", "notice"], resendCallback: { url: "https://example.com/resend", secretEnv: "RESEND_SECRET" } };
  expect(() => parseConfig({ ...value, clients: [client] })).not.toThrow();
  client.templates = ["payment"];
  expect(() => parseConfig({ ...value, clients: [client] })).toThrow("$.logging.defaults.resend");
});
it("validates default policies even when the brand registry is empty", () => {
  const value = config(); value.logging.defaults.resend = "replay";
  expect(() => parseConfig({ ...value, brands: {} })).toThrow("$.logging.defaults.resend");
});

it("reads registered template policy metadata at validation time", () => {
  const value = config(); value.logging.defaults.level = "masked"; value.logging.defaults.resend = "replay";
  const previous = TEMPLATES.payment.secretFields;
  try {
    TEMPLATES.payment.secretFields = ["key"];
    expect(() => parseConfig(value)).toThrow("$.logging.defaults.resend");
  } finally { TEMPLATES.payment.secretFields = previous; }
});

it("accepts an optional Turnstile action string", () => {
  const value = config();
  const brands = { ...value.brands, acme: { ...value.brands.acme, turnstileAction: "contact" } };
  expect(parseConfig({ ...value, brands }).brands.acme).toMatchObject({ turnstileAction: "contact" });
  expect(() => parseConfig({ ...value, brands: { ...brands, acme: { ...brands.acme, turnstileAction: 42 } } })).toThrow("$.brands.acme.turnstileAction");
});
