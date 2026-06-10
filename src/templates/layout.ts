import type { Brand, LayoutInput, RenderedEmail } from "../types";

/** Escape the five HTML-significant characters. Applied to every untrusted value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const mapped = LABELS[key.toLowerCase()];
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
export function paragraph(text: string): string {
  return `<p style="margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.6;">${textToHtml(
    text,
  )}</p>`;
}

/** Email-safe, table-based CTA button using the brand accent. Returns "" if no url. */
export function ctaButton(brand: Brand, url: string, label: string): string {
  if (!url.trim()) return "";
  const accent = escapeHtml(brand.theme.accent);
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label.trim() || "Otwórz");
  return `
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">
              <tr>
                <td style="border-radius:8px;background:${accent};">
                  <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${safeLabel}</a>
                </td>
              </tr>
            </table>`;
}

/** Plain-text rendering of a CTA (label + URL). Returns "" if no url. */
export function ctaText(url: string, label: string): string {
  if (!url.trim()) return "";
  const l = label.trim() || "Otwórz";
  return `${l}: ${url}`;
}

/**
 * Render a summary table of label/value rows (skips empty values). Used by the
 * contact and payment templates. Values are HTML-escaped; newlines become <br>.
 */
export function summaryTable(rows: Array<{ label: string; value: string }>): string {
  const body = rows
    .filter((r) => r.value.trim() !== "")
    .map(
      (r) => `
              <tr>
                <td style="padding:10px 16px;border-bottom:1px solid #eaeaea;font-size:13px;color:#666;font-weight:600;vertical-align:top;width:38%;">${escapeHtml(
                  r.label,
                )}</td>
                <td style="padding:10px 16px;border-bottom:1px solid #eaeaea;font-size:14px;color:#1a1a1a;vertical-align:top;">${textToHtml(
                  r.value,
                )}</td>
              </tr>`,
    )
    .join("");
  if (!body) return "";
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eaeaea;border-radius:8px;overflow:hidden;">${body}
            </table>`;
}

/**
 * Wrap a template's content with the shared brand chrome (header band w/ logo or
 * name, heading, body, footer with address/phone/site). This is the ONLY place
 * that owns the email chrome, so every template type stays on-brand.
 */
export function renderLayout(brand: Brand, input: LayoutInput): RenderedEmail {
  const { theme } = brand;
  const accent = escapeHtml(theme.accent);
  const safeName = escapeHtml(brand.name);
  const heading = escapeHtml(input.heading);

  const header = theme.logoUrl
    ? `<img src="${escapeHtml(theme.logoUrl)}" alt="${safeName}" height="36" style="height:36px;display:block;border:0;">`
    : `<span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.2px;">${safeName}</span>`;

  const preview = input.previewText
    ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(
        input.previewText,
      )}</span>`
    : "";

  const footerLines: string[] = [safeName];
  if (theme.address) footerLines.push(escapeHtml(theme.address));
  if (theme.phone) footerLines.push("tel: " + escapeHtml(theme.phone));
  footerLines.push(
    `<a href="${escapeHtml(theme.siteUrl)}" style="color:${accent};text-decoration:none;">${escapeHtml(
      theme.siteUrl.replace(/^https?:\/\//, ""),
    )}</a>`,
  );

  const html = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${heading}</title>
  </head>
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:${FONT_STACK};">
    ${preview}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
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
                <p style="margin:0;font-size:12px;color:#888;line-height:1.6;">${footerLines.join(
                  " &middot; ",
                )}</p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:11px;color:#b0b0b0;">Wysłano przez mailstack</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = renderLayoutText(brand, input);
  return { html, text };
}

/** Plain-text counterpart of the layout: heading, body, brand footer. */
function renderLayoutText(brand: Brand, input: LayoutInput): string {
  const lines: string[] = [];
  lines.push(input.heading);
  lines.push("=".repeat(Math.min(input.heading.length, 60)));
  lines.push("");
  lines.push(input.bodyText.trimEnd());
  lines.push("");
  lines.push("-".repeat(40));
  lines.push(brand.name);
  if (brand.theme.address) lines.push(brand.theme.address);
  if (brand.theme.phone) lines.push(`tel: ${brand.theme.phone}`);
  lines.push(brand.theme.siteUrl);
  return lines.join("\n");
}
