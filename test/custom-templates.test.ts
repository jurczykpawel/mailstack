import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import example from "../config/mailstack.example.json";
import custom from "../config/custom-templates.example.json";
import { config } from "../src/core/config";
import { readConfigFile } from "../src/core/config/node";
import { parseConfig, type Config, type Policy } from "../src/core/config/schema";
import { templatePlans } from "../src/templates/config";
import { getTemplate } from "../src/templates/index";
import { prepareEmail } from "../src/templates/prepare";
import { handleSend, prepareSend } from "../src/send";
import { handleSourceHook } from "../src/sources";
import { memoryStore } from "./store-fixture";
import type { Env, SendDeps, SendParams } from "../src/types";

type Draft = Config & Record<string, unknown>;
const draft = (mutate: (value: Draft) => void = () => {}) => {
  const value = { ...structuredClone(example), mailTemplates: structuredClone(custom.mailTemplates) } as unknown as Draft;
  mutate(value);
  return value;
};
const compile = (mutate?: (value: Draft) => void) => { const value = parseConfig(draft(mutate)); return { value, plans: templatePlans(value) }; };
const fails = (mutate: (value: Draft) => void, message: RegExp) => expect(() => parseConfig(draft(mutate))).toThrow(message);
const customOf = (value: Draft) => (value.mailTemplates as { custom: Record<string, Record<string, unknown>> }).custom;
const brand = example.brands.acme as unknown as Config["brands"][string];
const items = [{ qty: 1, name: "Dragon pendant", amount: "€49.00", description: "Engraving" }, { qty: 2, name: "Poster", amount: "€58.00" }];
const order = { firstName: "Anna", order: "DR-1042", items: JSON.stringify(items.map(i => ({ ...i, qty: String(i.qty) }))), total: "€116.00", shipTo: "Anna\nStreet 5", orderUrl: "https://shop.example/o/1" };
const policy = (level: Policy["level"], extra: Partial<Policy> = {}): Policy => ({ ...parseConfig(example).logging.defaults, level, ...extra });

