import type {
  Brand,
  RenderInput,
  RenderedEmail,
  TemplateData,
  TemplateDef,
} from "../types";
import { renderLayout } from "./layout";
import { contactTemplate, META_KEYS } from "./types/contact";
import { welcomeTemplate } from "./types/welcome";
import { receivedTemplate } from "./types/received";
import { paymentTemplate } from "./types/payment";
import { noticeTemplate } from "./types/notice";

/** Registry of all email types, keyed by id. */
const TEMPLATES: Record<string, TemplateDef> = {
  contact: contactTemplate,
  welcome: welcomeTemplate,
  received: receivedTemplate,
  payment: paymentTemplate,
  notice: noticeTemplate,
};

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES[id];
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
