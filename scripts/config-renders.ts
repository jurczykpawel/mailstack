// Render fingerprints of a configuration for `npm run config:push`: every brand, template and language with sample
// data, plus the public auto-reply exactly as send.ts prepares it (no submitted fields, product of a verified nonce).
import { createHash } from "node:crypto";
import { loadConfig } from "../src/core/config/load.ts";
import { templatePlans } from "../src/templates/config.ts";
import { getTemplate, TEMPLATES } from "../src/templates/index.ts";
import { prepareEmail } from "../src/templates/prepare.ts";
import type { Brand, TemplateData } from "../src/types.ts";

const SAMPLE: TemplateData = { name: "Jane Smith", email: "jane@example.com", message: "Hello\nsecond line", type: "Consultation", topic: "Topic",
  heading: "Heading", paragraphs: "One\n\nTwo", intro: "Intro", body: "Body", ctaUrl: "https://example.com/a", ctaLabel: "Open", summary: "Summary",
  refId: "R-1", amount: "149.00", currency: "PLN", item: "Pro Plan", productName: "Product", orderId: "ORD-1", date: "2026-06-10",
  invoiceUrl: "https://example.com/i.pdf", licenseKey: "KEY-1", activationUrl: "https://example.com/act", _receivedAt: "2026-06-10 10:00" };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function renders(json: string): Record<string, string> {
  const config = loadConfig(json), plans = templatePlans(config), out: Record<string, string> = {};
  for (const [id, brand] of Object.entries(config.brands) as [string, Brand][]) {
    const ids = new Set([...Object.keys(TEMPLATES), ...Object.keys(plans.custom?.[""] ?? {}), ...Object.keys(plans.custom?.[id] ?? {})]);
    for (const templateId of ids) for (const locale of [undefined, ...brand.mailTemplates?.languages?.allowed ?? []]) {
      const key = `${id}/${templateId}/${locale ?? "default"}`, template = getTemplate(templateId, plans, id)!;
      const render = (data: TemplateData, confirmation?: boolean) => {
        try { const e = prepareEmail(brand, template, data, { plans, locale, confirmation }); return digest([e.subject, e.html, e.text]); }
        catch (error) { return `error: ${error instanceof Error ? error.message : error}`; }
      };
      out[key] = render(SAMPLE);
      if (brand.autoReply && templateId === (brand.autoReplyTemplate ?? "received"))
        out[`${key}/auto-reply`] = render({ name: "", summary: brand.requireNonce ? brand.products?.[0] ?? "" : "" }, true);
    }
  }
  return out;
}

/** Render keys added, removed or changed between two configurations. */
export function changedRenders(before: string, after: string): string[] {
  const a = renders(before), b = renders(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]).sort();
}

/** Leaf paths whose value differs (values are never printed). */
export function changedPaths(before: string, after: string): string[] {
  const leaves = (value: unknown, path: string, out: Map<string, string>) => {
    if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
    else out.set(path, JSON.stringify(value));
    return out;
  };
  const a = leaves(JSON.parse(before), "", new Map()), b = leaves(JSON.parse(after), "", new Map());
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}
