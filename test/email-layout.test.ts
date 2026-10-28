import { describe, expect, it } from "vitest";
import { escapeHtml, paragraph } from "../src/templates/layout";
import { layoutBrand, layoutCases, longUrl, renderLayoutCase } from "./email-layout-fixture";

describe("email layout content", () => {
  it.each(layoutCases)("retains complete content in $id", (entry) => {
    const { html, text } = renderLayoutCase(entry);
    for (const value of [...entry.values, layoutBrand.theme.address!]) {
      expect(html).toContain(escapeHtml(value));
      expect(text).toContain(value);
    }
    expect(html).not.toContain("<script>END4</script>");
    expect(html).not.toMatch(/text-overflow:ellipsis|overflow-x:hidden/);
    if (entry.data.ctaUrl || entry.data.activationUrl || entry.data.invoiceUrl) {
      expect(html.match(new RegExp(`href="${longUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"))!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("constrains the shared card and wraps ordinary text", () => {
    const { html } = renderLayoutCase(layoutCases[0]);
    expect(html).toMatch(/<table[^>]+style="[^"]*max-width:600px;[^"]*table-layout:fixed/);
    expect(html).toMatch(/<body[^>]+style="[^"]*overflow-wrap:anywhere;[^"]*word-break:break-word/);
    expect(paragraph(longUrl)).toContain("overflow-wrap:anywhere;");
  });
});