describe("custom template configuration", () => {
  it("compiles named templates that only exist with a plan", () => {
    const { plans } = compile();
    const template = getTemplate("license-key", plans, "acme")!;
    expect(template.secretFields).toEqual(["licenseKey", "activationUrl"]);
    expect(template.requiredFields).toEqual(["productName", "licenseKey"]);
    expect(getTemplate("license-key")).toBeUndefined();
    expect(getTemplate("payment", plans, "acme")?.id).toBe("payment");
    expect(JSON.parse(JSON.stringify(plans))).toEqual(plans);
  });
  it("lets a brand template replace a global one", () => {
    const { plans } = compile(value => {
      (value.brands.acme as Record<string, unknown>).mailTemplates = { custom: { "license-key": { subject: "S", heading: "Brand heading", markdown: "Body" } } };
    });
    expect(prepareEmail(brand, getTemplate("license-key", plans, "acme")!, {}, { plans }).heading).toBe("Brand heading");
    expect(prepareEmail(brand, getTemplate("license-key", plans, "demo")!, { productName: "P", licenseKey: "K" }, { plans }).heading).toBe("Twój klucz licencji");
  });
  it.each<[string, (value: Draft) => void, RegExp]>([
    ["a built-in name", value => { customOf(value).payment = { subject: "S", heading: "H", markdown: "x" }; }, /custom\.payment/],
    ["both bodies", value => { customOf(value)["license-key"].html = "<p>x</p>"; }, /license-key/],
    ["no body", value => { delete customOf(value)["license-key"].markdown; }, /license-key/],
    ["layout none with Markdown", value => { customOf(value)["license-key"].layout = "none"; }, /license-key/],
    ["a secret in the subject", value => { customOf(value)["license-key"].subject = "Key {licenseKey}"; }, /license-key\.subject/],
    ["a secret inside a URL", value => { customOf(value)["license-key"].markdown = "[x](https://a.example/?k={licenseKey})"; }, /license-key/],
    ["an unknown component", value => { customOf(value)["license-key"].markdown = "[[video: x]]"; }, /license-key/],
    ["a replay policy with secrets", value => { value.logging.brands.acme = { templates: { "license-key": { level: "masked", resend: "replay" } } }; }, /resend/],
    ["a field URL in a public form block", value => { (value.mailTemplates as Record<string, unknown>).templates = { contact: { body: { blocks: [{ id: "m", kind: "markdown", markdown: "[[button: Go | {name}]]" }] } } }; }, /contact/],
    ["a text field used as a whole URL", value => { (value.mailTemplates as Record<string, unknown>).templates = { notice: { body: { blocks: [{ id: "m", kind: "markdown", markdown: "[x]({heading})" }] } } }; }, /notice/],
    ["a locale outside the brand languages", value => {
      (value.brands.acme as Record<string, unknown>).mailTemplates = { languages: { default: "pl", allowed: ["pl", "en"] }, custom: { x: { subject: "S", heading: "H", markdown: "x", locales: { de: { heading: "D" } } } } };
    }, /custom\.x\.locales\.de/],
    ["layout none with a Markdown locale", value => { customOf(value).doc = { subject: "S", heading: "H", layout: "none", html: "<html><body><p>x</p></body></html>", locales: { en: { markdown: "x" } } }; }, /custom\.doc/],
    ["a confirmation template using other fields", value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" }); customOf(value).thanks = { subject: "S", heading: "H", markdown: "Hi {name}, {email}" };
    }, /thanks/],
    ["a confirmation template with a field URL", value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" }); customOf(value).thanks = { subject: "S", heading: "H", markdown: "[x]({summary})" };
    }, /thanks/],
    ["a confirmation HTML text using other fields", value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" }); customOf(value).thanks = { subject: "S", heading: "H", html: "<p>Hi</p>", text: "Hi {email}" };
    }, /thanks/],
    ["an undeclared field in a fields component", value => { (value.mailTemplates as Record<string, unknown>).templates = { notice: { body: { blocks: [{ id: "m", kind: "markdown", markdown: "[[fields: undeclared=X]]" }] } } }; }, /notice/],
    ["an invalid theme colour", value => { (value.brands.acme.theme as Record<string, unknown>).background = "red;x:url(a)"; }, /theme\.background/],
  ])("rejects %s", (_name, mutate, message) => fails(mutate, message));
  it("allows a confirmation template limited to name and summary and falls back to the base locale", () => {
    const { plans, value: configured } = compile(value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" });
      (value.brands.acme as Record<string, unknown>).mailTemplates = { languages: { default: "pl", allowed: ["pl", "en", "en-GB"] },
        custom: { thanks: { subject: "Dziękujemy", heading: "Cześć {name}", markdown: "Temat: {summary}", locales: { en: { subject: "Thanks", heading: "Hi {name}", markdown: "Topic: {summary}" }, "en-GB": { heading: "Hello {name}" } } } } };
    });
    const email = prepareEmail(configured.brands.acme, getTemplate("thanks", plans, "acme")!, { name: "Anna", summary: "Order" }, { plans, locale: "en-GB", confirmation: true });
    expect([email.subject, email.heading, email.locale]).toEqual(["Thanks", "Hello Anna", "en-GB"]);
    expect(email.text).toContain("Topic: Order");
  });
  it("lets a source select a custom template and enforces its required fields", () => {
    const sources = (fields: Record<string, string>) => (value: Draft) => {
      value.sources = { shop: { signature: { scheme: "bearer-only" }, envelope: { event: "event", timestamp: "timestamp", data: "data" }, legacyKey: true,
        events: { "license.issued": { action: "send", template: "license-key", to: "data.email", fields } } } } as unknown as Config["sources"];
    };
    expect(() => compile(sources({ productName: "data.product", licenseKey: "data.key" }))).not.toThrow();
    fails(sources({ productName: "data.product" }), /fields\.licenseKey: required template field/);
  });
  it("adds Markdown blocks to built-in bodies with declared fields only", () => {
    const blocks = (markdown: string) => (value: Draft) => {
      (value.mailTemplates as Record<string, unknown>).templates = { notice: { body: { blocks: [{ id: "intro", kind: "markdown", markdown }] } } };
    };
    const { plans } = compile(blocks("Hello **{heading}**\n\n[[button: Open | {ctaUrl}]]"));
    const { html } = prepareEmail(brand, getTemplate("notice")!, { heading: "World", ctaUrl: "https://a.example/x" }, { plans });
    expect(html).toContain("Hello <strong>World</strong>");
    expect(html).toContain('href="https://a.example/x"');
    fails(blocks("Hello {undeclared}"), /notice/);
  });
  it("inlines template files relative to the configuration", () => {
    mkdirSync("priv", { recursive: true });
    const dir = mkdtempSync("priv/custom-file-");
    try {
      const value = draft(item => { customOf(item)["license-key"].markdown = { file: "templates/license.md" }; });
      mkdirSync(join(dir, "templates"));
      writeFileSync(join(dir, "templates/license.md"), "From **file** {productName}");
      writeFileSync(join(dir, "mailstack.json"), JSON.stringify(value));
      const { plans } = compile(item => Object.assign(item, JSON.parse(readConfigFile(join(dir, "mailstack.json")))));
      expect(prepareEmail(brand, getTemplate("license-key", plans, "acme")!, { productName: "P" }, { plans }).text).toContain("From file P");
      writeFileSync(join(dir, "escape.json"), JSON.stringify(draft(item => { customOf(item)["license-key"].markdown = { file: "../outside.md" }; })));
      expect(() => readConfigFile(join(dir, "escape.json"))).toThrow(/custom\.license-key\.markdown/);
      writeFileSync(join(dir, "..dots.md"), "Dotted");
      writeFileSync(join(dir, "dots.json"), JSON.stringify(draft(item => { customOf(item)["license-key"].markdown = { file: "..dots.md" }; })));
      expect(readConfigFile(join(dir, "dots.json"))).toContain("Dotted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("custom template delivery", () => {
  const env = { API_KEY: "trusted" } as Env;
  const deps = (plans = compile().plans) => {
    const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
    return { store: memoryStore(), sendEmail, verifyTurnstile: vi.fn(), verifyAltcha: vi.fn(), now: () => new Date("2026-06-10T12:00:00Z"), templates: plans } as SendDeps & { sendEmail: typeof sendEmail };
  };
  const send = (body: Record<string, unknown>, d = deps()) => handleSend(new Request("https://mail.example.com/v1/send", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer trusted" }, body: JSON.stringify(body) }), env, d);

  it("sends order items from a trusted request", async () => {
    const d = deps();
    const res = await send({ brand: "acme", template: "order-received", to: "anna@example.com", ...order, items }, d);
    expect(res.status).toBe(200);
    const mail = d.sendEmail.mock.calls[0][1];
    expect(mail.subject).toBe("We received your order DR-1042");
    expect(mail.html).toContain("1 × Dragon pendant");
    expect(mail.text).toContain("2 x Poster");
  });
  it.each([
    ["too many rows", Array.from({ length: 51 }, () => ({ name: "x" }))],
    ["a nested cell", [{ name: { nested: true } }]],
    ["a long cell", [{ name: "x".repeat(501) }]],
    ["an unknown key", [{ price: "1" }]],
  ])("rejects rows with %s", async (_name, rows) => {
    const res = await send({ brand: "acme", template: "order-received", ...order, items: rows });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_rows" });
  });
  it("does not offer a brand template to another brand", async () => {
    const plans = compile(value => {
      (value.brands.demo as Record<string, unknown>).mailTemplates = { custom: { "demo-only": { subject: "S", heading: "H", markdown: "x" } } };
    }).plans;
    expect((await send({ brand: "acme", template: "demo-only" }, deps(plans))).status).toBe(400);
    expect((await send({ brand: "demo", template: "demo-only" }, deps(plans))).status).toBe(200);
  });
  it("maps source rows and validates required template fields", async () => {
    const saved = config.sources;
    const plans = compile().plans;
    config.sources = { shop: { signature: { scheme: "bearer-only" }, envelope: { event: "event", timestamp: "timestamp", data: "data" }, legacyKey: true,
      events: { "order.paid": { action: "send", template: "order-received", to: "data.email",
        fields: { order: "data.id", total: "data.total", items: { path: "data.lines", as: "rows" } } } } } } as unknown as Config["sources"];
    try {
      const hook = (data: Record<string, unknown>, d = deps(plans)) => handleSourceHook(new Request("https://mail.example.com/v1/hooks/shop?brand=acme", {
        method: "POST", headers: { authorization: "Bearer trusted" }, body: JSON.stringify({ event: "order.paid", timestamp: "2026-06-10T12:00:00Z", data }) }), env, d, "shop");
      const d = deps(plans);
      expect((await hook({ email: "anna@example.com", id: "DR-1", total: "€1", lines: items }, d)).status).toBe(200);
      expect(d.sendEmail.mock.calls[0][1].html).toContain("1 × Dragon pendant");
      const missing = await hook({ email: "anna@example.com", id: "DR-1", total: "€1", lines: [] });
      expect(missing.status).toBe(422);
      expect(await missing.json()).toMatchObject({ fields: ["items"] });
    } finally { config.sources = saved; }
  });
});

describe("values with a lone surrogate", () => {
  it("send and archive without an error", async () => {
    const { plans } = compile();
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    for (const level of ["masked", "full"] as const) expect(() => prepareSend(d, brand, getTemplate("license-key", plans, "acme")!,
      { productName: "P", licenseKey: "K\ud800EY", name: "a\udc00" }, { to: ["anna@example.com"] }, policy(level))).not.toThrow();
  });
});

describe("custom template archives", () => {
  const archive = (template: string, data: Record<string, string>, level: Policy["level"], subject?: string, mutate?: (value: Draft) => void) => {
    const { plans } = compile(mutate);
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const prepared = prepareSend(d, brand, getTemplate(template, plans, "acme")!, data, { to: ["anna@example.com"], subject }, policy(level)).prepared!.archive!;
    return JSON.stringify(prepared);
  };
  it("masks every row cell at the masked level", () => {
    const result = archive("order-received", order, "masked", "Your Dragon pendant is paid");
    expect(result).not.toContain("Dragon pendant");
    expect(result).not.toContain("Poster");
    expect(result).not.toContain("DR-1042");
  });
  it("masks the percent-encoded form of fields used in URLs", () => {
    const mutate = (value: Draft) => { customOf(value).search = { subject: "S", heading: "H", markdown: "[Open](https://a.example/?q={q})" }; };
    const result = archive("search", { q: "Anna Kowalska" }, "masked", "See https://a.example/?q=Anna%20Kowalska", mutate);
    expect(result).not.toContain("Anna%20Kowalska");
    expect(result).not.toContain("Anna Kowalska");
  });
  it("keeps secret row cells out of the full archive", () => {
    const mutate = (value: Draft) => { customOf(value)["order-received"].secretFields = ["items"]; };
    const result = archive("order-received", order, "full", undefined, mutate);
    expect(result).not.toContain("Dragon pendant");
    expect(result).toContain("DR-1042");
  });
});

describe("brand theme options", () => {
  it("applies background, serif heading, button radius and label colour", () => {
    const themed = { ...brand, theme: { ...brand.theme, background: "#fbf8f1", headingFont: "serif" as const, buttonRadius: 999, labelColor: "#8a6d1f" } };
    const { plans } = compile();
    const { html } = prepareEmail(themed, getTemplate("order-received", plans, "acme")!, order, { plans });
    expect(html).toContain("background:#fbf8f1");
    expect(html).toContain("font-family:Georgia");
    expect(html).toContain("border-radius:999px");
    expect(html).toMatch(/color:#8a6d1f;">Your order/);
    expect(parseConfig(draft(value => Object.assign(value.brands.acme.theme, { headingFont: "serif", buttonRadius: 999 }))).brands.acme.theme.buttonRadius).toBe(999);
  });
});
