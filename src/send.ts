import type {
  Brand,
  Env,
  SendDeps,
  SendResult,
  TemplateData,
  TemplateDef,
} from "./types";
import { getBrand } from "./registry";
import { corsHeaders, isOriginAllowed } from "./cors";
import { checkRateLimit } from "./ratelimit";
import { getTemplate, renderLayout } from "./templates/index";
import { META_KEYS } from "./templates/types/contact";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELDS = 40;
const MAX_VALUE_CHARS = 5000;
const MAX_TRUSTED_RECIPIENTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TEMPLATE = "contact";

/** Control keys that are NEVER rendered as content. */
const RESERVED_KEYS = new Set([
  "brand",
  "access_key",
  "cf-turnstile-response",
  "botcheck",
  "subject",
  "to",
  "replyTo",
  "template",
  "autoreply",
  "_meta",
]);

const DEFAULT_AUTOREPLY_TEMPLATE = "received";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off", ""]);

/**
 * Parse the per-request `autoreply` override. Returns undefined when absent or
 * unrecognized (so the brand default applies).
 */
function parseAutoReplyOverride(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

interface JsonResponseInit {
  status?: number;
  cors?: string | null;
}

function json(
  body: { success: boolean; message?: string },
  init: JsonResponseInit = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (init.cors) Object.assign(headers, corsHeaders(init.cors));
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

/** Constant-time string comparison (length-safe) for bearer tokens. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Extract the bearer token from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** True when the request carries a bearer token matching `env.API_KEY`. */
export function isTrusted(req: Request, env: Env): boolean {
  const token = bearerToken(req);
  return !!token && !!env.API_KEY && timingSafeEqual(token, env.API_KEY);
}

/**
 * Coerce a raw JSON value to a capped string. Arrays of strings are joined with
 * blank lines (so e.g. `notice.paragraphs: [...]` survives as text blocks);
 * objects/null/other-arrays become "".
 */
function coerceValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.slice(0, MAX_VALUE_CHARS);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v.join("\n\n").slice(0, MAX_VALUE_CHARS);
  }
  return "";
}

/** Build the flat content map (non-reserved keys, coerced + capped). */
function extractData(body: Record<string, unknown>): TemplateData {
  const data: TemplateData = {};
  let count = 0;
  for (const [key, raw] of Object.entries(body)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (count >= MAX_FIELDS) break;
    data[key] = coerceValue(raw);
    count++;
  }
  return data;
}

/** Validate + normalize a trusted-mode `to` override. Returns null if invalid. */
function normalizeTrustedRecipients(raw: unknown): string[] | null {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return null;
    const email = item.trim();
    if (!EMAIL_RE.test(email)) return null;
    out.push(email);
    if (out.length > MAX_TRUSTED_RECIPIENTS) return null;
  }
  return out.length > 0 ? out : null;
}

/**
 * Handle POST /v1/send. Two modes:
 *  - Trusted: valid `Authorization: Bearer <API_KEY>` skips Turnstile/origin,
 *    may pick a `template`, set `subject`/`replyTo`, and a validated `to`.
 *  - Public: enforces origin allowlist, honeypot, Turnstile, and rate limit, and
 *    is always pinned to the `contact` template.
 *
 * In BOTH modes the recipient defaults to the brand's fixed `to`; a public
 * request can NEVER redirect mail (anti-relay).
 */
export async function handleSend(
  req: Request,
  env: Env,
  deps: SendDeps,
): Promise<Response> {
  const origin = req.headers.get("origin") || "";
  const ip = req.headers.get("cf-connecting-ip");

  // Size guard before parsing.
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_BODY_BYTES) {
    return json({ success: false, message: "payload too large" }, { status: 413 });
  }

  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return json({ success: false, message: "payload too large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ success: false, message: "invalid JSON" }, { status: 400 });
  }

  const brandId = typeof body.brand === "string" ? body.brand : "";
  const brand = getBrand(brandId);
  if (!brand) {
    return json({ success: false, message: "unknown brand" }, { status: 400 });
  }

  const originAllowed = isOriginAllowed(brand, origin);
  const corsOrigin = originAllowed ? origin : null;

  // Trusted mode: bearer matches API_KEY (constant-time).
  const trusted = isTrusted(req, env);

  if (!trusted) {
    // 1) Origin allowlist.
    if (!originAllowed) {
      return json({ success: false, message: "origin not allowed" }, { status: 403 });
    }
    // 2) Honeypot: a filled `botcheck` -> pretend success, send nothing.
    const honeypot = coerceValue(body.botcheck);
    if (honeypot.trim() !== "") {
      return json({ success: true }, { cors: corsOrigin });
    }
    // 3) Turnstile.
    const tsToken = coerceValue(body["cf-turnstile-response"]);
    const ok = await deps.verifyTurnstile(env.TURNSTILE_SECRET, tsToken, ip);
    if (!ok) {
      return json(
        { success: false, message: "verification failed" },
        { status: 403, cors: corsOrigin },
      );
    }
    // 4) Rate limit.
    const allowed = await checkRateLimit(env.RATE_LIMIT, brand.id, ip || "");
    if (!allowed) {
      return json(
        { success: false, message: "rate limit exceeded" },
        { status: 429, cors: corsOrigin },
      );
    }
  }

  // Template selection. Public is always pinned to `contact` (ignore body.template
  // for safety); trusted may pick any registered template.
  const templateId = trusted
    ? typeof body.template === "string" && body.template.trim() !== ""
      ? body.template.trim()
      : DEFAULT_TEMPLATE
    : DEFAULT_TEMPLATE;
  const template = getTemplate(templateId);
  if (!template) {
    return json(
      { success: false, message: "unknown template" },
      { status: 400, cors: corsOrigin },
    );
  }

  // Content fields (reserved keys stripped).
  const data = extractData(body);
  // For the contact template, attach request-time meta (footer small print).
  if (template.id === "contact") {
    data[META_KEYS.receivedAt] = deps.now().toISOString();
    data[META_KEYS.origin] = origin;
    data[META_KEYS.ip] = ip || "";
  }

  // Recipient: trusted may override (validated); otherwise ALWAYS brand.to.
  let recipients = brand.to;
  if (trusted && body.to !== undefined) {
    const normalized = normalizeTrustedRecipients(body.to);
    if (!normalized) {
      return json(
        { success: false, message: "invalid recipient" },
        { status: 400, cors: corsOrigin },
      );
    }
    recipients = normalized;
  }

  // Reply-To: contact -> submitter email; other templates -> brand inbox.
  // Trusted requests may override with a validated `replyTo`.
  const replyTo = resolveReplyTo(brand, template.id, data, trusted, body.replyTo);

  // Subject: trusted `subject` override wins, else the template decides.
  const subjectOverride =
    trusted && typeof body.subject === "string" && body.subject.trim() !== ""
      ? body.subject.trim()
      : undefined;

  const result = await renderAndSend(deps, env, brand, template, data, {
    to: recipients,
    replyTo,
    subject: subjectOverride,
  });

  if (!result.ok) {
    return json(
      { success: false, message: "send failed" },
      { status: 502, cors: corsOrigin },
    );
  }

  // Best-effort auto-reply to the submitter (public contact form only), dispatched
  // off the request path so it never delays or fails the user's response.
  maybeSendAutoReply({ trusted, brand, templateId: template.id, data, body, env, deps });

  return json({ success: true }, { cors: corsOrigin });
}

