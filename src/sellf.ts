import { purchaseLicenseData, purchaseLicensesSchema } from "./purchase-licenses";
import { z } from "zod";
import { boundedText } from "./core/http";
import type { Brand, Env, SendDeps, TemplateData } from "./types";
import { config, getBrand } from "./core/config";
import { deliveryResponse } from "./core/logging/delivery";
import { authenticate, permits, tokenSha256 } from "./clients.ts";
import { getTemplate, missingRequiredFields } from "./templates/index";
import { renderAndSend } from "./send";

// Brand used when the request omits `?brand=`. Override per deployment with the
// SELLF_DEFAULT_BRAND var (wrangler.toml [vars]); falls back to "acme" (demo).
const FALLBACK_BRAND = "acme";

const nonempty = z.string().refine(value => value.trim().length > 0);
const isoTimestamp = z.iso.datetime({ offset: true });
const envelopeSchema = z.object({
  event: nonempty,
  timestamp: isoTimestamp,
  data: z.record(z.string(), z.unknown()),
});
type SellfEnvelope = z.infer<typeof envelopeSchema>;
const currency = z.string().regex(/^[A-Za-z]{3}$/);
const minorAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const transaction = z.object({
  sessionId: nonempty.nullish(),
  paymentIntentId: nonempty.nullish(),
  amount: minorAmount,
  currency,
}).superRefine((value, ctx) => {
  if (!value.sessionId && !value.paymentIntentId) {
    for (const field of ["sessionId", "paymentIntentId"]) {
      ctx.addIssue({ code: "custom", path: [field], message: "required identifier" });
    }
  }
});
const commonData = z.object({
  customer: z.object({ email: z.string().trim().pipe(z.email()) }),
  product: z.object({ name: nonempty }),
});
const purchaseData = commonData.extend({ order: transaction, licenses: purchaseLicensesSchema.optional() });
const refundData = commonData.extend({
  payment: transaction.safeExtend({ id: nonempty }),
  refund: z.object({
    stripeRefundId: nonempty,
    amount: minorAmount.refine(value => value > 0),
    currency,
    status: z.literal("succeeded"),
    isFullRefund: z.boolean(),
    totalRefunded: minorAmount,
    refundedAt: isoTimestamp,
  }),
}).superRefine(({ payment, refund }, ctx) => {
  const invalid = (field: string) => ctx.addIssue({ code: "custom", path: ["refund", field], message: "inconsistent refund" });
  if (refund.currency.toUpperCase() !== payment.currency.toUpperCase()) invalid("currency");
  if (refund.totalRefunded < refund.amount || refund.totalRefunded > payment.amount) invalid("totalRefunded");
  if (refund.isFullRefund !== (refund.totalRefunded === payment.amount)) invalid("isFullRefund");
});
const unsupportedEvents = new Set([
  "subscription.created", "subscription.updated", "subscription.canceled",
  "subscription.trial_ending", "subscription.renewal_upcoming",
  "invoice.paid", "invoice.payment_failed", "license.revoked",
]);

/** A resolved outgoing email derived from a Sellf event. */
interface MappedEmail {
  template: string;
  to: string;
  data: TemplateData;
  /** Optional subject override (e.g. for the generic `notice` template). */
  subject?: string;
}

/** Maps one Sellf event payload to an email, or null to skip rendering. */
type SellfMapper = (env: SellfEnvelope, brand: Brand) => MappedEmail | null;

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
 * Event -> email mapping after envelope and event-data validation.
 * Unknown events are acknowledged; explicitly unsupported events are declined.
 */
