import { describe, expect, it, vi } from "vitest";
import example from "../config/mailstack.example.json";
import custom from "../config/custom-templates.example.json";
import { parseConfig, type Config, type Policy } from "../src/core/config/schema";
import { resendPayload } from "../src/core/resend-contract";
import { templatePlans } from "../src/templates/config";
import { getTemplate } from "../src/templates/index";
import { prepareEmail } from "../src/templates/prepare";
import { compileMarkdown, renderMarkdown } from "../src/templates/markdown";
import { normalizeRows } from "../src/templates/rows";
import { requestContent, renderBody } from "../src/templates/custom";
import { WorkBudget } from "../src/templates/output";
import { configuredBody } from "../src/templates/blocks";
import { prepareSend } from "../src/send";
import type { SendDeps } from "../src/types";

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
const policy = (level: Policy["level"], extra: Partial<Policy> = {}): Policy => ({ ...parseConfig(example).logging.defaults, level, ...extra });
const table = (columns: number, rows: number) => "|a".repeat(columns) + "|\n" + "|-".repeat(columns) + "|\n" + "a\n".repeat(rows);

describe("Markdown table size", () => {
  it("rejects request content whose tables exceed the shared cell budget", () => {
    const started = performance.now();
    expect(requestContent({ markdown: table(1000, 2000) })).toEqual({ status: 422, code: "content_invalid" });
    expect(requestContent({ markdown: `${table(10, 60)}\n\n${table(10, 60)}` })).toEqual({ status: 422, code: "content_invalid" });
    expect(performance.now() - started).toBeLessThan(200);
  });
  it("does not count text that is not a table", () => {
    const rows = "a | b\n" + "---\n" + "x\n".repeat(1200);
    expect("body" in requestContent({ markdown: rows })).toBe(true);
  });
  it("accepts tables up to the budget and renders every cell", () => {
    const result = requestContent({ markdown: table(10, 99) });
    expect("body" in result).toBe(true);
    const { html } = renderBody((result as { body: Parameters<typeof renderBody>[0] }).body, brand, {});
    expect(html.match(/<td /g)).toHaveLength(1000);
  });
});

describe("rendering budget", () => {
  const big = "x".repeat(5000);
  it("stops Markdown substitution once the budget is spent", () => {
    const plan = compileMarkdown("{a}".repeat(200), false);
    expect(() => renderMarkdown(plan, brand, { a: big }, new WorkBudget(100_000))).toThrow("template_output_limit");
    expect(renderMarkdown(plan, brand, { a: "y" }, new WorkBudget(100_000)).text).toBe("y".repeat(200));
  });
  it("rejects oversized request content before materializing it", () => {
    const content = requestContent({ markdown: "{a} ".repeat(4000) });
    expect(() => renderBody((content as { body: Parameters<typeof renderBody>[0] }).body, brand, { a: big })).toThrow("template_output_limit");
    const html = requestContent({ html: "<p>{a}</p>".repeat(1600) });
    expect(() => renderBody((html as { body: Parameters<typeof renderBody>[0] }).body, brand, { a: big })).toThrow("template_output_limit");
  });
  it("shares one budget across the Markdown blocks of a built-in body", () => {
    const blocks = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, kind: "markdown" as const, markdown: "{p}".repeat(30) }));
    let reads = 0;
    const data = new Proxy({ p: "x".repeat(4000) } as Record<string, string>, { get: (target, key: string) => { if (key === "p") reads++; return target[key]; } });
    expect(() => configuredBody(brand, { body: { blocks } } as never, templatePlans(parseConfig(example)), data)).toThrow("template_output_limit");
    expect(reads).toBeLessThan(200);
  });
  it("reads each HTML field once when generating the text alternative", () => {
    const content = requestContent({ html: '<p>{a}</p><a href="{u}">x</a>' }) as { body: Parameters<typeof renderBody>[0] };
    const reads: string[] = [];
    const data = new Proxy({ a: "A", u: "https://a.example/" } as Record<string, string>, { get: (target, key: string) => { reads.push(key); return target[key]; } });
    expect(renderBody(content.body, brand, data).text).toContain("A");
    expect(reads.filter(key => key === "a")).toHaveLength(1);
  });
  it("does not render the named body that request content replaces", () => {
    const { plans } = compile();
    const template = getTemplate("order-received", plans, "acme")!;
    const render = vi.fn(template.render);
    const content = requestContent({ markdown: "Replacement" }) as { body: Parameters<typeof renderBody>[0] };
    const email = prepareEmail(brand, { ...template, render }, { order: "DR-1", items: "", total: "1" }, { plans, content: content.body });
    expect(email.text).toContain("Replacement");
    expect(email.heading).toBe("Thank you for your order!");
    expect(render).not.toHaveBeenCalled();
  });
});

