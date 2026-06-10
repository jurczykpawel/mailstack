import { describe, it, expect, vi } from "vitest";
import { handleSend } from "../src/send";
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

/** Minimal in-memory KV with TTL ignored (good enough for limit counting). */
function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeDeps(overrides: Partial<SendDeps> = {}): SendDeps & {
  sendEmail: ReturnType<typeof vi.fn>;
  verifyTurnstile: ReturnType<typeof vi.fn>;
} {
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({
    ok: true,
    status: 200,
  }));
  const verifyTurnstile = vi.fn(async () => true);
  return {
    sendEmail,
    verifyTurnstile,
    now: () => new Date("2026-06-10T12:00:00.000Z"),
    ...overrides,
  } as SendDeps & {
    sendEmail: ReturnType<typeof vi.fn>;
    verifyTurnstile: ReturnType<typeof vi.fn>;
  };
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

// acme has autoReply: true and allows localhost:4322
const ACME_ORIGIN = "https://acme.example";

describe("handleSend — public mode", () => {
  it("rejects a disallowed origin with 403 and no CORS header", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req({ brand: "acme", email: "a@b.com" }, { origin: "https://evil.example" }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data).toEqual({ success: false, message: "origin not allowed" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown brand", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req({ brand: "nope" }, { origin: ACME_ORIGIN }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(400);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("honeypot filled -> success:true but SES NOT called", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        { brand: "acme", email: "a@b.com", botcheck: "i am a bot" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ACME_ORIGIN);
  });

  it("Turnstile failure -> 403 and SES not called", async () => {
    const deps = makeDeps({ verifyTurnstile: vi.fn(async () => false) });
    const res = await handleSend(
      req(
        { brand: "acme", email: "a@b.com", "cf-turnstile-response": "bad" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      message: "verification failed",
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("anti-relay: body `to` is IGNORED, SES called with brand.to", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          email: "a@b.com",
          to: "attacker@evil.com",
          from: "spoof@evil.com",
          autoreply: "0", // isolate the main send
        },
        { origin: ACME_ORIGIN, "cf-connecting-ip": "9.9.9.9" },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.to).toEqual(["inbox@acme.example"]);
    expect(params.from).toBe("Acme Inc. <hello@acme.example>");
  });

  it("happy path: SES called once with correct From/To/Reply-To/subject", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          name: "Jane Smith",
          email: "jane@example.com",
          type: "Consultation",
          message: "Please get in touch.",
          autoreply: "0", // isolate the main send (auto-reply covered separately)
          "cf-turnstile-response": "ok",
        },
        { origin: ACME_ORIGIN, "cf-connecting-ip": "1.2.3.4" },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ACME_ORIGIN);

    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.from).toBe("Acme Inc. <hello@acme.example>");
    expect(params.to).toEqual(["inbox@acme.example"]);
    expect(params.replyTo).toBe("jane@example.com");
    expect(params.subject).toBe("New message from — Consultation — Acme Inc.");
    expect(params.html).toContain("Jane Smith");
  });

  it("enforces the rate limit after the max window", async () => {
    const deps = makeDeps();
    const env = makeEnv({ RATE_LIMIT: fakeKV() });
    const send = () =>
      handleSend(
        req(
          {
            brand: "acme",
            email: "a@b.com",
            autoreply: "0", // isolate the main send
            "cf-turnstile-response": "ok",
          },
          { origin: ACME_ORIGIN, "cf-connecting-ip": "5.5.5.5" },
        ),
        env,
        deps,
      );

    for (let i = 0; i < 8; i++) {
      const ok = await send();
      expect(ok.status).toBe(200);
    }
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(deps.sendEmail).toHaveBeenCalledTimes(8);
  });

  it("returns 502 when SES reports a failure", async () => {
    const deps = makeDeps({
      sendEmail: vi.fn(async () => ({ ok: false, status: 500 })),
    });
    const res = await handleSend(
      req(
        { brand: "acme", email: "a@b.com", "cf-turnstile-response": "ok" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, message: "send failed" });
  });

  it("rejects an oversized payload with 413", async () => {
    const deps = makeDeps();
    const big = "x".repeat(70 * 1024);
    const res = await handleSend(
      req({ brand: "acme", message: big }, { origin: ACME_ORIGIN }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(413);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("ignores body `template` and always uses contact (recipient = brand.to)", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          amount: "999",
          name: "Jane Smith",
          email: "jane@example.com",
          autoreply: "0", // isolate the main send
          "cf-turnstile-response": "ok",
        },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    // Contact subject, not the payment one.
    expect(params.subject).toBe("New message from — Acme Inc.");
    expect(params.subject).not.toContain("Potwierdzenie płatności");
    expect(params.to).toEqual(["inbox@acme.example"]);
    // Contact reply-to is the submitter.
    expect(params.replyTo).toBe("jane@example.com");
  });
});

describe("handleSend — trusted mode", () => {
  const auth = { authorization: `Bearer ${API_KEY}` };

  it("valid bearer skips Turnstile and origin checks", async () => {
    const deps = makeDeps({ verifyTurnstile: vi.fn(async () => false) });
    const res = await handleSend(
      // no Origin header, no turnstile token, verify would fail if called
      req({ brand: "acme", email: "a@b.com" }, auth),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.verifyTurnstile).not.toHaveBeenCalled();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("can set a custom subject", async () => {
    const deps = makeDeps();
    await handleSend(
      req({ brand: "acme", subject: "Custom subject", email: "a@b.com" }, auth),
      makeEnv(),
      deps,
    );
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Custom subject");
  });

  it("can override the recipient with a valid email", async () => {
    const deps = makeDeps();
    await handleSend(
      req({ brand: "acme", to: "ops@example.com", email: "a@b.com" }, auth),
      makeEnv(),
      deps,
    );
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.to).toEqual(["ops@example.com"]);
  });

  it("rejects an invalid recipient override with 400", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req({ brand: "acme", to: "not-an-email", email: "a@b.com" }, auth),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(400);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("invalid bearer falls back to public mode (origin enforced)", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        { brand: "acme", email: "a@b.com" },
        { authorization: "Bearer wrong-token", origin: "https://evil.example" },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      message: "origin not allowed",
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("a public subject override is ignored (uses computed subject)", async () => {
    const deps = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          subject: "HACKED SUBJECT",
          email: "a@b.com",
          "cf-turnstile-response": "ok",
        },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).not.toBe("HACKED SUBJECT");
    expect(params.subject).toContain("Acme Inc.");
  });

  it("template:'payment' -> SES called once, subject from template, to honored", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          to: "buyer@example.com",
          name: "Jane",
          amount: "149.00",
          orderId: "ORD-7788",
        },
        auth,
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Potwierdzenie płatności - ORD-7788");
    expect(params.to).toEqual(["buyer@example.com"]);
    expect(params.html).toContain("149.00 PLN");
    // Non-contact templates reply to the brand inbox by default.
    expect(params.replyTo).toBe("inbox@acme.example");
  });

  it("returns 400 for an unknown template", async () => {
    const deps = makeDeps();
    const res = await handleSend(
      req({ brand: "acme", template: "does-not-exist" }, auth),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      message: "unknown template",
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("trusted replyTo override is honored", async () => {
    const deps = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          template: "welcome",
          replyTo: "support@example.com",
          name: "Jane",
        },
        auth,
      ),
      makeEnv(),
      deps,
    );
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.replyTo).toBe("support@example.com");
  });

  it("subject override still wins over a chosen template", async () => {
    const deps = makeDeps();
    await handleSend(
      req(
        {
          brand: "acme",
          template: "payment",
          subject: "Custom payment subject",
          amount: "10",
        },
        auth,
      ),
      makeEnv(),
      deps,
    );
    const params = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(params.subject).toBe("Custom payment subject");
  });

  it("never auto-replies, even with template:'contact'", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req({ brand: "acme", template: "contact", email: "jane@example.com" }, auth),
      makeEnv(),
      deps,
    );
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
});

