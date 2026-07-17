import { describe, it, expect, vi } from "vitest";
import { handleSend } from "../src/send";
import type { Env, SendDeps, SendParams } from "../src/types";

const API_KEY = "trusted-secret-token";
const ACME_ORIGIN = "https://acme.example";
const LD_TAG = '<script type="application/ld+json">';

function makeEnv(): Env {
  return {
    SES_REGION: "eu-west-1",
    SES_ACCESS_KEY_ID: "AKIA_TEST",
    SES_SECRET_ACCESS_KEY: "secret_test",
    TURNSTILE_SECRET: "ts_secret",
    API_KEY,
    ALTCHA_HMAC_KEY: "test_altcha_hmac_key_placeholder",
  };
}

function makeDeps() {
  const sendEmail = vi.fn(
    async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }),
  );
  const deps: SendDeps = {
    sendEmail,
    verifyTurnstile: vi.fn(async () => true),
    verifyAltcha: vi.fn(async () => true),
    now: () => new Date("2026-07-17T12:00:00.000Z"),
  };
  return { deps, sendEmail };
}

function req(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://mail.example.com/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const bearer = { authorization: `Bearer ${API_KEY}` };

function sentHtml(sendEmail: ReturnType<typeof vi.fn>): string {
  return (sendEmail.mock.calls[0][1] as SendParams).html;
}

describe("markup in /v1/send", () => {
  it("trusted request injects explicit markup into <head>", async () => {
    const { deps, sendEmail } = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          to: "buyer@example.com",
          amount: "149.00",
          markup: [
            { kind: "viewAction", name: "Zobacz zamówienie", url: "https://acme.example/o/1" },
          ],
        },
        bearer,
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    const html = sentHtml(sendEmail);
    expect(html).toContain(LD_TAG);
    expect(html).toContain('"@type":"ViewAction"');
    expect(html).toContain("https://acme.example/o/1");
  });

  it("public request ignores markup entirely (anti-injection)", async () => {
    const { deps, sendEmail } = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          email: "jane@example.com",
          message: "hi",
          "cf-turnstile-response": "tok",
          markup: [
            { kind: "viewAction", name: "evil", url: "https://evil.example" },
          ],
        },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    const html = sentHtml(sendEmail);
    expect(html).not.toContain(LD_TAG);
    expect(html).not.toContain("evil.example");
  });

  it("template auto-markup appears when no markup key is given", async () => {
    const { deps, sendEmail } = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          to: "buyer@example.com",
          orderId: "ORD-1",
          orderUrl: "https://acme.example/order/ORD-1",
        },
        bearer,
      ),
      makeEnv(),
      deps,
    );
    const html = sentHtml(sendEmail);
    expect(html).toContain(LD_TAG);
    expect(html).toContain("https://acme.example/order/ORD-1");
    expect(html).toContain('"@type":"ViewAction"');
  });

  it("an empty markup array suppresses template auto-markup", async () => {
    const { deps, sendEmail } = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          to: "buyer@example.com",
          orderUrl: "https://acme.example/order/ORD-1",
          markup: [],
        },
        bearer,
      ),
      makeEnv(),
      deps,
    );
    const html = sentHtml(sendEmail);
    expect(html).not.toContain(LD_TAG);
  });

  it("explicit markup wins over template auto-markup", async () => {
    const { deps, sendEmail } = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          to: "buyer@example.com",
          orderUrl: "https://acme.example/order/ORD-1",
          markup: [
            { kind: "discountOffer", discountCode: "WELCOME10" },
          ],
        },
        bearer,
      ),
      makeEnv(),
      deps,
    );
    const html = sentHtml(sendEmail);
    expect(html).toContain('"@type":"DiscountOffer"');
    expect(html).toContain("WELCOME10");
    // The template's own ViewAction is suppressed by explicit markup.
    expect(html).not.toContain("order/ORD-1");
  });
});