interface AutoReplyContext {
  trusted: boolean;
  brand: Brand;
  templateId: string;
  data: TemplateData;
  body: Record<string, unknown>;
  env: Env;
  deps: SendDeps;
}

/**
 * Send a confirmation back to the submitter, if enabled. Fires only for the
 * public `contact` flow with a valid submitter email. Non-blocking and
 * best-effort: dispatched via `deps.waitUntil` when available, otherwise
 * detached; errors are swallowed (the main submission already succeeded).
 */
function maybeSendAutoReply(ctx: AutoReplyContext): void {
  const { trusted, brand, templateId, data, body, env, deps } = ctx;

  // Public contact form only — trusted/transactional sends never auto-reply.
  if (trusted || templateId !== "contact") return;

  // Per-request override wins over the brand default.
  const override = parseAutoReplyOverride(body.autoreply);
  const enabled = override ?? brand.autoReply ?? false;
  if (!enabled) return;

  // Only reply to a syntactically valid submitter address.
  const to = (data.email || "").trim();
  if (!EMAIL_RE.test(to)) return;

  const template = getTemplate(brand.autoReplyTemplate ?? DEFAULT_AUTOREPLY_TEMPLATE);
  if (!template) return;

  // Build a small confirmation payload from the submission.
  const replyData: TemplateData = {
    name: data.name || data["Imię i nazwisko"] || "",
    summary: data.type || data.topic || "",
  };

  // Start the task on a later tick so it never runs in the synchronous request
  // path; this keeps the user response immediate and the send observable only
  // through whatever drains the dispatched promise.
  const task = (async () => {
    await Promise.resolve();
    const rendered = template.render(brand, replyData);
    const { html, text } = renderLayout(brand, {
      heading: rendered.heading,
      bodyHtml: rendered.bodyHtml,
      bodyText: rendered.bodyText,
      previewText: rendered.previewText,
    });
    await deps.sendEmail(env, {
      from: brand.from,
      to: [to],
      replyTo: brand.to[0],
      subject: template.subject(brand, replyData),
      html,
      text,
    });
  })();

  if (deps.waitUntil) {
    deps.waitUntil(task.catch(() => {}));
  } else {
    void task.catch(() => {});
  }
}

/** Decide the Reply-To address for an outgoing email. */
function resolveReplyTo(
  brand: Brand,
  templateId: string,
  data: TemplateData,
  trusted: boolean,
  override: unknown,
): string | undefined {
  if (trusted && typeof override === "string") {
    const candidate = override.trim();
    if (EMAIL_RE.test(candidate)) return candidate;
  }
  if (templateId === "contact") {
    const email = (data.email || "").trim();
    return EMAIL_RE.test(email) ? email : undefined;
  }
  return brand.to[0];
}

export interface RenderAndSendParams {
  to: string[];
  replyTo?: string;
  /** Overrides the template's own subject when set. */
  subject?: string;
}

/**
 * Render a template through the shared layout and send it via SES. Shared by the
 * trusted `/v1/send` path and the Sellf webhook so both produce identical,
 * brand-themed mail. Awaited (not background) so callers can surface failures.
 */
export async function renderAndSend(
  deps: SendDeps,
  env: Env,
  brand: Brand,
  template: TemplateDef,
  data: TemplateData,
  params: RenderAndSendParams,
): Promise<SendResult> {
  const subject =
    params.subject && params.subject.trim() !== ""
      ? params.subject.trim()
      : template.subject(brand, data);
  const rendered = template.render(brand, data);
  const { html, text } = renderLayout(brand, {
    heading: rendered.heading,
    bodyHtml: rendered.bodyHtml,
    bodyText: rendered.bodyText,
    previewText: rendered.previewText,
  });
  return deps.sendEmail(env, {
    from: brand.from,
    to: params.to,
    replyTo: params.replyTo,
    subject,
    html,
    text,
  });
}
