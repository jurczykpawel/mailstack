import { Recipe } from "../recipe.ts";
import type { Brand, RenderedBody, TemplateData, TemplateDef } from "../../types.ts";
import { selfwareReceived } from "./selfware.ts";
import { esc, type Emit } from "../output.ts";

/** Acknowledgement that a submission was received. */
export const receivedTemplate: TemplateDef = {
  id: "received",

  subject(_brand: Brand, _data: TemplateData): string {
    if (_brand.id === "selfware") return "Selfware — dostaliśmy Twoje zgłoszenie";
    return "Potwierdzenie: otrzymaliśmy Twoje zgłoszenie";
  },

  render(_brand: Brand, data: TemplateData, recipe = new Recipe()): RenderedBody {
    if (_brand.id === "selfware") return selfwareReceived(data);
    const name = (data.name || "").trim();
    const refId = (data.refId || "").trim();
    const summary = (data.summary || "").trim();

    const heading = "Dziękujemy za wiadomość";
    const greeting = name ? recipe.copy("greetingWithName", `Witaj ${name},`) : recipe.copy("greetingWithoutName", "Witaj,");
    const intro =
      recipe.copy("intro", "Otrzymaliśmy Twoje zgłoszenie i odezwiemy się wkrótce.");

    const htmlParts: (string | Emit)[] = [recipe.paragraph(greeting), recipe.paragraph(intro)];
    if (refId) {
      htmlParts.push(
        out => out.html`<p style="margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.6;">${esc(recipe.copy("refLabel", "Numer zgłoszenia"))}: <strong>${esc(refId)}</strong></p>`,
      );
    }
    if (summary) {
      htmlParts.push(
        out => out.html`<div style="padding:14px 16px;background:#f7f7f7;border-radius:8px;font-size:14px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap;">${esc(summary)}</div>`,
      );
    }

    const textParts: string[] = [greeting, intro];
    if (refId) textParts.push(`${recipe.copy("refLabel", "Numer zgłoszenia")}: ${refId}`);
    if (summary) textParts.push(summary);

    return {
      heading,
      bodyHtml: recipe.html(htmlParts),
      bodyText: recipe.text(textParts),
      previewText: intro,
    };
  },
};
