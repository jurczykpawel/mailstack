import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types.ts";
import { selfwareContact, selfwareContactSubject } from "./selfware.ts";
import { humanizeLabel, summaryTable, messageBlock, metadataBlock } from "../layout.ts";

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
  subjectRoles: ["email"],
  publicAllowed: true,

  subject(brand: Brand, data: TemplateData): string {
    if (brand.id === "selfware") return selfwareContactSubject(brand, data);
    const type = (data.type || "").trim();
    const typePart = type ? ` — ${type}` : "";
    return `${brand.subjectPrefix}${typePart} — ${brand.name}`;
  },

  render(_brand: Brand, data: TemplateData): RenderedBody {
    if (_brand.id === "selfware") return selfwareContact(_brand, data);
    const rows = Object.entries(data)
      .filter(([key, value]) => !RESERVED_CONTENT.has(key) && value.trim() !== "")
      .map(([key, value]) => ({ label: humanizeLabel(key), value }));

    const table = summaryTable(rows);

    const message = (data.message || "").trim();
    const messageHtml = message ? messageBlock(message, humanizeLabel("message")) : "";
    const metaHtml = metadataBlock([
      { label: "Otrzymano", value: metaValue(data, META_KEYS.receivedAt) },
      { label: "Źródło", value: metaValue(data, META_KEYS.origin) },
      { label: "IP", value: metaValue(data, META_KEYS.ip) },
    ]);

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
