import { createNtfyNotifier } from './adapters/notify/ntfy';
import { parseKeyring } from "./core/keyring";
import { handleSesEvent } from "./events/ses";
import { createVerifier } from "./events/sns";
import type { KyselyStore } from "./core/store";
import { createD1Store } from "./core/store/d1";
import { runJobs } from "./core/jobs";
import { version } from "../package.json";
import type { Env, SendDeps } from "./types";
import { config, findBrandByOrigin, getBrand } from "./core/config";
import { corsHeaders, isOriginAllowed } from "./cors";
import { handleSend } from "./send";
import { handleSourceHook } from "./sources";
import { sendEmail } from "./ses";
import { verifyTurnstile } from "./turnstile";
import { createChallenge, createNonce, verifyAltcha } from "./altcha";
import { LOGO_PNG_BASE64 } from "./assets/logo";
import { proExtension, proKeys } from "./core/pro.generated";
import { createExtensionHost, type ExtensionHost } from "./core/extension-host";
import { internalFetch } from "./core/internal";
import { authorizePanel } from "./core/panel";
import { createAccessVerifier, type AccessVerifier } from "./core/access";
import type { KeyProvider } from "./clients";
import type { EmitEvent } from "./core/extensions";

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

export function createApp(overrides: Omit<Partial<SendDeps>, "store"> & { store?: KyselyStore; access?: AccessVerifier } = {}, pro = proKeys, extension = proExtension) {
  const access = overrides.access ?? createAccessVerifier();
  // Built once per isolate on first use (needs env); a failure leaves only the full key.
  let keys: Promise<KeyProvider | undefined> | undefined, host: Promise<ExtensionHost> | undefined;
  // Extensions come only from the static Pro build; keys stay with `pro` above (license cache in D1).
  const extensions = (store: KyselyStore) => host ??= createExtensionHost(config, store, async module => {
    if (module === "mailstack-pro" && extension) return { default: extension };
    throw new Error("Extension not built into the Worker");
  }, { keys: undefined, kickJobs: true });
  return {
    scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
      if (!env.DB) throw new Error("Scheduled storage unavailable");
      const store = createD1Store(env.DB);
      if (event.cron === "17 * * * *") ctx.waitUntil(extensions(store).then(h => h.runRetention(event.scheduledTime)));
      // The host registers this isolate's reconcile handlers before the jobs drain.
      else if (event.cron === "* * * * *") ctx.waitUntil(extensions(store).then(h =>
        runJobs(store, "cron", { notifier: env.NTFY_URL ? createNtfyNotifier(env) : undefined, ...h.jobs })));
    },
    async fetch(
      req: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const store = overrides.store ?? (env.DB ? createD1Store(env.DB) : undefined);
      keys ??= Promise.resolve().then(() => pro?.(config, env)).catch(() => undefined);
      const deps = { ...defaultDeps, ...overrides, store, keys: overrides.keys ?? await keys,
        notifier: overrides.notifier ?? (env.NTFY_URL ? createNtfyNotifier(env) : undefined),
        waitUntil: ctx.waitUntil?.bind(ctx) ?? overrides.waitUntil,
        emitEvent: overrides.emitEvent ?? (store && config.extensions.length ? ((event, defer) => defer?.(extensions(store).then(h => h.emitEvent(event)))) satisfies EmitEvent : undefined),
        durableEvents: overrides.durableEvents ?? (store && config.extensions.length ? () => extensions(store).then(h => h.durableEvents()) : undefined),
      };
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/health" && req.method === "GET") {
        let storeState = "down";
        try { if (store) { await store.health(); storeState = "ok"; } } catch {}
        return new Response(
          JSON.stringify({ store: storeState, ok: true, service: "mailstack", version, commit: env.BUILD_COMMIT || "dev",
            ...(env.BUILD_PRO_COMMIT ? { proCommit: env.BUILD_PRO_COMMIT } : {}) }),
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
          const product = url.searchParams.get("product") ?? "";
          if (brand.requireNonce && !brand.products?.includes(product)) {
            return Response.json({ success: false, message: "invalid product" }, { status: 400, headers: corsHeaders(origin) });
          }
          if (brand.requireNonce && !env.ALTCHA_HMAC_KEY) {
            return Response.json({ success: false, message: "verification failed" }, { status: 503, headers: corsHeaders(origin) });
          }
          const challenge = await createChallenge(env.ALTCHA_HMAC_KEY);
          const result = brand.requireNonce
            ? { altcha: challenge, nonce: await createNonce(env.ALTCHA_HMAC_KEY, brand.id, product, deps.now()) } : challenge;
          return new Response(JSON.stringify(result), {
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
          return handleSend(req, env, deps);
        }
      }

      const sourceId = /^\/v1\/hooks\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(pathname)?.[1];
      if (sourceId && req.method === "POST" && config.sources && Object.hasOwn(config.sources, sourceId)) {
        return handleSourceHook(req, env, deps, sourceId);
      }

      const ext = pathname.startsWith("/internal/ext/");
      if ((ext || pathname.startsWith("/internal/v2/")) && store && env.PANEL_ASSERTION_KEYS && env.INTERNAL_HOST && url.hostname === env.INTERNAL_HOST) {
        if (!await access(req, env)) return Response.json({ success: false }, { status: 403 });
        const panel = await authorizePanel(req, env, config, { audience: env.INTERNAL_HOST, store, keys: deps.keys, defer: deps.waitUntil });
        if (panel instanceof Response) return panel;
        if (ext) return (await extensions(store)).route(req, env, panel);
        const response = await internalFetch(req, env, store, config, panel, { platform: "worker", extensions: () => extensions(store) });
        // 202 = work stored as a job; start it now instead of waiting for the minute cron.
        if (response.status === 202) deps.waitUntil?.(extensions(store).then(h => runJobs(store, "request", h.jobs)));
        return response;
      }

      if (pathname === "/v1/events/ses" && req.method === "POST") {
        try {
          return await handleSesEvent(req, { ...deps, options: config.events?.ses, verify: verifySns,
            store, now: () => deps.now().getTime(),
            ...parseKeyring(env), panelUrl: env.PANEL_URL });
        } catch { return Response.json({ ok: false }, { status: 503 }); }
      }
      return notFound();
    },
  };
}
export default createApp();
// The egress container class (Durable Object) when the Worker is built with Mailstack Pro.
export * from "./core/pro-exports.generated";
