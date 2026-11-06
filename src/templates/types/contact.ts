import { Recipe } from "../recipe.ts";
import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types.ts";


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
    const type = (data.type || "").trim();
    const typePart = type ? ` — ${type}` : "";
    return `${brand.subjectPrefix}${typePart} — ${brand.name}`;
  },

  render(_brand: Brand, data: TemplateData, recipe = new Recipe()): RenderedBody {
    const rows = Object.entries(data)
      .filter(([key, value]) => !RESERVED_CONTENT.has(key) && value.trim() !== "")
      .map(([key, value]) => ({ label: recipe.label(key), value }));

    const table = recipe.table(rows);

    const message = (data.message || "").trim();
    const messageHtml = message ? recipe.message(message, recipe.copy("messageLabel", recipe.label("message"))) : "";
    const metaHtml = recipe.metadata([
      { label: recipe.copy("receivedAtLabel", "Otrzymano"), value: metaValue(data, META_KEYS.receivedAt) },
      { label: recipe.copy("originLabel", "Źródło"), value: metaValue(data, META_KEYS.origin) },
      { label: recipe.copy("ipLabel", "IP"), value: metaValue(data, META_KEYS.ip) },
    ]);

    const bodyHtml = recipe.html([table, messageHtml, metaHtml], "");

    const textLines: string[] = [];
    for (const r of rows) textLines.push(`${r.label}: ${r.value}`);
    if (message) {
      textLines.push("");
      textLines.push(`${recipe.copy("messageLabel", recipe.label("message"))}:`);
      textLines.push(message);
    }
    textLines.push("");
    textLines.push(`${recipe.copy("receivedAtLabel", "Otrzymano")}: ${metaValue(data, META_KEYS.receivedAt)}`);
    textLines.push(`${recipe.copy("originLabel", "Źródło")}: ${metaValue(data, META_KEYS.origin)}`);
    textLines.push(`${recipe.copy("ipLabel", "IP")}: ${metaValue(data, META_KEYS.ip)}`);

    return {
      heading: this.subject(_brand, data, recipe),
      bodyHtml,
      bodyText: recipe.text(textLines, "\n"),
    };
  },
};

export { META_KEYS };
