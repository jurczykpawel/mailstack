import { describe, expect, it } from "vitest";
import { getBrand } from "../src/core/config";
import { compileMarkdown, renderMarkdown } from "../src/templates/markdown";

const brand = getBrand("acme")!;
const md = (source: string, data: Record<string, string> = {}) => renderMarkdown(compileMarkdown(source), brand, data);

describe("Markdown templates", () => {
  it("escapes field values and never parses them as Markdown", () => {
    const { html } = md("Hi {name}, **{x}**", { name: "<img src=x onerror=alert(1)>", x: "[click](https://other.example) **b**" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('href="https://other.example"');
    expect(html).toContain("<strong>[click](https://other.example) **b**</strong>");
  });
  it("shows raw HTML written in the Markdown source as text", () => {
    expect(md("a <script>alert(1)</script> b").html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md("<div onclick=\"x\">y</div>").html).not.toContain("<div onclick");
  });
  it("drops links and buttons whose URL is not http(s)", () => {
    const { html, text } = md("[x]({u})\n\n[[button: Go | {u}]]\n\n[y](javascript:alert(1)) [z](data:text/html,1)", { u: "javascript:alert(1)" });
    expect(html).not.toMatch(/javascript:|data:|<a /);
    expect(text).not.toMatch(/javascript:|data:/);
  });
  it("percent-encodes a field inside a literal URL and keeps mailto literals", () => {
    const { html } = md("[t](https://a.example/?q={q}) [m](mailto:shop@acme.example)", { q: '" onmouseover="x' });
    expect(html).toContain('href="https://a.example/?q=%22%20onmouseover%3D%22x"');
    expect(html).toContain('href="mailto:shop@acme.example"');
  });
  it("collapses the space before an empty field, supports fallbacks and keeps line breaks", () => {
    expect(md("Cześć {name}, {city|Warszawa}").text).toBe("Cześć, Warszawa");
    expect(md("{address}", { address: "Line 1\nLine 2" }).html).toContain("Line 1<br>Line 2");
    expect(md("Brand {brand.name}").text).toBe(`Brand ${brand.name}`);
  });
  it("renders section labels, lists, quotes, tables and images as text", () => {
    const { html, text } = md("### Your order\n\n1. one\n2. two\n\n> quoted\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n![logo](https://a.example/x.png)");
    expect(html).toMatch(/text-transform:uppercase;[^"]*">Your order</);
    expect(text).toContain("YOUR ORDER");
    expect(html).toContain("<ol");
    expect(text).toContain("1. one\n2. two");
    expect(html).toContain('align="right"');
    expect(html).not.toContain("<img");
    expect(text).toContain("logo");
  });
  it("renders components and omits empty ones", () => {
    const source = "[[fields: productName=Product, tier=Plan]]\n[[code: Key | {licenseKey}]]\n[[button: Activate | {url}]]\n[[note: **Note** {extra}]]\n[[button: None | {missing}]]\n[[code: {missing}]]";
    const { html, text } = md(source, { productName: "Pro", licenseKey: "KEY-1", url: "https://a.example/a", extra: "x" });
    expect(html).toContain("Product");
    expect(html).not.toContain("Plan");
    expect(html).toContain("KEY-1");
    expect(html.match(/<a href=/g)).toHaveLength(1);
    expect(text).toContain("Activate: https://a.example/a");
    expect(html).toContain("<strong>Note</strong> x");
  });
  it("renders order items and totals from ready values without calculating", () => {
    const items = JSON.stringify([{ qty: "1", name: "Dragon <pendant>", amount: "€49.00", description: "Engraving: \"Anna\"" }, { qty: "2", name: "Poster", amount: "€58.00" }]);
    const { html, text } = md("[[items: {items}]]\n[[totals: Shipping={shipping|Free}; **Total**={total}]]", { items, total: "€1.00" });
    expect(html).toContain("1 × Dragon &lt;pendant&gt;");
    expect(html).toContain("€58.00");
    expect(html).toMatch(/font-weight:700;">Total</);
    expect(html).toContain("Free");
    expect(text).toContain("2 x Poster");
    expect(text).toContain("Total: €1.00");
    expect(md("[[items: {items}]]", { items: "" }).html).toBe("");
  });
  it("gives a note the paragraph size and keeps hyphenated identifiers together", () => {
    const { html } = md("[[note: Order {order}]]\n\nOrder **{order}**", { order: "DR-1042" });
    expect(html).toMatch(/border-left:4px solid[^"]*font-size:14px;[^"]*line-height:1\.6/);
    expect(html.match(/<span style="white-space:nowrap;">DR-1042<\/span>/g)).toHaveLength(2);
  });
  it.each(["[[unknown: x]]", "[[button: Only label]]", "[[items: not a field]]"])("rejects component %s", source => {
    expect(() => compileMarkdown(source)).toThrow();
  });
  it("reports fields and fields inside literal URLs", () => {
    const plan = compileMarkdown("{a} [x](https://a.example/?k={b}) [y]({c}) [[button: z | https://a.example/{d}]]");
    expect(plan.fields).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));
    expect(plan.partialUrlFields.sort()).toEqual(["b", "d"]);
  });
});
