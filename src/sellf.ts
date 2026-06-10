import type { Env, SendDeps, TemplateData } from "./types";
import { getBrand } from "./registry";
import { getTemplate } from "./templates/index";
import { isTrusted, renderAndSend } from "./send";

// Brand used when the request omits `?brand=`. Override per deployment with the
// SELLF_DEFAULT_BRAND var (wrangler.toml [vars]); falls back to "acme" (demo).
const FALLBACK_BRAND = "acme";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sellf webhook envelope. `data` shape varies per event (see SELLF_EVENT_MAP). */
interface SellfEnvelope {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** A resolved outgoing email derived from a Sellf event. */
interface MappedEmail {
  template: string;
  to: string;
  data: TemplateData;
  /** Optional subject override (e.g. for the generic `notice` template). */
  subject?: string;
}

/** Maps one Sellf event payload to an email, or null to skip rendering. */
type SellfMapper = (env: SellfEnvelope) => MappedEmail | null;

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** cents -> "49.00". Non-numeric input yields "0.00". */
function money(cents: unknown): string {
  const n = Number(cents);
  return (Number.isFinite(n) ? n / 100 : 0).toFixed(2);
}

/** ISO timestamp -> Polish-locale date. Invalid input yields "". */
function plDate(iso: unknown): string {
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pl-PL");
}

function upper(v: unknown): string {
  return String(v ?? "").toUpperCase();
}

/** Read a nested object from a record (or undefined). */
function obj(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = source[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function fullName(customer: Record<string, unknown>): string {
  return [str(customer, "firstName"), str(customer, "lastName")]
    .filter(Boolean)
    .join(" ");
}

/**
 * Event -> email mapping. Add an entry here to handle a new Sellf event; any
 * event without an entry is acknowledged (200) and not emailed, so Sellf does
 * not retry. Payload paths mirror Sellf's webhook contract exactly.
 */
const SELLF_EVENT_MAP: Record<string, SellfMapper> = {
  "purchase.completed": ({ data, timestamp }) => {
    const customer = obj(data, "customer");
    const order = obj(data, "order");
    const product = obj(data, "product");
    return {
      template: "payment",
      to: str(customer, "email"),
      data: {
        name: fullName(customer),
        amount: money(order.amount),
        currency: upper(order.currency),
        item: str(product, "name"),
        orderId: str(order, "sessionId") || str(order, "paymentIntentId"),
        date: plDate(timestamp),
      },
    };
  },

  "refund.issued": ({ data }) => {
    const customer = obj(data, "customer");
    const refund = obj(data, "refund");
    const product = obj(data, "product");
    const payment = obj(data, "payment");
    const txId =
      str(payment, "sessionId") || str(payment, "paymentIntentId") || "-";
    return {
      template: "notice",
      to: str(customer, "email"),
      subject: "Zwrot środków",
      data: {
        heading: "Zwrot środków",
        paragraphs: [
          `Zwróciliśmy ${money(refund.amount)} ${upper(refund.currency)} za: ${str(
            product,
            "name",
          )}.`,
          `Numer transakcji: ${txId}.`,
        ].join("\n\n"),
      },
    };
  },

  "waitlist.signup": ({ data }) => {
    const customer = obj(data, "customer");
    const product = obj(data, "product");
    return {
      template: "notice",
      to: str(customer, "email"),
      subject: "Jesteś na liście oczekujących",
      data: {
        heading: "Jesteś na liście oczekujących",
        paragraphs: [
          `Dziękujemy za zapis na: ${str(product, "name")}.`,
          "Damy znać, gdy produkt będzie dostępny.",
        ].join("\n\n"),
      },
    };
  },

  "lead.captured": ({ data }) => {
    const customer = obj(data, "customer");
    const product = obj(data, "product");
    return {
      template: "welcome",
      to: str(customer, "email"),
      data: {
        name: "",
        intro: `Twój dostęp do ${str(product, "name")} jest gotowy.`,
      },
    };
  },

  "access.expired": ({ data }) => {
    const customer = obj(data, "customer");
    const product = obj(data, "product");
    return {
      template: "notice",
      to: str(customer, "email"),
      subject: "Dostęp wygasł",
      data: {
        heading: "Dostęp wygasł",
        paragraphs: [
          `Twój dostęp do ${str(product, "name")} wygasł.`,
          "Jeśli chcesz go odnowić, odpowiedz na tę wiadomość.",
        ].join("\n\n"),
      },
    };
  },
};

/**
 * Handle POST /v1/hooks/sellf. Bearer-only (the existing API_KEY) — Sellf calls
 * us as a trusted client, so there is no HMAC and any X-Sellf-* headers are
 * ignored. Maps the event to a brand-themed email reusing the trusted send
 * pipeline; the recipient is the customer from the payload.
 *
 * Acknowledges (200) unmapped events and missing/invalid recipients so Sellf
 * does not retry them; only a genuine SES failure returns 502 (retryable). The
 * send is awaited (not backgrounded) to stay within Sellf's request timeout.
 */
export async function handleSellfHook(
  req: Request,
  env: Env,
  deps: SendDeps,
): Promise<Response> {
  // Bearer-only auth (constant-time). No HMAC.
  if (!isTrusted(req, env)) {
    return jsonResponse({ success: false, message: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const brandId =
    url.searchParams.get("brand") || env.SELLF_DEFAULT_BRAND || FALLBACK_BRAND;
  const brand = getBrand(brandId);
  if (!brand) {
    return jsonResponse({ success: false, message: "unknown brand" }, 400);
  }

  let envelope: SellfEnvelope;
  try {
    const parsed = JSON.parse((await req.text()) || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    envelope = parsed as SellfEnvelope;
  } catch {
    return jsonResponse({ success: false, message: "invalid JSON" }, 400);
  }

  const event = typeof envelope.event === "string" ? envelope.event : "";
  envelope.data =
    envelope.data && typeof envelope.data === "object"
      ? envelope.data
      : {};

  const mapper = SELLF_EVENT_MAP[event];
  if (!mapper) {
    // Ack so Sellf does not retry an event we intentionally do not email.
    return jsonResponse({ success: true, ignored: event || "unknown" });
  }

  const mapped = mapper(envelope);
  const to = (mapped?.to || "").trim();
  if (!mapped || !EMAIL_RE.test(to)) {
    return jsonResponse({ success: true, ignored: "no-email" });
  }

  const template = getTemplate(mapped.template);
  if (!template) {
    // Misconfigured mapping — ack to avoid a retry storm, but make it visible.
    console.error(`sellf hook: unknown template "${mapped.template}" for ${event}`);
    return jsonResponse({ success: true, ignored: "unknown-template" });
  }

  const result = await renderAndSend(deps, env, brand, template, mapped.data, {
    to: [to],
    replyTo: brand.to[0],
    subject: mapped.subject,
  });

  if (!result.ok) {
    return jsonResponse({ success: false, message: "send failed" }, 502);
  }
  return jsonResponse({ success: true });
}