/** A `waitUntil` that records promises so a test can await the background work. */
function collectingWaitUntil(): {
  waitUntil: (p: Promise<unknown>) => void;
  flush: () => Promise<void>;
} {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p) => {
      promises.push(p);
    },
    flush: async () => {
      await Promise.all(promises);
    },
  };
}

// demo brand has autoReply: false (default)
const DEMO_ORIGIN = "https://demo.example";

describe("handleSend — auto-reply (public contact)", () => {
  it("sends a confirmation to the submitter when brand.autoReply is on", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    const res = await handleSend(
      req(
        {
          brand: "acme", // autoReply: true
          name: "Jane Smith",
          email: "jane@example.com",
          type: "Consultation",
          "cf-turnstile-response": "ok",
        },
        { origin: ACME_ORIGIN, "cf-connecting-ip": "1.2.3.4" },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);

    // 1) main email to the brand inbox.
    const main = deps.sendEmail.mock.calls[0][1] as SendParams;
    expect(main.to).toEqual(["inbox@acme.example"]);

    // 2) auto-reply to the submitter via the `received` template.
    const reply = deps.sendEmail.mock.calls[1][1] as SendParams;
    expect(reply.to).toEqual(["jane@example.com"]);
    expect(reply.from).toBe("Acme Inc. <hello@acme.example>");
    expect(reply.replyTo).toBe("inbox@acme.example");
    expect(reply.subject).toBe("Potwierdzenie: otrzymaliśmy Twoje zgłoszenie");
    expect(reply.html).toContain("Dziękujemy za wiadomość");
    // Submission context carried into the confirmation.
    expect(reply.html).toContain("Jane Smith");
    expect(reply.html).toContain("Consultation");
  });

  it("does not auto-reply when the submitter email is invalid", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req(
        { brand: "acme", name: "Jane", email: "not-an-email", "cf-turnstile-response": "ok" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not auto-reply when the submitter email is missing", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req(
        { brand: "acme", name: "Jane", "cf-turnstile-response": "ok" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("body autoreply:'0' overrides a brand default of true", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req(
        {
          brand: "acme", // default true
          email: "jane@example.com",
          autoreply: "0",
          "cf-turnstile-response": "ok",
        },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("body autoreply:'1' overrides a brand default of false", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    const res = await handleSend(
      req(
        {
          brand: "demo", // default off
          email: "alice@example.com",
          autoreply: "1",
          "cf-turnstile-response": "ok",
        },
        { origin: DEMO_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    const reply = deps.sendEmail.mock.calls[1][1] as SendParams;
    expect(reply.to).toEqual(["alice@example.com"]);
    expect(reply.replyTo).toBe("team@demo.example");
  });

  it("does not auto-reply for a brand with the default off", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req(
        { brand: "demo", email: "alice@example.com", "cf-turnstile-response": "ok" },
        { origin: DEMO_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    await flush();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("still returns success when the auto-reply send rejects (best-effort)", async () => {
    const { waitUntil, flush } = collectingWaitUntil();
    // First send (main) succeeds; second send (auto-reply) throws.
    const sendEmail = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error("SES exploded"));
    const deps = makeDeps({ sendEmail, waitUntil });
    const res = await handleSend(
      req(
        { brand: "acme", email: "jane@example.com", "cf-turnstile-response": "ok" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // flush must not throw — the rejection is swallowed.
    await expect(flush()).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("dispatches the auto-reply through ctx.waitUntil", async () => {
    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    const deps = makeDeps({ waitUntil });
    await handleSend(
      req(
        { brand: "acme", email: "jane@example.com", "cf-turnstile-response": "ok" },
        { origin: ACME_ORIGIN },
      ),
      makeEnv(),
      deps,
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await (waitUntil.mock.calls[0][0] as Promise<unknown>);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
  });
});
