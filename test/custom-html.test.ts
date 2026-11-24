import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import example from "../config/mailstack.example.json";
import custom from "../config/custom-templates.example.json";
import { parseConfig, type Config } from "../src/core/config/schema";
import { templatePlans } from "../src/templates/config";
import { getTemplate } from "../src/templates/index";
import { prepareEmail } from "../src/templates/prepare";
import { compileHtml, renderHtml, renderHtmlText } from "../src/templates/html";

const html = (source: string, data: Record<string, string> = {}) => renderHtml(compileHtml(source), data);
const brand = example.brands.acme as unknown as Config["brands"][string];
const withTemplate = (definition: Record<string, unknown>) => {
  const value = { ...structuredClone(example), mailTemplates: structuredClone(custom.mailTemplates) } as unknown as Config;
  (value.mailTemplates!.custom as Record<string, unknown>).page = { subject: "Subject {title}", heading: "Heading", ...definition };
  return value;
};

describe("HTML templates", () => {
  it("escapes fields in text and attributes and validates whole URLs", () => {
    expect(html('<p title="{t}">{t}</p><a href="{u}">x</a>', { t: '"><b>', u: "javascript:alert(1)" }))
      .toBe('<p title="&quot;&gt;&lt;b&gt;">&quot;&gt;&lt;b&gt;</p><a href="#">x</a>');
    expect(html('<a href={u}>x</a><img src="{u}" alt="{t|logo}">', { u: "https://a.example/x?a=1&b=2" }))
      .toBe('<a href="https://a.example/x?a=1&amp;b=2">x</a><img src="https://a.example/x?a=1&amp;b=2" alt="logo">');
    expect(html('<p>{lines}</p>', { lines: "a\nb" })).toBe("<p>a<br>b</p>");
  });
  it("percent-encodes fields inside literal URLs and keeps mailto literals", () => {
    expect(html('<a href="https://a.example/?q={q}">x</a><a href="mailto:hi@acme.example">m</a>', { q: '" x' }))
      .toBe('<a href="https://a.example/?q=%22%20x">x</a><a href="mailto:hi@acme.example">m</a>');
  });
  it("serializes from the parsed tree, so unclosed or uppercase markup stays well formed", () => {
    expect(html("<P STYLE='color:red'>a<br>b<TABLE><tr><td>c")).toBe('<p style="color:red">a<br>b</p><table><tbody><tr><td>c</td></tr></tbody></table>');
  });
  it.each([
    "<script>alert(1)</script>", "<iframe src=\"https://a.example\"></iframe>", "<form><input></form>", "<style>p{color:red}</style>",
    "<object></object>", "<base href=\"https://a.example\">", "<meta http-equiv=\"refresh\" content=\"0\">", "<svg><a href=\"https://a.example\">x</a></svg>",
    "<img src=\"https://a.example/a.png\" onerror=\"x\">", "<a href=\"javascript:alert(1)\">x</a>", "<img src=\"data:image/png;base64,AA==\">",
    "<p style=\"background:url(https://a.example/t)\">x</p>", "<p style=\"color:{c}\">x</p>",
    "<p style=\"width:expression(1)\">x</p>", "<!-- {c} -->", "<p class=\"x\">x</p>", "<a href=\"https://a.example/{secret}\">x</a>",
  ])("rejects %s", source => expect(() => compileHtml(source, { secrets: ["secret"] })).toThrow());
  it("rejects URLs with credentials", () => expect(() => compileHtml(`<a href="https://${["user", "pw"].join(":")}@a.example">x</a>`)).toThrow());
  it("generates readable text", () => {
    const plan = compileHtml('<h2>Title</h2>\n  <p>Hello   {name},<br>see <a href="{url}">the page</a>.</p><ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><a href="https://a.example/">https://a.example/</a>');
    expect(renderHtmlText(plan, { name: "Anna", url: "https://a.example/p" })).toBe("Title\n\nHello Anna,\nsee the page (https://a.example/p).\n\n- one\n- two\n\na  b\n\nhttps://a.example/");
  });
  it("renders configured HTML inside the brand layout with a generated or configured text", () => {
    const value = parseConfig(withTemplate({ html: '<p>Hi {name}, <a href="{url}">join</a></p>' })), plans = templatePlans(value);
    const email = prepareEmail(brand, getTemplate("page", plans, "acme")!, { name: "Anna", url: "https://a.example/j", title: "T" }, { plans });
    expect(email.subject).toBe("Subject T");
    expect(email.html).toContain('<p>Hi Anna, <a href="https://a.example/j">join</a></p>');
    expect(email.html).toContain(brand.name);
    expect(email.text).toContain("Hi Anna, join (https://a.example/j)");
    const configured = templatePlans(parseConfig(withTemplate({ html: "<p>x</p>", text: "Plain {name}" })));
    expect(prepareEmail(brand, getTemplate("page", configured, "acme")!, { name: "Anna" }, { plans: configured }).text).toContain("Plain Anna");
  });
  it("sends a complete document without the brand layout only from configuration", () => {
    const plans = templatePlans(parseConfig(withTemplate({ layout: "none", html: '<!doctype html><html lang="en"><head><title>{title}</title></head><body><p>Only {name}</p></body></html>' })));
    const email = prepareEmail(brand, getTemplate("page", plans, "acme")!, { name: "Anna", title: "T" }, { plans, explicitJsonLd: [{ "@type": "Organization", name: "Acme" }] });
    expect(email.html).toMatch(/^<!doctype html><html lang="en"><head><title>T<\/title><script type="application\/ld\+json">/);
    expect(email.html).toContain("<p>Only Anna</p>");
    expect(email.html).not.toContain("mailstack");
    expect(email.text).toBe("Only Anna");
  });
  it.each<[string, Record<string, unknown>]>([
    ["a disallowed tag", { html: "<script>x</script>" }],
    ["a secret inside a URL", { html: '<a href="https://a.example/{key}">x</a>', secretFields: ["key"] }],
    ["layout none with a fragment tag outside the allow list", { layout: "none", html: "<html><head><style>p{}</style></head></html>" }],
    ["text with Markdown", { markdown: "x", text: "y" }],
  ])("rejects configuration with %s", (_name, definition) => {
    expect(() => parseConfig(withTemplate(definition))).toThrow(/custom\.page/);
  });
});

describe("template commands", () => {
  mkdirSync("priv", { recursive: true });
  const cli = (args: string[]) => spawnSync(process.execPath, ["scripts/mailstack.ts", ...args], { encoding: "utf8" });
  it("prints the generated text of HTML templates and previews a template", () => {
    const dir = mkdtempSync("priv/template-cli-");
    try {
      const file = join(dir, "mailstack.json");
      writeFileSync(file, JSON.stringify(withTemplate({ html: '<p>Hi {name}, <a href="{url}">join</a></p>' })));
      const check = cli(["config", "check", file]);
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain("page (generated text):\nHi {name}, join (https://example.com/{url})");
      const data = join(dir, "data.json");
      writeFileSync(data, JSON.stringify({ name: "Anna", url: "https://a.example/j", title: "T" }));
      const preview = cli(["template", "preview", file, "acme", "page", data]);
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout).toMatch(/^<!doctype html>/);
      expect(preview.stdout).toContain('<a href="https://a.example/j">join</a>');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
