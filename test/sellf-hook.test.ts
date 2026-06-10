import { describe, it, expect, vi } from "vitest";
import { handleSellfHook } from "../src/sellf";
import type { Env, SendDeps, SendParams } from "../src/types";

const API_KEY = "trusted-secret-token";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SES_REGION: "eu-west-1",
    SES_ACCESS_KEY_ID: "AKIA_TEST",
    SES_SECRET_ACCESS_KEY: "secret_test",
    TURNSTILE_SECRET: "ts_secret",
    API_KEY,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SendDeps> = {}): SendDeps & {
  sendEmail: ReturnType<typeof vi.fn>;
} {
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({
    ok: true,
    status: 200,
  }));
  return {
    sendEmail,
    verifyTurnstile: vi.fn(async () => true),
    now: () => new Date("2026-06-10T12:00:00.000Z"),
    ...overrides,
  } as SendDeps & { sendEmail: ReturnType<typeof vi.fn> };
}

function hook(
  body: unknown,
  { brand, auth = true }: { brand?: string; auth?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${API_KEY}`;
  const qs = brand ? `?brand=${brand}` : "";
  return new Request(`https://mail.example.com/v1/hooks/sellf${qs}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Fresh customer object per call (tests mutate envelopes, so never share refs). */
function makeCustomer() {
  return { email: "buyer@example.com", firstName: "Anna", lastName: "Nowak" };
}

function purchaseEnvelope() {
  return {
    event: "purchase.completed",
    timestamp: "2026-06-10T09:30:00.000Z",
    data: {
      customer: makeCustomer(),
      product: { name: "Protocol: X" },
      order: {
        amount: 4999,
        currency: "pln",
        sessionId: "cs_test_123",
        paymentIntentId: "pi_test_999",
      },
    },
  };
}

describe("handleSellfHook — auth", () => {
  it("rejects a missing bearer with 401 and does not send", async () => {
    const deps = makeDeps();
    const res = await handleSellfHook(
      hook(purchaseEnvelope(), { auth: false }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, message: "unauthorized" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer with 401", async () => {
    const deps = makeDeps();
    const req = new Request("https://mail.example.com/v1/hooks/sellf", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify(purchaseEnvelope()),
    });
    const res = await handleSellfHook(req, makeEnv(), deps);
    expect(res.status).toBe(401);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("ignores X-Sellf-* headers (bearer-only, no HMAC)", async () => {
    const deps = makeDeps();
    const req = new Request("https://mail.example.com/v1/hooks/sellf", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        "x-sellf-signature": "totally-bogus",
      },
      body: JSON.stringify(purchaseEnvelope()),
    });
    const res = await handleSellfHook(req, makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("handleSellfHook — purchase.completed", () => {
  it("sends one payment email with mapped fields (default brand: acme)", async () => {
    const deps = makeDeps();
    const res = await handleSellfHook(hook(purchaseEnvelope()), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    // Default brand is acme.
    expect(params.from).toBe("Acme Inc. <hello@acme.example>");
    expect(params.to).toEqual(["buyer@example.com"]);
    expect(params.replyTo).toBe("inbox@acme.example");
    // payment template subject includes the orderId (sessionId preferred).
    expect(params.subject).toBe("Potwierdzenie płatności - cs_test_123");
    // amount 4999 cents -> "49.99" (money divides by 100), currency uppercased.
    expect(params.html).toContain("49.99 PLN");
    expect(params.html).toContain("Protocol: X");
    expect(params.html).toContain("cs_test_123");
    expect(params.html).toContain("Anna Nowak");
  });

  it("falls back to paymentIntentId when sessionId is absent", async () => {
    const deps = makeDeps();
    const env = purchaseEnvelope();
    delete (env.data.order as Record<string, unknown>).sessionId;
    const res = await handleSellfHook(hook(env), makeEnv(), deps);
    expect(res.status).toBe(200);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Potwierdzenie płatności - pi_test_999");
  });
});

describe("handleSellfHook — other mapped events", () => {
  it("refund.issued -> notice with refund text and amount", async () => {
    const deps = makeDeps();
    const envelope = {
      event: "refund.issued",
      timestamp: "2026-06-10T10:00:00.000Z",
      data: {
        customer: makeCustomer(),
        product: { name: "Protocol: X" },
        refund: { amount: 4999, currency: "pln" },
        payment: { sessionId: "cs_refund_1" },
      },
    };
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Zwrot środków");
    expect(params.to).toEqual(["buyer@example.com"]);
    expect(params.html).toContain("Zwróciliśmy 49.99 PLN za: Protocol: X.");
    expect(params.html).toContain("Numer transakcji: cs_refund_1.");
  });

  it("waitlist.signup -> notice acknowledging the signup", async () => {
    const deps = makeDeps();
    const envelope = {
      event: "waitlist.signup",
      timestamp: "2026-06-10T10:00:00.000Z",
      data: { customer: makeCustomer(), product: { name: "Acme Pro" } },
    };
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Jesteś na liście oczekujących");
    expect(params.html).toContain("Dziękujemy za zapis na: Acme Pro.");
    expect(params.html).toContain("Damy znać, gdy produkt będzie dostępny.");
  });

  it("lead.captured -> welcome with the access intro", async () => {
    const deps = makeDeps();
    const envelope = {
      event: "lead.captured",
      timestamp: "2026-06-10T10:00:00.000Z",
      data: { customer: makeCustomer(), product: { name: "Lead Magnet" } },
    };
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    // welcome template subject: "Witaj w <brand.name>"
    expect(params.subject).toBe("Witaj w Acme Inc.");
    expect(params.html).toContain("Twój dostęp do Lead Magnet jest gotowy.");
  });

  it("access.expired -> notice prompting renewal", async () => {
    const deps = makeDeps();
    const envelope = {
      event: "access.expired",
      timestamp: "2026-06-10T10:00:00.000Z",
      data: { customer: makeCustomer(), product: { name: "Protocol: X" } },
    };
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Dostęp wygasł");
    expect(params.html).toContain("Twój dostęp do Protocol: X wygasł.");
  });
});

describe("handleSellfHook — ignored / guards", () => {
  it("acks an unmapped event without sending", async () => {
    const deps = makeDeps();
    const envelope = {
      event: "subscription.created",
      timestamp: "2026-06-10T10:00:00.000Z",
      data: { customer: makeCustomer() },
    };
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      ignored: "subscription.created",
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("acks ignored 'no-email' when the customer email is missing", async () => {
    const deps = makeDeps();
    const envelope = purchaseEnvelope();
    delete (envelope.data.customer as Record<string, unknown>).email;
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ignored: "no-email" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("acks ignored 'no-email' when the email is invalid", async () => {
    const deps = makeDeps();
    const envelope = purchaseEnvelope();
    (envelope.data.customer as Record<string, unknown>).email = "not-an-email";
    const res = await handleSellfHook(hook(envelope), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ignored: "no-email" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const deps = makeDeps();
    const res = await handleSellfHook(hook("{not json"), makeEnv(), deps);
    expect(res.status).toBe(400);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});

describe("handleSellfHook — brand selection", () => {
  it("honors ?brand= override", async () => {
    const deps = makeDeps();
    const res = await handleSellfHook(
      hook(purchaseEnvelope(), { brand: "demo" }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.from).toBe("Demo Brand <noreply@demo.example>");
    expect(params.replyTo).toBe("team@demo.example");
  });

  it("returns 400 for an unknown brand", async () => {
    const deps = makeDeps();
    const res = await handleSellfHook(
      hook(purchaseEnvelope(), { brand: "nope" }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, message: "unknown brand" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});

describe("handleSellfHook — send failure", () => {
  it("returns 502 when SES fails (so Sellf retries)", async () => {
    const deps = makeDeps({
      sendEmail: vi.fn(async () => ({ ok: false, status: 500 })),
    });
    const res = await handleSellfHook(hook(purchaseEnvelope()), makeEnv(), deps);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, message: "send failed" });
  });
});