describe("short secret row cells", () => {
  const mutate = (value: Draft) => {
    const order = customOf(value)["order-received"];
    order.secretFields = ["items"];
    order.markdown = [...order.markdown as string[], "", "Size: {size}", "", "Note: {note}"];
  };
  const order = { firstName: "Anna", order: "DR-1042", total: "€49.00", size: "XL", items: JSON.stringify([{ qty: "1", name: "XL", amount: "€49.00" }]) };
  it.each<[Policy["level"], Partial<Policy>]>([["full", {}], ["masked", { show: ["size", "order", "firstName"] }]])("masks a copy in another field at the %s level", (level, extra) => {
    const { plans } = compile(mutate);
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const archive = prepareSend(d, brand, getTemplate("order-received", plans, "acme")!, order, { to: ["anna@example.com"] }, policy(level, extra)).prepared!.archive!;
    if (archive.level === "meta") throw new Error("expected content");
    expect(archive.html).toContain("DR-1042");
    expect(archive.html).toContain("Size: ••••");
    expect(`${archive.html}\n${archive.text}`).not.toMatch(/(?<![\p{L}\p{N}])XL(?![\p{L}\p{N}])/u);
  });
  it.each<[Policy["level"], Partial<Policy>]>([["full", {}], ["masked", { show: ["size", "order"] }]])("masks the copy in the sent subject at the %s level", (level, extra) => {
    const { plans } = compile(value => { mutate(value); customOf(value)["order-received"].subject = "Your {size} order {order}"; });
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const data = { order: "DR-7", total: "€1", size: "XL", items: JSON.stringify([{ qty: "1", name: "XL", amount: "€1" }]) };
    const delivery = prepareSend(d, brand, getTemplate("order-received", plans, "acme")!, data, { to: ["anna@example.com"] }, policy(level, extra));
    expect(delivery.params.subject).toBe("Your XL order DR-7");
    const archive = delivery.prepared!.archive!;
    expect(archive.level !== "meta" && archive.subject).toBe("Your •••• order DR-7");
  });
  it.each<[Policy["level"], Partial<Policy>]>([["full", {}], ["masked", { show: ["order", "count"] }]])("keeps other text of the subject at the %s level", (level, extra) => {
    const { plans } = compile(mutate);
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const data = { order: "DR-1", total: "€1", count: "1", items: JSON.stringify([{ qty: "1", name: "Poster", amount: "€1" }]) };
    const archive = prepareSend(d, brand, getTemplate("order-received", plans, "acme")!, data, { to: ["anna@example.com"] }, policy(level, extra)).prepared!.archive!;
    expect(archive.level !== "meta" && archive.subject).toBe("We received your order DR-1");
  });
  it.each<[Policy["level"], Partial<Policy>]>([["full", {}], ["masked", { show: ["size", "order", "note"] }]])("leaves numbers, entities and rules intact at the %s level", (level, extra) => {
    const { plans } = compile(mutate);
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const data = { order: "DR-1", total: "€1", size: "XL", note: "Tom's step 1", items: JSON.stringify([{ qty: "1", name: "XL", amount: "-" }, { qty: "39", name: "Poster", amount: "€1" }]) };
    const archive = prepareSend(d, brand, getTemplate("order-received", plans, "acme")!, data, { to: ["anna@example.com"] }, policy(level, extra)).prepared!.archive!;
    if (archive.level === "meta") throw new Error("expected content");
    expect(archive.html).toContain("DR-1");
    expect(archive.html).toContain("Tom&#39;s step 1");
    expect(archive.html).toContain("Size: ••••<");
    expect(archive.text).toContain("-".repeat(20));
    expect(`${archive.html}\n${archive.text}`).not.toMatch(/••••[^<\s]/);
  });
});

describe("named confirmation subject", () => {
  it.each<[string, (value: Draft) => void, RegExp]>([
    ["a field in the base subject", value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" }); customOf(value).thanks = { subject: "Thanks {name}", heading: "H", markdown: "Hi" };
    }, /custom\.thanks\.subject: literal single-line subject required/],
    ["a field in a locale subject", value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" });
      (value.brands.acme as Record<string, unknown>).mailTemplates = { languages: { default: "pl", allowed: ["pl", "en"] },
        custom: { thanks: { subject: "Dziękujemy", heading: "H", markdown: "Hi", locales: { en: { subject: "About {summary}" } } } } };
    }, /custom\.thanks\.locales\.en\.subject: literal single-line subject required/],
  ])("rejects %s", (_name, mutate, message) => fails(mutate, message));
  it("keeps personalised heading and body", () => {
    expect(() => compile(value => {
      Object.assign(value.brands.acme, { autoReplyTemplate: "thanks" }); customOf(value).thanks = { subject: "Thanks", heading: "Hi {name}", markdown: "Topic: {summary}" };
    })).not.toThrow();
  });
});

