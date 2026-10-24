import type {
  Brand,
  RenderInput,
  RenderedEmail,
  TemplateData,
  TemplateDef,
} from "../types.ts";
import { renderLayout } from "./layout.ts";
import { contactTemplate, META_KEYS } from "./types/contact.ts";
import { welcomeTemplate } from "./types/welcome.ts";
import { receivedTemplate } from "./types/received.ts";
import { paymentTemplate } from "./types/payment.ts";
import { noticeTemplate } from "./types/notice.ts";
import { licenseTemplate } from "./types/license.ts";

/** Registry of all email types, keyed by id. */
export const TEMPLATES: Record<string, TemplateDef> = {
  contact: contactTemplate,
  welcome: welcomeTemplate,
  received: receivedTemplate,
  payment: paymentTemplate,
  notice: noticeTemplate,
  license: licenseTemplate,
};

export function getTemplate(id: string): TemplateDef | undefined {
  return Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined;
}

/**
 * Backward-compatible single-shot renderer for the contact form. Maps the legacy
 * RenderInput (subject + fields[] + message + meta) onto the contact template and
 * wraps it with the shared layout. New code should use getTemplate + renderLayout.
 */
export function renderEmail(brand: Brand, input: RenderInput): RenderedEmail {
  const data: TemplateData = {};
  for (const f of input.fields) data[f.key] = f.value;
  if (input.message !== undefined) data.message = input.message;
  data[META_KEYS.receivedAt] = input.meta.receivedAt;
  data[META_KEYS.origin] = input.meta.origin;
  data[META_KEYS.ip] = input.meta.ip;

  const body = contactTemplate.render(brand, data);
  // Preserve the legacy behavior where the explicit subject is the heading.
  return renderLayout(brand, {
    heading: input.subject,
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyText,
  });
}

export { renderLayout };