const SELLF_EVENT_MAP: Record<string, SellfMapper> = {
  "purchase.completed": ({ data, timestamp }, brand) => {
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
        orderId: str(order, "paymentIntentId") || str(order, "sessionId"),
        date: plDate(timestamp),
        ...purchaseLicenseData(data, brand),
      },
    };
  },

  "refund.issued": ({ data }) => {
    const customer = obj(data, "customer");
    const refund = obj(data, "refund");
    const product = obj(data, "product");
    const payment = obj(data, "payment");
    const txId =
      str(payment, "paymentIntentId") || str(payment, "sessionId");
    return {
      template: "refund",
      to: str(customer, "email"),
      data: {
        amount: money(refund.amount),
        currency: upper(refund.currency),
        productName: str(product, "name"),
        transactionId: txId,
        paymentId: str(payment, "id"),
        refundId: str(refund, "stripeRefundId"),
        isFullRefund: str(refund, "isFullRefund"),
        totalRefunded: money(refund.totalRefunded),
        refundedAt: str(refund, "refundedAt"),
        reason: typeof refund.reason === "string" ? refund.reason : "",
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

/** Handle Sellf events for authenticated clients through the shared send pipeline. */
export async function handleSellfHook(
  req: Request,
  env: Env,
  deps: SendDeps,
): Promise<Response> {
  const client = await authenticate(req, env, config);
  if (!client) {
    return jsonResponse({ success: false, message: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const brandId =
    url.searchParams.get("brand") || env.SELLF_DEFAULT_BRAND || FALLBACK_BRAND;
  if (!permits(client, "hook:sellf", brandId)) {
    return jsonResponse({ success: false, message: "forbidden", code: "scope" }, 403);
  }
  const brand = getBrand(brandId);
  if (!brand) {
    return jsonResponse({ success: false, message: "unknown brand" }, 400);
  }

  let rawBody: string;
  try {
    rawBody = await boundedText(req, 64 * 1024);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return jsonResponse({ success: false, message: "payload too large" }, 413);
  }
  if (client.sellfSignatureSecretEnv && !await verifySignature(req, rawBody, Reflect.get(env, client.sellfSignatureSecretEnv), deps.now())) {
    return jsonResponse({ success: false, message: "unauthorized" }, 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ success: false, message: "invalid JSON" }, 400);
  }
  const validated = envelopeSchema.safeParse(parsed);
  if (!validated.success) {
    return jsonResponse({ success: false, code: "invalid_envelope", message: "invalid envelope" }, 400);
  }
  const envelope = validated.data;
  const event = envelope.event;
  if (unsupportedEvents.has(event)) {
    return jsonResponse({ success: false, code: "unsupported_event", message: `Unsupported event: ${event}. Disable this event in the sender; retry will not help.` }, 422);
  }

  const mapper = Object.hasOwn(SELLF_EVENT_MAP, event) ? SELLF_EVENT_MAP[event] : undefined;
  if (!mapper) {
    // Ack so Sellf does not retry an event we intentionally do not email.
    return jsonResponse({ success: true, ignored: event || "unknown" });
  }

  const schema = event === "purchase.completed" ? purchaseData : event === "refund.issued" ? refundData : commonData;
  const dataResult = schema.safeParse(envelope.data);
  if (!dataResult.success) {
    const fields = [...new Set(dataResult.error.issues.map(issue => ["data", ...issue.path].join(".")))];
    return jsonResponse({ success: false, code: "invalid_event_data", message: "invalid event data", fields }, 422);
  }

  const mapped = mapper(envelope, brand);
  if (mapped && !permits(client, "hook:sellf", brandId, mapped.template)) {
    return jsonResponse({ success: false, message: "forbidden", code: "scope" }, 403);
  }
  const to = (mapped?.to || "").trim();
  if (!mapped) {
    return jsonResponse({ success: false, code: "invalid_event_data", message: "invalid event data", fields: ["data"] }, 422);
  }

  const template = getTemplate(mapped.template);
  if (!template) {
    // Misconfigured mapping — ack to avoid a retry storm, but make it visible.
    console.error(`sellf hook: unknown template "${mapped.template}" for ${event}`);
    return jsonResponse({ success: true, ignored: "unknown-template" });
  }

  const fields = missingRequiredFields(template, mapped.data);
  if (fields.length) {
    return jsonResponse({ success: false, code: "invalid_event_data", message: "invalid event data", fields }, 422);
  }

  const order = obj(envelope.data, "order");
  const payment = obj(envelope.data, "payment");
  const refund = obj(envelope.data, "refund");
  const ref = event === "refund.issued"
    ? str(payment, "paymentIntentId") || str(payment, "sessionId")
    : event === "purchase.completed"
    ? str(order, "paymentIntentId") || str(order, "sessionId")
    : str(order, "sessionId") || str(order, "paymentIntentId") || str(payment, "sessionId") || str(payment, "paymentIntentId");
  const idempotencyKey = event === "refund.issued"
    ? `sellf:${event}:${JSON.stringify([brandId, str(refund, "stripeRefundId")])}`
    : `sellf:${event}:${ref || (await tokenSha256(rawBody)).slice(0, 32)}`;
  const result = await renderAndSend(deps, env, brand, template, mapped.data, {
    to: [to],
    replyTo: brand.to[0],
    subject: mapped.subject,
    clientId: client.id,
    ref: ref || undefined,
    idempotencyKey,
  });

  return jsonResponse(deliveryResponse(result, true), result.status);
}

async function verifySignature(req: Request, rawBody: string, secret: unknown, now: Date): Promise<boolean> {
  if (typeof secret !== "string" || !secret) return false;
  const match = /^t=(\d+),v1=([a-fA-F0-9]{64})$/.exec(req.headers.get("X-Sellf-Signature") ?? "");
  if (!match || Math.abs(now.getTime() / 1000 - Number(match[1])) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(match[2].match(/../g)!, value => parseInt(value, 16));
    return await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${match[1]}.${rawBody}`));
  } catch { return false; }
}
