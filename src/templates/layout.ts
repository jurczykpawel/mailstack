import type { Brand, LayoutInput, RenderedEmail } from "../types.ts";
import { Output, esc, length, type Content, type Emit } from "./output.ts";
import { isHttpUrl } from "../urls.ts";

const MAILSTACK_HOME_URL = "https://mailstack.techskills.academy/pl";

/** Escape the five HTML-significant characters. Applied to every untrusted value. */
export function escapeHtml(s: string): string {
  const output = new Output(); output.escaped(s); return output.result();
}

/** Known content keys mapped to Polish labels (matched case-insensitively). */
const LABELS: Record<string, string> = {
  email: "E-mail",
  name: "Imię i nazwisko",
  "imię i nazwisko": "Imię i nazwisko",
  phone: "Telefon",
  type: "Rodzaj konsultacji",
  topic: "Temat",
  person: "Specjalista",
  message: "Wiadomość",
  gdpr: "Zgoda RODO",
};

/** Turn a raw content key into a human label: known map, else Title Case. */
export function humanizeLabel(key: string): string {
  const mapped = Object.hasOwn(LABELS, key.toLowerCase()) ? LABELS[key.toLowerCase()] : undefined;
  if (mapped) return mapped;
  return key
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Convert plain text to safe HTML: escape, then turn newlines into <br>. */
export function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

/** A paragraph block of escaped text (preserves newlines as <br>). */
export function paragraph(text: Content): string {
  const output = new Output(); emitParagraph(text, output); return output.result();
}
export function emitParagraph(text: Content, output: Output, content: Emit = esc(text, true)): void {
  output.html`<p style="margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;">${content}</p>`;
}

export function codeBox(value: Content, sink?: Output): string {
  const output = sink ?? new Output();
  output.html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;"><tr><td style="background:#f6f7f9;border:1px solid #e0e3e8;border-radius:8px;padding:16px;"><pre style="margin:0;font-family:Consolas,Monaco,'Courier New',monospace;font-size:13px;color:#1a1a1a;line-height:1.6;word-break:break-all;white-space:pre-wrap;user-select:text;">${esc(value)}</pre></td></tr></table>`;
  return sink ? "" : output.result();
}

/** Email-safe, table-based CTA button using the brand accent. Returns "" if no url. */
export function ctaButton(brand: Brand, url: string, label: string, sink?: Output): string {
  const output = sink ?? new Output();
  const href = url.trim();
  if (!isHttpUrl(href)) return "";
  const accent = esc(brand.theme.accent);
  const safeUrl = esc(href);
  const safeLabel = esc(label.trim() || "Otwórz");
  output.html`
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;max-width:100%;table-layout:fixed;">
              <tr>
                <td style="border-radius:8px;background:${accent};">
                  <a href="${safeUrl}" style="display:inline-block;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;word-break:break-word;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${safeLabel}</a>
                </td>
              </tr>
            </table>`;
  return sink ? "" : output.result();
}

/** Plain-text rendering of a CTA (label + URL). Returns "" if no url. */
export function ctaText(url: string, label: string): string {
  const href = url.trim();
  if (!isHttpUrl(href)) return "";
  const l = label.trim() || "Otwórz";
  return `${l}: ${href}`;
}

/**
 * Render a summary table of label/value rows (skips empty values). Used by the
 * contact and payment templates. Values are HTML-escaped; newlines become <br>.
 */
export function summaryTable(rows: Array<{ label: string; value: string }>, sink?: Output): string {
  const output = sink ?? new Output();
  const visible = rows.filter(r => r.value.trim() !== "");
  if (!visible.length) return "";
  output.html`
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eaeaea;border-radius:8px;overflow:hidden;table-layout:fixed;">${out => {
    for (const r of visible) out.html`
              <tr>
                <td style="padding:10px 16px;border-bottom:1px solid #eaeaea;font-size:13px;color:#666;font-weight:600;vertical-align:top;width:38%;overflow-wrap:anywhere;word-break:break-word;">${esc(r.label)}</td>
                <td style="padding:10px 16px;border-bottom:1px solid #eaeaea;font-size:14px;color:#1a1a1a;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;">${esc(r.value, true)}</td>
              </tr>`;
  }}
            </table>`;
  return sink ? "" : output.result();
}

/**
 * Wrap a template's content with the shared brand chrome (header band w/ logo or
 * name, heading, body, footer with address/phone/site). This is the ONLY place
 * that owns the email chrome, so every template type stays on-brand.
 */
export function messageBlock(value: string, label: string, sink?: Output): string {
  const output = sink ?? new Output();
  output.html`
                <p style="margin:18px 0 6px 0;font-size:13px;color:#666;font-weight:600;">${esc(label)}</p>
                <div style="padding:14px 16px;background:#f7f7f7;border-radius:8px;font-size:14px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap;">${esc(value)}</div>`;
  return sink ? "" : output.result();
}
export function metadataBlock(items: { label: Content; value: string }[], sink?: Output, text = false): string {
  const output = sink ?? new Output();
  if (text) items.forEach((item, i) => { if (i) output.raw("\n"); output.raw(item.label); output.raw([": ", item.value]); });
  else output.html`
                <p style="margin:18px 0 0 0;font-size:11px;color:#b0b0b0;line-height:1.6;">${out => items.forEach((item, i) => {
    out.raw(i ? "<br>\n                  " : "\n                  ");
    out.escaped(item.label); out.raw(": "); out.escaped(item.value);
  })}
                </p>`;
  return sink ? "" : output.result();
}

type LayoutParts = { locale?: string | null; layoutCopy?: { sentBy: string; phoneLabel: string } } & Omit<LayoutInput, "heading" | "previewText" | "bodyHtml" | "bodyText"> & { heading: Content; previewText?: Content; bodyHtml: Content | Emit; bodyText: Content | Emit };
export function renderLayout(brand: Brand, input: LayoutParts, sinks?: { html: Output; text: Output }): RenderedEmail {
  const output = sinks?.html ?? new Output();
  const { theme } = brand;
  const accent = esc(theme.accent);
  const safeName = esc(brand.name);
  const heading = esc(input.heading);

  const header = (out: Output) => theme.logoUrl
    ? out.html`<img src="${esc(theme.logoUrl)}" alt="${safeName}" height="36" style="height:36px;max-width:100%;object-fit:contain;display:block;border:0;">`
    : out.html`<span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.2px;">${safeName}</span>`;

  const preview = (out: Output) => input.previewText && length(input.previewText)
    ? out.html`<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(
        input.previewText,
      )}</span>`
    : undefined;

  const footerLines: ((out: Output) => void)[] = [out => safeName(out)];
  if (theme.address) footerLines.push(esc(theme.address));
  if (theme.phone) footerLines.push(out => out.html`${esc(input.layoutCopy?.phoneLabel ?? "tel:")} ${esc(theme.phone!)}`);
  if (isHttpUrl(theme.siteUrl)) footerLines.push(out => out.html`<a href="${esc(theme.siteUrl)}" style="color:${accent};text-decoration:none;">${esc(
      theme.siteUrl.replace(/^https?:\/\//, ""),
    )}</a>`,
  );

  output.html`<!doctype html>
<html lang="${esc(input.locale ?? "pl")}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${heading}</title>
    ${input.headHtml ?? ""}
  </head>
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:${FONT_STACK};overflow-wrap:anywhere;word-break:break-word;">
    ${preview}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 0;table-layout:fixed;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;table-layout:fixed;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:${accent};padding:20px 24px;">${header}</td>
            </tr>
            <tr>
              <td style="padding:24px 24px 4px 24px;">
                <h1 style="margin:0;font-size:18px;line-height:1.4;color:#1a1a1a;font-weight:700;">${heading}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 0 24px;">
                ${input.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <hr style="border:none;border-top:1px solid #eaeaea;margin:0 0 14px 0;">
                <p style="margin:0;font-size:12px;color:#888;line-height:1.6;">${out => footerLines.forEach((line, i) => { if (i) out.raw(" &middot; "); line(out); })}</p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:11px;color:#b0b0b0;">${esc(input.layoutCopy?.sentBy ?? "Wysłano przez")} <a href="${esc(MAILSTACK_HOME_URL)}" style="color:#b0b0b0;text-decoration:none;">mailstack</a></p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = renderLayoutText(brand, input, sinks?.text);
  return { html: output.result(), text };
}

/** Plain-text counterpart of the layout: heading, body, brand footer. */
function renderLayoutText(brand: Brand, input: LayoutParts, output = new Output()): string {
  output.raw(input.heading);
  output.raw(["\n", "=".repeat(Math.min(length(input.heading), 60)), "\n\n"]);
  const body = new Output(output.limit - output.bytes, output.writing, true, output.encodings);
  if (typeof input.bodyText === "function") input.bodyText(body); else body.raw(input.bodyText);
  body.trimEnd();
  if (output.writing) output.raw(body.result()); else output.addBytes(body.bytes);
  output.raw(["\n\n", "-".repeat(40), "\n", brand.name]);
  if (brand.theme.address) output.raw(["\n", brand.theme.address]);
  if (brand.theme.phone) output.raw(["\n", input.layoutCopy?.phoneLabel ?? "tel:", " ", brand.theme.phone]);
  if (isHttpUrl(brand.theme.siteUrl)) output.raw(["\n", brand.theme.siteUrl]);
  output.raw(["\n\n", input.layoutCopy?.sentBy ?? "Wysłano przez", " mailstack (", MAILSTACK_HOME_URL, ")"]);
  return output.result();
}
