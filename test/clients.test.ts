import { testKeys } from "./fixtures/keys";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/core/config";
import { parseConfig } from "../src/core/config/schema";
import { handleSend } from "../src/send";
import { handleSellfHook } from "./sellf-source-helper";
import type { Env, SendDeps } from "../src/types";

const token = `msk_acme-app_${randomBytes(32).toString("base64url")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const entry = () => ({ id: "acme-app", tokenSha256: hash(token), scopes: ["send", "hook:sellf"], brands: ["acme"], templates: ["contact", "payment"], recipientOverride: false, attachments: false });
const original = structuredClone(config);
const env: Env = { API_KEY: "example-legacy-key", SES_REGION: "eu-west-1", SES_ACCESS_KEY_ID: "example", SES_SECRET_ACCESS_KEY: "example", TURNSTILE_SECRET: "example", ALTCHA_HMAC_KEY: "example" };
const deps = () => ({ keys: testKeys(config), sendEmail: vi.fn(async () => ({ ok: true, status: 200 })), verifyTurnstile: vi.fn(async () => true), verifyAltcha: vi.fn(async () => true), now: () => new Date("2026-10-24T12:00:00Z") } satisfies SendDeps);
function configure(overrides: Record<string, unknown> = {}) {
  Object.assign(config, parseConfig({ ...original, clients: [entry()], ...overrides }));
}
function request(path: string, body: unknown, bearer: string | null = token, origin?: string) {
  return new Request(`https://mail.example.com${path}`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
}
const purchase = { event: "purchase.completed", timestamp: "2026-10-24T12:00:00Z", data: { customer: { email: "buyer@example.com" }, product: { name: "Plan" }, order: { sessionId: "cs-example", amount: 100, currency: "PLN" } } };
const forbidden = { success: false, message: "forbidden", code: "scope" };
beforeEach(() => configure());
afterEach(() => {
  for (const key of Object.keys(config)) if (!Object.hasOwn(original, key)) Reflect.deleteProperty(config, key);
  Object.assign(config, structuredClone(original));
});

describe("client permissions", () => {
  it.each([
    ["brand", { brands: ["demo"] }, {}],
    ["template", { templates: ["payment"] }, {}],
    ["recipient", {}, { to: "buyer@example.com" }],
    ["send scope", { scopes: ["hook:sellf"] }, {}],
    ["panel scope", { scopes: ["panel"] }, {}],
  ])("checks %s on send", async (_name, permissions, body) => {
    configure({ clients: [{ ...entry(), ...permissions }] });
    const d = deps();
    const res = await handleSend(request("/v1/send", { brand: "acme", ...body }, token, "https://acme.example"), env, d);
    expect(res.status).toBe(403); expect(await res.json()).toEqual(forbidden);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://acme.example");
    expect(d.sendEmail).not.toHaveBeenCalled(); expect(d.verifyTurnstile).not.toHaveBeenCalled();
  });
  it("allows fixed recipients and selected templates", async () => {
    const d = deps();
    const res = await handleSend(request("/v1/send", { brand: "acme", template: "payment" }), env, d);
    expect(res.status).toBe(200); expect(d.sendEmail.mock.calls).toHaveLength(1);
    expect(d.verifyTurnstile).not.toHaveBeenCalled();
  });
  it("allows wildcard brands, templates and recipient overrides", async () => {
    configure({ clients: [{ ...entry(), brands: "*", templates: "*", recipientOverride: true }] });
    const d = deps();
    const res = await handleSend(request("/v1/send", { brand: "demo", template: "notice", to: "buyer@example.com" }), env, d);
    expect(res.status).toBe(200); expect(d.sendEmail).toHaveBeenCalledWith(env, expect.objectContaining({ to: ["buyer@example.com"] }));
  });
  it.each([
    ["hook scope", { scopes: ["send"] }],
    ["brand", { brands: ["demo"] }],
    ["mapped template", { templates: ["notice"] }],
  ])("checks %s on Sellf", async (_name, permissions) => {
    configure({ clients: [{ ...entry(), ...permissions }] });
    const d = deps(); const res = await handleSellfHook(request("/v1/hooks/sellf?brand=acme", purchase), env, d);
    expect(res.status).toBe(403); expect(await res.json()).toEqual(forbidden); expect(d.sendEmail).not.toHaveBeenCalled();
  });
  it("allows a hook client to use the mapped customer recipient", async () => {
    configure({ clients: [{ id: "acme-app", tokenSha256: hash(token), scopes: ["hook:sellf"], brands: ["acme"], templates: ["payment"] }] });
    const d = deps(); const res = await handleSellfHook(request("/v1/hooks/sellf", purchase), env, d);
    expect(res.status).toBe(200); expect(d.sendEmail).toHaveBeenCalledWith(env, expect.objectContaining({ to: ["buyer@example.com"] }));
  });
});

