import { describe, it, expect, vi } from "vitest";
import worker, { createApp } from "../src/index";
import { version } from "../package.json";
import type { Env } from "../src/types";

const env: Env = {
  SES_REGION: "eu-west-1",
  SES_ACCESS_KEY_ID: "AKIA_TEST",
  SES_SECRET_ACCESS_KEY: "secret_test",
  TURNSTILE_SECRET: "ts_secret",
  API_KEY: "trusted-secret-token",
  ALTCHA_HMAC_KEY: "test_altcha_hmac_key_placeholder",
};

const ctx = {} as ExecutionContext;

function call(input: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(input, init), env, ctx);
}

describe("router", () => {
  it("GET /health returns service ok", async () => {
    const res = await call("https://mail.example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "mailstack", version, commit: "dev", store: "down" });
  });

  it("GET /health returns the build commit", async () => {
    const res = await worker.fetch(new Request("https://mail.example.com/health"),
      { ...env, BUILD_COMMIT: "abc123" }, ctx);
    expect(await res.json()).toEqual({ ok: true, service: "mailstack", version, commit: "abc123", store: "down" });
  });

  it("unknown route returns 404 JSON", async () => {
    const res = await call("https://mail.example.com/nope");
    expect(res.status).toBe(404);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(false);
  });

  it("OPTIONS preflight from an allowed origin returns 204 + CORS", async () => {
    const res = await call("https://mail.example.com/v1/send", {
      method: "OPTIONS",
      headers: { origin: "https://acme.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://acme.example",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "content-type, authorization",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("OPTIONS preflight resolves brand from ?brand= query", async () => {
    const res = await call("https://mail.example.com/v1/send?brand=demo", {
      method: "OPTIONS",
      headers: { origin: "https://demo.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://demo.example",
    );
  });

  it("OPTIONS preflight from a disallowed origin returns 403, no CORS", async () => {
    const res = await call("https://mail.example.com/v1/send", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("Mailstack Pro Worker keys", () => {
  const scoped = { id: "acme-app", scopes: ["send"], brands: ["acme"], templates: ["notice"], recipientOverride: false, attachments: false } as const;
  const send = (app: ReturnType<typeof createApp>, token: string, template: string, waitUntil = vi.fn()) => app.fetch(new Request("https://mail.example.com/v1/send", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ brand: "acme", template, heading: "Hi", paragraphs: "Body" }),
  }), env, { waitUntil } as unknown as ExecutionContext);
  const sendEmail = () => vi.fn(async () => ({ ok: true, status: 200, response: "{}" }));

  it("builds the provider once per isolate and passes the background hook", async () => {
    const authenticate = vi.fn(async (token: string, _env?: object, _defer?: (task: Promise<unknown>) => void) => token === "msk_acme-app_x" ? { ...scoped, scopes: [...scoped.scopes], brands: [...scoped.brands], templates: [...scoped.templates] } : null);
    const pro = vi.fn(() => ({ authenticate, client: () => undefined }));
    const app = createApp({ sendEmail: sendEmail() }, pro), waitUntil = vi.fn();
    expect((await send(app, "msk_acme-app_x", "notice", waitUntil)).status).toBe(200);
    const denied = await send(app, "msk_acme-app_x", "welcome");
    expect([denied.status, (await denied.json() as { code?: string }).code]).toEqual([403, "scope"]);
    expect(pro).toHaveBeenCalledOnce();
    expect(pro).toHaveBeenCalledWith(expect.objectContaining({ brands: expect.any(Object) }), env);
    expect(authenticate.mock.calls[0][2]).toBeTypeOf("function");
    authenticate.mock.calls[0][2]!(Promise.resolve());
    expect(waitUntil).toHaveBeenCalledOnce();
  });
  it("keeps the full key working when the Pro provider fails", async () => {
    const app = createApp({ sendEmail: sendEmail() }, () => { throw new Error("license issuer unavailable"); });
    expect((await send(app, env.API_KEY!, "notice")).status).toBe(200);
  });
  it("reports the Pro commit in health only when built with Pro", async () => {
    const res = await worker.fetch(new Request("https://mail.example.com/health"), { ...env, BUILD_COMMIT: "abc", BUILD_PRO_COMMIT: "def" }, ctx);
    expect(await res.json()).toMatchObject({ commit: "abc", proCommit: "def" });
  });
});