describe("order row replay", () => {
  it("stores a replay that the resend contract accepts", () => {
    const { plans } = compile(value => { value.logging.brands.acme = { templates: { "order-received": { level: "masked", resend: "replay" } } }; });
    const items = Array.from({ length: 20 }, (_, i) => ({ qty: String(i + 1), name: `Item ${i} ${"n".repeat(60)}`, amount: "€10.00", description: "d".repeat(200) }));
    const d = { templates: plans, logging: parseConfig(example).logging } as SendDeps;
    const data = { order: "DR-1", total: "€200.00", items: normalizeRows(items)! };
    expect(data.items.length).toBeGreaterThan(5000);
    const prepared = prepareSend(d, brand, getTemplate("order-received", plans, "acme")!, data, { to: ["anna@example.com"] }, policy("masked", { resend: "replay" })).prepared!;
    expect(resendPayload.safeParse(prepared.replay).success).toBe(true);
    expect(resendPayload.safeParse({ ...prepared.replay, data: { ...data, note: "x".repeat(5001) } }).success).toBe(false);
  });
});

describe("order rows", () => {
  it.each([[[{ name: "Poster" }]], [[{}]], [[{ qty: "1", name: " ", amount: "€1" }]]])("rejects incomplete rows %j", rows => {
    expect(normalizeRows(rows)).toBeNull();
  });
  it("keeps the optional description", () => {
    expect(normalizeRows([{ qty: 1, name: "Poster", amount: "€1" }])).toBe('[{"qty":"1","name":"Poster","amount":"€1"}]');
  });
});

describe("locale text alternative", () => {
  const withLocale = (base: Record<string, unknown>, locale: Record<string, unknown>) => (value: Draft) => {
    (value.brands.acme as Record<string, unknown>).mailTemplates = { languages: { default: "en", allowed: ["en", "pl"] },
      custom: { update: { subject: "Update", heading: "Update", ...base, locales: { pl: { heading: "Aktualizacja", ...locale } } } } };
  };
  it("combines a locale text with the inherited HTML", () => {
    const { plans, value } = compile(withLocale({ html: "<p>Office update</p>", text: "English alternative" }, { text: "Polska wersja" }));
    const email = prepareEmail(value.brands.acme, getTemplate("update", plans, "acme")!, {}, { plans, locale: "pl" });
    expect(email.text).toContain("Polska wersja");
    expect(email.text).not.toContain("English alternative");
    expect(email.html).toContain("Office update");
  });
  it("rejects a locale text for a Markdown body", () => {
    fails(withLocale({ markdown: "Body" }, { text: "Tekst" }), /custom\.update\.locales\.pl\.text/);
  });
});

describe("components inside code blocks", () => {
  it("leaves component syntax in fenced code to Markdown", () => {
    const source = "Example:\n\n~~~text\n[[example]]\n~~~\n\n```\n[[button: x]]\n```";
    expect("body" in requestContent({ markdown: source })).toBe(true);
    const { html } = renderMarkdown(compileMarkdown(source), brand, {});
    expect(html).toContain("[[example]]");
    expect(html).toContain("[[button: x]]");
    expect(() => compileMarkdown("[[example]]")).toThrow("invalid component");
  });
  it("keeps indented code and list-nested fences as code and needs a valid fence opening", () => {
    expect(() => compileMarkdown("1. Step\n\n    ```\n    [[example]]\n    ```")).not.toThrow();
    expect(() => compileMarkdown("Intro\n\n    [[example]]")).not.toThrow();
    expect(() => compileMarkdown("``` a`b\n[[example]]")).toThrow("invalid component");
  });
});

describe("per-brand named template policies", () => {
  const replay = (value: Draft) => {
    value.logging.brands.acme = { templates: { "order-received": { level: "masked", resend: "replay" } } };
    (value.brands.demo as Record<string, unknown>).mailTemplates = { custom: { "order-received": { subject: "S", heading: "H", markdown: "{code}", secretFields: ["code"] } } };
  };
  it("checks the replay policy against the brand's own definition", () => {
    expect(() => compile(replay)).not.toThrow();
    fails(value => { replay(value); value.logging.brands.demo = { templates: { "order-received": { level: "masked", resend: "replay" } } }; }, /logging\.brands\.demo\.templates\.order-received\.resend/);
  });
  it("requires source fields of every definition the source can select", () => {
    const source = (fields: Record<string, string>) => (value: Draft) => {
      (value.brands.demo as Record<string, unknown>).mailTemplates = { custom: { "license-key": { subject: "S", heading: "H", markdown: "{serial}", requiredFields: ["serial"] } } };
      value.sources = { shop: { signature: { scheme: "bearer-only" }, envelope: { event: "event", timestamp: "timestamp", data: "data" }, legacyKey: true,
        events: { "license.issued": { action: "send", template: "license-key", to: "data.email", fields } } } } as unknown as Config["sources"];
    };
    expect(() => compile(source({ productName: "data.product", licenseKey: "data.key", serial: "data.serial" }))).not.toThrow();
    fails(source({ productName: "data.product", licenseKey: "data.key" }), /fields\.serial: required template field/);
  });
});