it.each([null, "wrong", token.slice(0, -1), token.replace("acme-app", "unknown"), `msk_acme-app_${randomBytes(32).toString("base64url")}`])("handles unsuccessful authentication uniformly: %s", async (bearer) => {
  const d = deps();
  const res = await handleSend(request("/v1/send", { brand: "acme" }, bearer), env, d);
  expect(res.status).toBe(403); expect(await res.json()).toEqual({ success: false, message: "origin not allowed" });
  const hook = await handleSellfHook(request("/v1/hooks/sellf", purchase, bearer), env, d);
  expect(hook.status).toBe(401); expect(await hook.json()).toEqual({ success: false, message: "unauthorized" });
  const publicRes = await handleSend(request("/v1/send", { brand: "acme", template: "payment", to: "buyer@example.com" }, bearer, "https://acme.example"), env, d);
  expect(publicRes.status).toBe(200); expect(d.verifyTurnstile).toHaveBeenCalled();
  expect(d.sendEmail).toHaveBeenCalledWith(env, expect.objectContaining({ to: config.brands.acme.to }));
});
it("requires the full token to match its configured client", async () => {
  configure({ clients: [entry(), { ...entry(), id: "other" }] });
  const res = await handleSellfHook(request("/v1/hooks/sellf", purchase, token.replace("acme-app", "other")), env, deps());
  expect(res.status).toBe(401);
});
it.each([undefined, { enabled: true }])("retains legacy defaults: %j", async (legacyApiKey) => {
  configure({ legacyApiKey });
  expect((await handleSend(request("/v1/send", { brand: "demo", template: "notice", to: "buyer@example.com" }, env.API_KEY), env, deps())).status).toBe(200);
  expect((await handleSellfHook(request("/v1/hooks/sellf", purchase, env.API_KEY), env, deps())).status).toBe(200);
});
it("disables legacy without disabling scoped clients", async () => {
  configure({ legacyApiKey: { enabled: false } });
  expect((await handleSend(request("/v1/send", { brand: "acme" }, env.API_KEY), env, deps())).status).toBe(403);
  expect((await handleSellfHook(request("/v1/hooks/sellf", purchase, env.API_KEY), env, deps())).status).toBe(401);
  expect((await handleSend(request("/v1/send", { brand: "acme" }), env, deps())).status).toBe(200);
});




describe("free core without a key provider", () => {
  const free = () => ({ ...deps(), keys: undefined });
  it("accepts only the full key and rejects scoped tokens as unauthenticated", async () => {
    expect((await handleSend(request("/v1/send", { brand: "demo", template: "notice", to: "buyer@example.com" }, env.API_KEY), env, free())).status).toBe(200);
    expect((await handleSellfHook(request("/v1/hooks/sellf", purchase, env.API_KEY), env, free())).status).toBe(200);
    const hook = await handleSellfHook(request("/v1/hooks/sellf", purchase), env, free());
    expect(hook.status).toBe(401); expect(await hook.json()).toEqual({ success: false, message: "unauthorized" });
    const d = free();
    expect((await handleSend(request("/v1/send", { brand: "acme", template: "payment" }), env, d)).status).toBe(403);
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
  it("refuses clients at startup without an extension that provides keys", async () => {
    const { loadExtensions } = await import("../src/runtime/extensions");
    const { createSqliteStore } = await import("../src/core/store/sqlite");
    const store = createSqliteStore(":memory:"); await store.migrate();
    try {
      await expect(loadExtensions(config, store)).rejects.toThrow("$.clients: additional or restricted API keys require Mailstack Pro");
      const other = { ...config, extensions: [{ module: "other" }] };
      await expect(loadExtensions(other, store, async () => ({ default: { name: "other" } }))).rejects.toThrow("$.clients:");
      const { clients: _, ...plain } = config;
      await expect(loadExtensions(plain as typeof config, store)).resolves.toMatchObject({ keys: undefined });
    } finally { await store.db.destroy(); }
  });
  it.each([
    ["brands", ["acme"]], ["templates", ["payment"]], ["recipientOverride", false],
  ])("refuses a restricted full key: %s", (field, value) => {
    expect(() => parseConfig({ ...original, legacyApiKey: { [field]: value } })).toThrow(`$.legacyApiKey.${field}: additional or restricted API keys require Mailstack Pro`);
  });
  it("accepts restated full permissions and free options", () => {
    const legacyApiKey = { enabled: true, env: "API_KEY", attachments: true, brands: "*", templates: "*", recipientOverride: true };
    expect(parseConfig({ ...original, legacyApiKey }).legacyApiKey).toMatchObject({ attachments: true, env: "API_KEY" });
  });
  it("verifies Sellf signatures on the full key", async () => {
    const { createHmac } = await import("node:crypto");
    configure({ legacyApiKey: { signatureSecretEnv: "SELLF_SECRET" } });
    const signed = { ...env, SELLF_SECRET: "example-signing-secret" };
    const raw = JSON.stringify(purchase), t = String(Math.floor(deps().now().getTime() / 1000));
    const signature = `t=${t},v1=${createHmac("sha256", signed.SELLF_SECRET).update(`${t}.${raw}`).digest("hex")}`;
    const call = (headers: Record<string, string>) => handleSellfHook(new Request("https://mail.example.com/v1/hooks/sellf", { method: "POST", body: raw, headers: { authorization: `Bearer ${env.API_KEY}`, ...headers } }), signed, free());
    expect((await call({})).status).toBe(401);
    expect((await call({ "x-sellf-signature": signature })).status).toBe(200);
    expect(() => configure({ legacyApiKey: { signatureSecretEnv: "SELLF_SECRET" }, sources: { sellf: { ...original.sources?.sellf, signature: { scheme: "bearer-only" } } } }))
      .toThrow("$.legacyApiKey.signatureSecretEnv: requires a signing scheme");
  });
});
