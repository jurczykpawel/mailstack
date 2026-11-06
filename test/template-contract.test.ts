import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Brand, TemplateData } from "../src/types.ts";
import { getTemplate, renderLayout } from "../src/templates/index.ts";
import { serializeToHead } from "../src/markup/serialize.ts";

type Contract = { id: string; template: string; brand: Brand; data: TemplateData; expected: unknown };
const fixtures: Contract[] = JSON.parse(readFileSync(new URL("./fixtures/templates/legacy.json", import.meta.url), "utf8"));
describe("template output contract", () => {
  for (const fixture of fixtures) it(fixture.id, () => {
    const template = getTemplate(fixture.template)!;
    const body = template.render(fixture.brand, fixture.data);
    expect({ subject: template.subject(fixture.brand, fixture.data), body,
      ...renderLayout(fixture.brand, { ...body, headHtml: serializeToHead(body.jsonLd ?? []) }) }).toEqual(fixture.expected);
  });
  it("covers all registered types for both example brands", () => {
    for (const brand of ["acme", "demo"]) for (const template of ["contact", "received", "welcome", "payment", "license", "notice", "refund", "bank-transfer"])
      expect(fixtures.some(f => f.id === `${brand}/${template}/complete`)).toBe(true);
  });
});
