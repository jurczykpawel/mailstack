import { createNtfyNotifier } from './adapters/notify/ntfy';
import { parseKeyring } from "./core/keyring";
import { handleSesEvent } from "./events/ses";
import { createVerifier } from "./events/sns";
import { createD1Store } from "./core/store/d1";
import { runRetention } from "./core/retention";
import { version } from "../package.json";
import type { Env, SendDeps } from "./types";
import { config, findBrandByOrigin, getBrand } from "./core/config";
import { corsHeaders, isOriginAllowed } from "./cors";
import { handleSend } from "./send";
import { handleSellfHook } from "./sellf";
import { sendEmail } from "./ses";
import { verifyTurnstile } from "./turnstile";
import { createChallenge, verifyAltcha } from "./altcha";
import { LOGO_PNG_BASE64 } from "./assets/logo";

const verifySns = createVerifier();

const defaultDeps: SendDeps = {
  logging: config.logging,
  verifyTurnstile,
  verifyAltcha,
  sendEmail,
  now: () => new Date(),
};

function notFound(): Response {
  return new Response(JSON.stringify({ success: false, message: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * CORS preflight for /v1/send. Resolve the brand from `?brand=` when given,
 * otherwise from any brand whose allowlist contains the Origin. Reply 204 with
 * CORS headers when allowed, else 403 with no CORS headers.
 */
function handlePreflight(req: Request, url: URL): Response {
  const origin = req.headers.get("origin") || "";
  const brandId = url.searchParams.get("brand");
  const brand = brandId ? getBrand(brandId) : findBrandByOrigin(origin);

  if (brand && isOriginAllowed(brand, origin)) {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  return new Response(null, { status: 403 });
}

export function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
  if (!env.DB) throw new Error("Retention storage unavailable");
  ctx.waitUntil(runRetention(createD1Store(env.DB), event.scheduledTime, config));
}

export default {
  scheduled,
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health" && req.method === "GET") {
      return new Response(
        JSON.stringify({ ok: true, service: "mailstack", version, commit: env.BUILD_COMMIT || "dev" }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }

    // Serve the brand logo for email headers.
    if (pathname === "/brand/logo.png" && req.method === "GET") {
      const bin = Uint8Array.from(atob(LOGO_PNG_BASE64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (pathname === "/altcha/challenge") {
      if (req.method === "OPTIONS") return handlePreflight(req, url);
      if (req.method === "GET") {
        const origin = req.headers.get("origin") || "";
        const brandId = url.searchParams.get("brand");
        const brand = brandId ? getBrand(brandId) : findBrandByOrigin(origin);
        if (!brand || !isOriginAllowed(brand, origin)) {
          return new Response(JSON.stringify({ success: false, message: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        const challenge = await createChallenge(env.ALTCHA_HMAC_KEY);
        return new Response(JSON.stringify(challenge), {
          headers: {
            ...corsHeaders(origin),
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    }

    if (pathname === "/v1/send") {
      if (req.method === "OPTIONS") return handlePreflight(req, url);
      if (req.method === "POST") {
        // Bind ctx.waitUntil so the best-effort auto-reply outlives the response.
        return handleSend(req, env, {
          ...defaultDeps,
          store: env.DB ? createD1Store(env.DB) : undefined,
          waitUntil: ctx.waitUntil.bind(ctx),
        });
      }
    }

    if (pathname === "/v1/hooks/sellf" && req.method === "POST") {
      return handleSellfHook(req, env, { ...defaultDeps, store: env.DB ? createD1Store(env.DB) : undefined,
        waitUntil: ctx.waitUntil.bind(ctx) });
    }

    if (pathname === "/v1/events/ses" && req.method === "POST") {
      try {
        return await handleSesEvent(req, { options: config.events?.ses, verify: verifySns,
          store: env.DB ? createD1Store(env.DB) : undefined, now: Date.now,
          ...parseKeyring(env), notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, panelUrl: env.PANEL_URL });
      } catch { return Response.json({ ok: false }, { status: 503 }); }
    }
    return notFound();
  },
};
