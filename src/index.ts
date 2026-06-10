import type { Env, SendDeps } from "./types";
import { findBrandByOrigin, getBrand } from "./registry";
import { corsHeaders, isOriginAllowed } from "./cors";
import { handleSend } from "./send";
import { handleSellfHook } from "./sellf";
import { sendEmail } from "./ses";
import { verifyTurnstile } from "./turnstile";
import { LOGO_PNG_BASE64 } from "./assets/logo";

const defaultDeps: SendDeps = {
  verifyTurnstile,
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

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health" && req.method === "GET") {
      return new Response(
        JSON.stringify({ ok: true, service: "mailstack" }),
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

    if (pathname === "/v1/send") {
      if (req.method === "OPTIONS") return handlePreflight(req, url);
      if (req.method === "POST") {
        // Bind ctx.waitUntil so the best-effort auto-reply outlives the response.
        return handleSend(req, env, {
          ...defaultDeps,
          waitUntil: ctx.waitUntil.bind(ctx),
        });
      }
    }

    // Sellf webhook (server-to-server, bearer-only). Sends synchronously so a
    // failed SES call surfaces as 502 and Sellf retries — no waitUntil here.
    if (pathname === "/v1/hooks/sellf" && req.method === "POST") {
      return handleSellfHook(req, env, defaultDeps);
    }

    return notFound();
  },
};
