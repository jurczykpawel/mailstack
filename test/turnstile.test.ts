import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/turnstile";
import { handleSend } from "../src/send";
import { getBrand } from "../src/core/config";
import type { Brand, Env, SendDeps } from "../src/types";

const brand = { ...getBrand("acme")!, turnstileAction: "contact" };
const env: Env = {
  SES_REGION: "eu-west-1", SES_ACCESS_KEY_ID: "test", SES_SECRET_ACCESS_KEY: "test",
  TURNSTILE_SECRET: "test", API_KEY: "test", ALTCHA_HMAC_KEY: "test",
};
afterEach(() => vi.unstubAllGlobals());

function siteverify(value: unknown) {
  const fetchMock = vi.fn(async () => Response.json(value));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function verify(candidate: Brand = brand) {
  return verifyTurnstile("test", "token", null, candidate);
}
async function submit() {
  const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
  const deps: SendDeps = {
    verifyTurnstile, verifyAltcha: vi.fn(async () => false), sendEmail,
    now: () => new Date(),
  };
  const response = await handleSend(new Request("https://mail.example.com/v1/send", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://acme.example" },
    body: JSON.stringify({ brand: "acme", "cf-turnstile-response": "token", autoreply: false }),
  }), env, deps);
  return { response, sendEmail };
}

describe("Turnstile verification", () => {
  it.each(["acme.example", "www.acme.example", "localhost"])("accepts configured hostname %s", async (hostname) => {
    siteverify({ success: true, hostname, action: "contact" });
    expect(await verify()).toBe(true);
  });
  it.each(["other.example", "acme.example.other.example", "sub.acme.example", "localhost:4321", undefined])(
    "rejects unlisted or missing hostname %s", async (hostname) => {
      siteverify({ success: true, hostname, action: "contact" });
      expect(await verify()).toBe(false);
    },
  );
  it.each(["other", "Contact", undefined])("rejects a different or missing action %s", async (action) => {
    siteverify({ success: true, hostname: "acme.example", action });
    expect(await verify()).toBe(false);
  });
  it.each([undefined, "other"])("allows action %s when no action is configured", async (action) => {
    siteverify({ success: true, hostname: "acme.example", action });
    const { turnstileAction: _action, ...candidate } = brand;
    expect(await verify(candidate)).toBe(true);
  });
  it("requires the configured empty action to match", async () => {
    siteverify({ success: true, hostname: "acme.example", action: "contact" });
    expect(await verify({ ...brand, turnstileAction: "" })).toBe(false);
  });
  it.each([false, "true", undefined])("requires boolean success %s", async (success) => {
    siteverify({ success, hostname: "acme.example", action: "contact" });
    expect(await verify()).toBe(false);
  });
  it("returns false on network and parsing errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    expect(await verify()).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid JSON")));
    expect(await verify()).toBe(false);
  });
  it.each([
    { success: true, hostname: "other.example", action: "contact" },
    { success: true, action: "contact" },
    { success: true, hostname: "acme.example", action: "other" },
  ])("returns the existing 403 response for %j", async (value) => {
    siteverify(value);
    const { response, sendEmail } = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, message: "verification failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("sends after a matching response", async () => {
    siteverify({ success: true, hostname: "acme.example", action: "contact" });
    const { response, sendEmail } = await submit();
    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
  it("returns 403 after five seconds when siteverify does not respond", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        submit(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("siteverify exceeded five-second deadline")), 5500);
        }),
      ]);
      expect(signal?.aborted).toBe(true);
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ success: false, message: "verification failed" });
      expect(result.sendEmail).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); }
  }, 6500);
});
