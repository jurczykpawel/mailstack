import { afterEach, describe, expect, it, vi } from "vitest";
import example from "../config/mailstack.example.json";
import { config } from "../src/core/config";
import { parseConfig, type Config, type Policy } from "../src/core/config/schema";
import { intentRequest } from "../src/core/logging/writer";
import { handleSend, prepareSend } from "../src/send";
import { getTemplate } from "../src/templates/index";
import { requestContent } from "../src/templates/custom";
import { memoryStore } from "./store-fixture";
import type { Env, SendDeps, SendParams } from "../src/types";

const env = { API_KEY: "trusted", TURNSTILE_SECRET: "t" } as Env;
const brand = example.brands.acme as unknown as Config["brands"][string];
const saved = structuredClone(config.legacyApiKey);
afterEach(() => { config.legacyApiKey = structuredClone(saved); });
const allow = (rawContent: boolean) => { config.legacyApiKey = { enabled: true, env: "API_KEY", brands: "*", templates: "*", recipientOverride: true, attachments: false, rawContent }; };
const deps = () => {
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
  return { store: memoryStore(), sendEmail, verifyTurnstile: vi.fn(async () => true), verifyAltcha: vi.fn(), now: () => new Date("2026-06-10T12:00:00Z") } as SendDeps & { sendEmail: typeof sendEmail };
};
const send = (body: Record<string, unknown>, d = deps(), headers: Record<string, string> = { authorization: "Bearer trusted" }) =>
  handleSend(new Request("https://mail.example.com/v1/send", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, d);
const notice = { brand: "acme", template: "notice", to: "anna@example.com", heading: "Order update", name: "Anna <b>" };

describe("request content", () => {
  it("replaces the template body with Markdown while keeping heading and layout", async () => {
    allow(true);
    const d = deps();
    const res = await send({ ...notice, content: { markdown: "Hi **{name}**\n\n[[button: Open | https://a.example/o]]" } }, d);
    expect(res.status).toBe(200);
    const mail = d.sendEmail.mock.calls[0][1];
    expect(mail.html).toContain("Hi <strong>Anna &lt;b&gt;</strong>");
    expect(mail.html).toContain("Order update");
    expect(mail.html).toContain(brand.name);
    expect(mail.text).toContain("Open: https://a.example/o");
  });
  it("accepts HTML with an optional text alternative", async () => {
    allow(true);
    const d = deps();
    expect((await send({ ...notice, content: { html: '<p>Hello <a href="https://a.example/x">there</a></p>', text: "Plain hello" } }, d)).status).toBe(200);
    expect(d.sendEmail.mock.calls[0][1].html).toContain('<p>Hello <a href="https://a.example/x">there</a></p>');
    expect(d.sendEmail.mock.calls[0][1].text).toContain("Plain hello");
  });
  it("requires the client permission", async () => {
    allow(false);
    const res = await send({ ...notice, content: { markdown: "x" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "scope" });
  });
  it("ignores content in public requests", async () => {
    const d = deps();
    const res = await send({ brand: "acme", name: "Jane", email: "jane@example.com", message: "Hello", "cf-turnstile-response": "t", autoreply: "0", content: { html: "<p>Injected</p>" } },
      d, { origin: "https://acme.example" });
    expect(res.status).toBe(200);
    expect(d.sendEmail.mock.calls[0][1].html).not.toContain("Injected");
  });
  it.each<[string, unknown, number, string]>([
    ["content above 16 KiB", { markdown: "x".repeat(16 * 1024 + 1) }, 413, "content_too_large"],
    ["HTML above 16 KiB", { html: `<p>${"x".repeat(16 * 1024)}</p>` }, 413, "content_too_large"],
    ["a javascript link", { html: '<a href="javascript:alert(1)">x</a>' }, 422, "content_invalid"],
    ["a script element", { html: "<p>x</p><script>alert(1)</script>" }, 422, "content_invalid"],
    ["both bodies", { markdown: "x", html: "<p>x</p>" }, 422, "content_invalid"],
    ["a layout option", { html: "<p>x</p>", layout: "none" }, 422, "content_invalid"],
    ["text with Markdown", { markdown: "x", text: "y" }, 422, "content_invalid"],
  ])("rejects %s", async (_name, content, status, code) => {
    allow(true);
    const d = deps();
    const res = await send({ ...notice, content }, d);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
});

describe("request content records", () => {
  const policy = (level: Policy["level"]): Policy => ({ ...parseConfig(example).logging.defaults, level, resend: "replay" });
  const prepare = (level: Policy["level"], content: unknown, data: Record<string, string> = { heading: "Order update", name: "Anna Kowalska" }) => {
    const parsed = requestContent(content);
    if ("code" in parsed) throw new Error(parsed.code);
    return prepareSend({ logging: parseConfig(example).logging } as SendDeps, brand, getTemplate("notice")!, data, { to: ["anna@example.com"], content: parsed }, policy(level)).prepared!;
  };
  it("stores a placeholder at the masked level and never offers replay", () => {
    const record = prepare("masked", { html: "<p>Private letter for {name}</p>" });
    expect(JSON.stringify(record.archive)).not.toContain("Private letter");
    expect(JSON.stringify(record.archive)).toContain("[treść z żądania ukryta]");
    expect(record.replay).toBeUndefined();
  });
  it("stores the content at the full level", () => {
    expect(JSON.stringify(prepare("full", { markdown: "Private letter" }).archive)).toContain("Private letter");
  });
  it("makes the content part of the request identity", () => {
    const base = { clientId: "legacy", brand, template: getTemplate("notice")!, data: {}, recipients: [{ role: "to" as const, address: "anna@example.com" }] };
    expect(JSON.stringify(intentRequest({ ...base, content: { markdown: "a" } }))).not.toBe(JSON.stringify(intentRequest({ ...base, content: { markdown: "b" } })));
    expect(intentRequest(base)).not.toHaveProperty("content");
  });
});

describe("request content limits and compatibility", () => {
  it("keeps a string content value as an ordinary field", async () => {
    allow(false);
    const d = deps();
    const res = await send({ brand: "acme", template: "notice", heading: "H", paragraphs: "{content}", content: "Plain field" }, d);
    expect(res.status).toBe(200);
  });
  it.each(["_a", "*a", "**a", "[a", "`a", "~~a"])("refuses dense %s delimiter runs before parsing", async unit => {
    allow(true);
    const start = performance.now();
    const res = await send({ ...notice, content: { markdown: unit.repeat(Math.floor(16000 / unit.length)) } });
    expect(res.status).toBe(422);
    expect(performance.now() - start).toBeLessThan(100);
  });
  it("still accepts ordinary long Markdown", async () => {
    allow(true);
    const paragraph = "A **bold** word, an *emphasis* and a [link](https://a.example/x) in a normal sentence.\n\n";
    expect((await send({ ...notice, content: { markdown: paragraph.repeat(Math.floor(15000 / paragraph.length)) } })).status).toBe(200);
  });
  it("refuses deeply nested HTML", async () => {
    allow(true);
    expect((await send({ ...notice, content: { html: "<div>".repeat(100) + "x" } })).status).toBe(422);
  });
});

describe("request content work bounds", () => {
  it.each([
    [">".repeat(16000) + " a"], ["> ".repeat(8000) + "a"], [Array.from({ length: 20 }, () => "*a".repeat(120)).join("\n\n")],
  ])("refuses costly Markdown shapes quickly %#", async markdown => {
    allow(true);
    // The fastest of three runs filters scheduler pauses on a loaded machine; a costly shape is slow every time.
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      expect((await send({ ...notice, content: { markdown } })).status).toBe(422);
      times.push(performance.now() - start);
    }
    expect(Math.min(...times)).toBeLessThan(60);
  });
  it("accepts ordinary paragraphs with CRLF line endings", async () => {
    allow(true);
    const text = Array.from({ length: 20 }, () => "A **bold** word, *emphasis* and a [link](https://a.example/x).").join("\r\n\r\n");
    expect((await send({ ...notice, content: { markdown: text } })).status).toBe(200);
  });
  it("renders long runs of spaces in linear time", async () => {
    const d = deps();
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, "a" + " ".repeat(4990) + "b"]));
    const start = performance.now();
    const res = await send({ brand: "acme", email: "jane@example.com", "cf-turnstile-response": "t", autoreply: "0", ...fields }, d, { origin: "https://acme.example" });
    expect(res.status).toBe(200);
    expect(performance.now() - start).toBeLessThan(60);
  });
});
