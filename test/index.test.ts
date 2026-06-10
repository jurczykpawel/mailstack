import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const env: Env = {
  SES_REGION: "eu-west-1",
  SES_ACCESS_KEY_ID: "AKIA_TEST",
  SES_SECRET_ACCESS_KEY: "secret_test",
  TURNSTILE_SECRET: "ts_secret",
  API_KEY: "trusted-secret-token",
};

const ctx = {} as ExecutionContext;

function call(input: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(input, init), env, ctx);
}

describe("router", () => {
  it("GET /health returns service ok", async () => {
    const res = await call("https://mail.example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "mailstack" });
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
