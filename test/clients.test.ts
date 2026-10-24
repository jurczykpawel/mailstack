import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/core/config";
import { parseConfig } from "../src/core/config/schema";
import { handleSend } from "../src/send";
import { handleSellfHook } from "../src/sellf";
import type { Env, SendDeps } from "../src/types";

const token = `msk_acme-app_${randomBytes(32).toString("base64url")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const entry = () => ({ id: "acme-app", tokenSha256: hash(token), scopes: ["send", "hook:sellf"], brands: ["acme"], templates: ["contact", "payment"], recipientOverride: false, attachments: false });
const original = structuredClone(config);
const env: Env = { API_KEY: "example-legacy-key", SES_REGION: "eu-west-1", SES_ACCESS_KEY_ID: "example", SES_SECRET_ACCESS_KEY: "example", TURNSTILE_SECRET: "example", ALTCHA_HMAC_KEY: "example" };
const deps = () => ({ sendEmail: vi.fn(async () => ({ ok: true, status: 200 })), verifyTurnstile: vi.fn(async () => true), verifyAltcha: vi.fn(async () => true), now: () => new Date("2026-10-24T12:00:00Z") } satisfies SendDeps);
function configure(overrides: Record<string, unknown> = {}) {
  Object.assign(config, parseConfig({ ...original, clients: [entry()], ...overrides }));
}
function request(path: string, body: unknown, bearer: string | null = token, origin?: string) {
  return new Request(`https://mail.example.com${path}`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
}
const purchase = { event: "purchase.completed", data: { customer: { email: "buyer@example.com" } } };
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
it("uses the configured legacy secret and permissions", async () => {
  configure({ legacyApiKey: { enabled: true, env: "CUSTOM_KEY", scopes: ["send"], brands: ["demo"], templates: ["notice"], recipientOverride: false } });
  const customEnv = { ...env, CUSTOM_KEY: "custom-example" };
  const res = await handleSend(request("/v1/send", { brand: "acme" }, "custom-example"), customEnv, deps());
  expect(await res.json()).toEqual(forbidden);
  expect((await handleSend(request("/v1/send", { brand: "demo", template: "notice" }, "custom-example"), customEnv, deps())).status).toBe(200);
  expect((await handleSellfHook(request("/v1/hooks/sellf", purchase, "custom-example"), customEnv, deps())).status).toBe(403);
  expect((await handleSellfHook(request("/v1/hooks/sellf", purchase, env.API_KEY), customEnv, deps())).status).toBe(401);
});

it("creates a token once and a usable configuration entry through the CLI", async () => {
  const result = spawnSync(process.execPath, ["scripts/mailstack.ts", "client", "create", "--id", "demo-cli", "--scopes", "send", "--brands", "demo", "--templates", "notice", "--recipient-override"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.token).toMatch(/^msk_demo-cli_[A-Za-z0-9_-]{43}$/);
  expect(result.stdout.split(output.token)).toHaveLength(2);
  expect(output.client.tokenSha256).toBe(hash(output.token)); expect(JSON.stringify(output.client)).not.toContain(output.token);
  configure({ clients: [output.client] });
  const res = await handleSend(request("/v1/send", { brand: "demo", template: "notice", to: "buyer@example.com" }, output.token), env, deps());
  expect(res.status).toBe(200);
});
it.each([["--id", "Bad", "--scopes", "send"], ["--id", "demo", "--scopes", "send,panel"], ["--id", "demo"], ["--id", "demo", "--scopes", "send", "--unknown"], ["--id", "demo", "--scopes", "send", "--brands"]])("validates CLI arguments: %j", (...args) => {
  const result = spawnSync(process.execPath, ["scripts/mailstack.ts", "client", "create", ...args], { encoding: "utf8" });
  expect(result.status).toBe(1); expect(result.stdout).toBe("");
});

it("returns the authenticated client identity and accepts uppercase hex", async () => {
  const { authenticate } = await import("../src/clients.ts");
  const req = request("/v1/send", {});
  const settings = parseConfig({ ...original, clients: [{ ...entry(), tokenSha256: hash(token).toUpperCase() }] });
  expect((await authenticate(req, env, settings))?.id).toBe("acme-app");
  expect((await authenticate(request("/v1/send", {}, env.API_KEY), env, settings))?.id).toBe("legacy");
  expect(await authenticate(req, env, { clients: [] })).toBeNull();
  expect(await authenticate(request("/v1/send", {}, env.API_KEY), { API_KEY: "" }, settings)).toBeNull();
});
it.each([
  [{ templates: ["payment"] }, {}],
  [{ recipientOverride: false }, { to: "buyer@example.com" }],
  [{ scopes: ["hook:sellf"] }, {}],
])("applies configured legacy permissions: %j", async (permissions, body) => {
  configure({ legacyApiKey: permissions });
  const d = deps();
  const res = await handleSend(request("/v1/send", { brand: "acme", ...body }, env.API_KEY), env, d);
  expect(res.status).toBe(403); expect(await res.json()).toEqual(forbidden); expect(d.sendEmail).not.toHaveBeenCalled();
});
it("creates distinct tokens with explicit selections", () => {
  const run = () => spawnSync(process.execPath, ["scripts/mailstack.ts", "client", "create", "--id", "demo-cli", "--scopes", "send,hook:sellf", "--brands", "*", "--templates", "*"], { encoding: "utf8" });
  const first = run(); const second = run();
  expect(first.status, first.stderr).toBe(0); expect(second.status, second.stderr).toBe(0);
  const output = JSON.parse(first.stdout);
  expect(output.client).toMatchObject({ scopes: ["send", "hook:sellf"], brands: "*", templates: "*", recipientOverride: false, attachments: false });
  expect(output.token).not.toBe(JSON.parse(second.stdout).token);
});

it.each([
  ["send", "--brands"], ["send", "--templates"], ["hook:sellf", "--brands"], ["hook:sellf", "--templates"],
])("requires explicit CLI selections for %s: %s", (scope, missing) => {
  const selections = missing === "--brands" ? ["--templates", "payment"] : ["--brands", "acme"];
  const result = spawnSync(process.execPath, ["scripts/mailstack.ts", "client", "create", "--id", "acme-app", "--scopes", scope, ...selections], { encoding: "utf8" });
  expect(result.status).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toContain(missing); expect(result.stderr).toContain("required");
});
it("creates a panel client without CLI selections", () => {
  const result = spawnSync(process.execPath, ["scripts/mailstack.ts", "client", "create", "--id", "panel", "--scopes", "panel"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).client).toMatchObject({ scopes: ["panel"], brands: [], templates: [] });
});
