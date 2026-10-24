import { describe, expect, it } from "vitest";
import { getBrand } from "../src/core/config";
import { getTemplate } from "../src/templates/index";
import { ctaButton, ctaText, renderLayout } from "../src/templates/layout";
import { buildBlocks, isHttpUrl } from "../src/markup";

const brand = getBrand("acme")!;
const omittedUrls = [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)",
  "java\nscript:alert(1)", "data:text/html,hello", "vbscript:msgbox(1)",
  "//example.com", "/start", "java%73cript:alert(1)", "%68ttps://example.com",
  "mailto:hello@example.com", "tel:+48123456789", " https://example.com",
  "https://example.com\n", "ht\ttps://example.com", "\u0000https://example.com",
  "https://example.com/\u007f", "https://", "",
];
const fields = [
  ["welcome", "ctaUrl"], ["notice", "ctaUrl"], ["payment", "invoiceUrl"],
  ["license", "activationUrl"],
] as const;

describe("template links", () => {
  it.each(omittedUrls)("omits unsupported address %j from both CTA formats", (url) => {
    expect(ctaButton(brand, url, "Open")).toBe("");
    expect(ctaText(url, "Open")).toBe("");
    expect(isHttpUrl(url)).toBe(false);
    for (const [id, field] of fields) {
      const body = getTemplate(id)!.render(brand, { [field]: url });
      expect(body.bodyHtml).not.toContain("<a ");
      if (url) expect(body.bodyText).not.toContain(url);
      expect(body.jsonLd).toBeUndefined();
    }
    expect(getTemplate("payment")!.render(brand, { orderUrl: url }).jsonLd).toBeUndefined();
    const layout = renderLayout({ ...brand, theme: { ...brand.theme, siteUrl: url } }, {
      heading: "Hello", bodyHtml: "Content", bodyText: "Content",
    });
    expect(layout.html.match(/<a /g)).toHaveLength(1);
    if (url) expect(layout.text.split("\n")).not.toContain(url);
    for (const kind of ["viewAction", "confirmAction"]) {
      expect(buildBlocks([{ kind, name: "Open", url }])).toEqual([]);
    }
    for (const field of ["url", "target", "trackingUrl", "urlTemplate"]) {
      const value = { "@type": "EmailMessage", potentialAction: [{ "@type": "ViewAction", [field]: url }] };
      expect(buildBlocks([{ kind: "raw", value }])).toEqual([]);
      expect(buildBlocks([{ kind: "schema", type: "EmailMessage", props: value }])).toEqual([]);
    }
  });

  it.each(["https://example.com/start?a=1&b=2", "http://example.com/start", "HTTPS://example.com/start"])(
    "retains web address %j in both formats", (url) => {
      expect(isHttpUrl(url)).toBe(true);
      expect(ctaButton(brand, url, "Open")).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
      expect(ctaText(url, "Open")).toBe(`Open: ${url}`);
      for (const [id, field] of fields) {
        const body = getTemplate(id)!.render(brand, { [field]: url });
        expect(body.bodyHtml).toContain("<a ");
        expect(body.bodyText).toContain(url);
      }
      expect(buildBlocks([{ kind: "viewAction", name: "Open", url }])).toHaveLength(1);
      expect(buildBlocks([{ kind: "raw", value: { "@type": "ViewAction", target: url } }])).toHaveLength(1);
    },
  );
});
