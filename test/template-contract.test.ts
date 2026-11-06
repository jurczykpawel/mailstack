import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Brand, TemplateData } from "../src/types.ts";
import { getTemplate, renderLayout } from "../src/templates/index.ts";
import { formConfig } from "./fixtures/form-config.ts";
import { templatePlans } from "../src/templates/config.ts";
import { prepareEmail } from "../src/templates/prepare.ts";
import { serializeToHead } from "../src/markup/serialize.ts";

type Contract = { id: string; template: string; brand: Brand; data: TemplateData; expected: unknown };
const fixtures: Contract[] = JSON.parse(readFileSync(new URL("./fixtures/templates/legacy.json", import.meta.url), "utf8"));
describe("template output contract", () => {
  for (const fixture of fixtures) it(fixture.id, () => {
    const template = getTemplate(fixture.template)!;
    if (fixture.brand.id === "selfware") {
      const cfg = formConfig(fixture.brand);
      const render = () => prepareEmail(cfg.brands[fixture.brand.id], template, fixture.data, { plans: templatePlans(cfg) });
      if (fixture.id.endsWith("unicode-5000")) expect(render).toThrow("template_output_limit");
      else { const mail = render(); const expected = fixture.expected as { subject: string; html: string; text: string };
        expect({ subject: mail.subject, html: mail.html, text: mail.text }).toEqual({ subject: expected.subject, html: expected.html, text: expected.text }); }
      return;
    }
    const body = template.render(fixture.brand, fixture.data);
    expect({ subject: template.subject(fixture.brand, fixture.data), body,
      ...renderLayout(fixture.brand, { ...body, headHtml: serializeToHead(body.jsonLd ?? []) }) }).toEqual(fixture.expected);
  });
  it("covers all registered types for both example brands", () => {
    for (const brand of ["acme", "demo"]) for (const template of ["contact", "received", "welcome", "payment", "license", "notice", "refund", "bank-transfer"])
      expect(fixtures.some(f => f.id === `${brand}/${template}/complete`)).toBe(true);
  });
});
