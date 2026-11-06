import { expect, it, vi } from "vitest";
import { Output, WorkBudget, measureJson, utf8Size } from "../src/templates/output.ts";
import { renderConfigured, expandText } from "../src/templates/blocks.ts";
import { parseConfig } from "../src/core/config/schema.ts";
import { templatePlans, definition } from "../src/templates/config.ts";
import { readFileSync } from "node:fs";
import example from "../config/mailstack.example.json";
import { paragraph, codeBox, ctaButton, summaryTable } from "../src/templates/layout.ts";
const config = (body: object, fields = {}) => parseConfig({ ...example, mailTemplates: { version: 1, templates: { contact: { body, fields } } } });
const paragraphBody = { blocks: [{ id: "p", kind: "paragraph", text: "{message}" }] };
const body = (b: object, data: Record<string,string>, heading: string | string[] = "Heading") => {
  const c = config(b), p = templatePlans(c);
  return renderConfigured(c.brands.acme, definition(p, "acme", "contact"), p, data, { subject: "Subject", heading });
};
it("preserves the complete recorded contact output with generic blocks", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/templates/legacy.json", "utf8")).find((f: any) => f.id === "acme/contact/complete");
  const c = config({ htmlJoin: "", blocks: [{ id: "table", kind: "fieldTable", allFields: true, exclude: ["message"] },
    { id: "message", kind: "message", field: "message" }, { id: "meta", kind: "metadata", items: ["receivedAt", "origin", "ip"] }] });
  const p = templatePlans(c), result = renderConfigured(fixture.brand, definition(p,"acme","contact"),p,fixture.data,{ subject:fixture.expected.subject,heading:fixture.expected.body.heading });
  expect(result.html).toBe(fixture.expected.html); expect(result.text).toBe(fixture.expected.text);
});
it("renders all six blocks with their documented normalization", () => {
  const result = body({ blocks: [
    { id:"p",kind:"paragraph",text:["Hi ",{field:"name",prefix:"(",suffix:")",empty:"friend"},"\n{name}"] },
    { id:"table",kind:"fieldTable",rows:[{field:"phone",label:"Phone"}],textStyle:"stacked" },
    { id:"msg",kind:"message",field:"message",label:"Message" },
    { id:"meta",kind:"metadata",items:["origin"] },
    { id:"code",kind:"code",field:"phone",label:"Code" },
    { id:"cta",kind:"cta",url:{literal:"https://example.com/path?x=1&y=2"},label:"Read" },
  ] },{name:" Jane ",phone:"  123\n ",message:" <hello> "});
  expect(result.html).toContain(paragraph("Hi (Jane)\nJane"));
  expect(result.html).toContain(codeBox("  123\n "));
  expect(result.html).toContain(ctaButton(example.brands.acme,"https://example.com/path?x=1&y=2","Read"));
  expect(result.html).toContain(summaryTable([{label:"Phone",value:"  123\n "}]));
  expect(result.text).toContain("Phone\n  123\n "); expect(result.text).toContain("Message:\n<hello>");
  expect(result.text).toContain("Źródło: -");
});
it("omits empty blocks and preserves inserted braces as data", () => {
  const result=body({blocks:[{id:"a",kind:"paragraph",text:"{name}"},{id:"b",kind:"code",field:"message"},{id:"c",kind:"paragraph",text:"{phone}"}]},{name:" ",message:" ",phone:"{name}"});
  expect(result.text).toContain("{name}");expect(result.html).toContain(paragraph("{name}"));
});
it.each([-1,0,1])("checks UTF-8, JSON and work boundaries %+i", offset => {
  expect(utf8Size("é😀\ud800")).toBe(new TextEncoder().encode("é😀\ud800").length);
  const json={value:'"\\\n\t\u0000é😀\ud800'};const expected=new TextEncoder().encode(JSON.stringify(json)).length;
  if(offset<0) expect(()=>measureJson(json,expected+offset)).toThrow("template_output_limit");
  else expect(measureJson(json,expected+offset)).toBe(expected);
  const budget=new WorkBudget(100);if(offset>0)expect(()=>budget.spend(100+offset)).toThrow("template_output_limit");else expect(()=>budget.spend(100+offset)).not.toThrow();
});
it("refuses repeated expanded values before a writing pass", () => {
  const text="{message}".repeat(128), c=config({blocks:[{id:"p",kind:"paragraph",text}]}),p=templatePlans(c);
  const spy=vi.spyOn(Output.prototype,"result");
  expect(()=>renderConfigured(c.brands.acme,definition(p,"acme","contact"),p,{message:'"'.repeat(5000)},{subject:"Subject",heading:"Heading"})).toThrow("template_output_limit");
  expect(spy.mock.results.filter(r=>typeof r.value==="string"&&r.value.length>0)).toHaveLength(0);spy.mockRestore();
});
it.each([-1,0,1])("checks heading and subject boundaries before rendering %+i", offset => {
  if(offset>0) expect(()=>body(paragraphBody,{message:"ok"},"x".repeat(5000+offset))).toThrow("template_output_limit");
  else expect(body(paragraphBody,{message:"ok"},"x".repeat(5000+offset)).html).toContain("x".repeat(5000+offset));
  const c=config(paragraphBody),p=templatePlans(c),call=()=>renderConfigured(c.brands.acme,definition(p,"acme","contact"),p,{}, {subject:"é".repeat(498)+"x".repeat(2+offset),heading:"Heading"});
  if(offset>0)expect(call).toThrow("template_output_limit");else expect(call).not.toThrow();
});
it.each(["html", "text"] as const)("measures the complete %s output at each byte boundary", channel => {
  const limit = channel === "html" ? 512 * 1024 : 256 * 1024;
  const data = { message: (channel === "html" ? "<" : "a").repeat(channel === "html" ? 1013 : 2040) };
  const text = "{message}".repeat(128);
  const build = (extra: number) => body({ blocks: [{ id: "p", kind: "paragraph", text: text + "a".repeat(extra) }] }, data);
  const gap = limit - utf8Size(build(0)[channel]);
  expect(gap).toBeGreaterThan(0);
  expect(gap + text.length).toBeLessThanOrEqual(5000);
  for (const offset of [-1, 0, 1]) {
    if (offset > 0) expect(() => build(gap + offset)).toThrow("template_output_limit");
    else expect(utf8Size(build(gap + offset)[channel])).toBe(limit + offset);
  }
});
it("matches UTF-8 across text pieces and preserves empty layout bodies", () => {
  const out = new Output(4);
  out.raw(["\ud83d", "\ude00"]);
  expect(out.bytes).toBe(4);
  expect(utf8Size(out.result())).toBe(4);
  expect(body({ blocks: [] }, {}).text).toContain("Heading\n=======\n\n\n\n----------------------------------------");
});
it("uses one-pass tokens for inserted data and literal fragments", () => {
  const c = config(paragraphBody), p = templatePlans(c);
  expect(expandText(["{name}", { field: "phone", empty: "empty", prefix: "(", suffix: ")" }], c.brands.acme,
    { name: " {phone} ", phone: " " }, p)).toEqual(["{phone}", "empty"]);
});
it("preserves legal source substitution and strict config braces across deterministic inputs", async () => {
  const { tokenize } = await import("../src/templates/tokens.ts");
  const { sourceField } = await import("../src/source-fields.ts");
  const { sourceSchema } = await import("../src/core/config/sources.ts");
  let seed = 7391;
  const values = ["{x}", "{{x}}", "}", "{", "é😀", "\ud800", "data.x", "", " ", "constructor", "a"];
  for (let i = 0; i < 1000; i++) {
    const text = Array.from({ length: 8 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; }).join("");
    const expected = text.replace(/\{([^{}]+)\}/g, (_, key: string) => key === "x" ? "{data.x}" : "");
    expect(sourceField({ x: "{data.x}" }, { format: text })).toBe(expected);
    expect(tokenize(text).map(part => typeof part === "string" ? part : `{${part.field}}`).join("")).toBe(text);
    const legal = !/[{}]/.test(text.replace(/\{[^{}]+\}/g, "")) && [...text.matchAll(/\{([^{}]+)\}/g)].every(m => m[1].split(".").every(key => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && !["constructor", "prototype", "__proto__"].includes(key)));
    const action = { signature: { scheme: "bearer-only" }, envelope: { event: "event", timestamp: "timestamp", data: "data" },
      events: { created: { action: "send", template: "notice", to: "data.email", fields: { paragraphs: { format: text } } } } };
    expect(sourceSchema.safeParse(action).success).toBe(legal);
  }
});
