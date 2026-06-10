import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types";
import { escapeHtml, paragraph } from "../layout";

/** Acknowledgement that a submission was received. */
export const receivedTemplate: TemplateDef = {
  id: "received",

  subject(_brand: Brand, _data: TemplateData): string {
    return "Potwierdzenie: otrzymaliśmy Twoje zgłoszenie";
  },

  render(_brand: Brand, data: TemplateData): RenderedBody {
    const name = (data.name || "").trim();
    const refId = (data.refId || "").trim();
    const summary = (data.summary || "").trim();

    const heading = "Dziękujemy za wiadomość";
    const greeting = name ? `Witaj ${name},` : "Witaj,";
    const intro =
      "Otrzymaliśmy Twoje zgłoszenie i odezwiemy się wkrótce.";

    const htmlParts: string[] = [paragraph(greeting), paragraph(intro)];
    if (refId) {
      htmlParts.push(
        `<p style="margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.6;">Numer zgłoszenia: <strong>${escapeHtml(
          refId,
        )}</strong></p>`,
      );
    }
    if (summary) {
      htmlParts.push(
        `<div style="padding:14px 16px;background:#f7f7f7;border-radius:8px;font-size:14px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap;">${escapeHtml(
          summary,
        )}</div>`,
      );
    }

    const textParts: string[] = [greeting, intro];
    if (refId) textParts.push(`Numer zgłoszenia: ${refId}`);
    if (summary) textParts.push(summary);

    return {
      heading,
      bodyHtml: htmlParts.join("\n"),
      bodyText: textParts.join("\n\n"),
      previewText: intro,
    };
  },
};
