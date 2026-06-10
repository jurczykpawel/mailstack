import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { escapeHtml, humanizeLabel, summaryTable } from "../layout";

/**
 * Meta keys injected by the handler (request-time context, not user content).
 * They are rendered in the small-print footer and excluded from the fields table.
 */
const META_KEYS = {
  receivedAt: "_receivedAt",
  origin: "_origin",
  ip: "_ip",
} as const;

const RESERVED_CONTENT = new Set<string>([
  "message",
  META_KEYS.receivedAt,
  META_KEYS.origin,
  META_KEYS.ip,
]);

function metaValue(data: TemplateData, key: string): string {
  const v = data[key];
  return v && v.trim() !== "" ? v : "-";
}

/** Contact form: the original layout — fields table, optional message, meta footer. */
export const contactTemplate: TemplateDef = {
  id: "contact",
  publicAllowed: true,

  subject(brand: Brand, data: TemplateData): string {
    const type = (data.type || "").trim();
    const typePart = type ? ` — ${type}` : "";
    return `${brand.subjectPrefix}${typePart} — ${brand.name}`;
  },

  render(_brand: Brand, data: TemplateData): RenderedBody {
    const rows = Object.entries(data)
      .filter(([key, value]) => !RESERVED_CONTENT.has(key) && value.trim() !== "")
      .map(([key, value]) => ({ label: humanizeLabel(key), value }));

    const table = summaryTable(rows);

    const message = (data.message || "").trim();
    const messageHtml = message
      ? `
                <p style="margin:18px 0 6px 0;font-size:13px;color:#666;font-weight:600;">${escapeHtml(
                  humanizeLabel("message"),
                )}</p>
                <div style="padding:14px 16px;background:#f7f7f7;border-radius:8px;font-size:14px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap;">${escapeHtml(
                  message,
                )}</div>`
      : "";

    const metaHtml = `
                <p style="margin:18px 0 0 0;font-size:11px;color:#b0b0b0;line-height:1.6;">
                  Otrzymano: ${escapeHtml(metaValue(data, META_KEYS.receivedAt))}<br>
                  Źródło: ${escapeHtml(metaValue(data, META_KEYS.origin))}<br>
                  IP: ${escapeHtml(metaValue(data, META_KEYS.ip))}
                </p>`;

    const bodyHtml = `${table}${messageHtml}${metaHtml}`;

    const textLines: string[] = [];
    for (const r of rows) textLines.push(`${r.label}: ${r.value}`);
    if (message) {
      textLines.push("");
      textLines.push(`${humanizeLabel("message")}:`);
      textLines.push(message);
    }
    textLines.push("");
    textLines.push(`Otrzymano: ${metaValue(data, META_KEYS.receivedAt)}`);
    textLines.push(`Źródło: ${metaValue(data, META_KEYS.origin)}`);
    textLines.push(`IP: ${metaValue(data, META_KEYS.ip)}`);

    return {
      heading: this.subject(_brand, data),
      bodyHtml,
      bodyText: textLines.join("\n"),
    };
  },
};

export { META_KEYS };
