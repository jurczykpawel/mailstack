import { describe, expect, it } from "vitest";
import { BRANDS } from "../src/brands.example";
import { noticeTemplate } from "../src/templates/types/notice";
import { renderLayout } from "../src/templates/layout";

const brand = BRANDS.acme;
const render = (paragraphs: string) => noticeTemplate.render(brand, { paragraphs });

describe("notice formatting", () => {
  it.each(["  First & <plain>.\nnext line\n\n\n Second paragraph.  ", "", " \n\n ", "First\r\n\r\nSecond"])("preserves legacy output byte-for-byte: %j", (paragraphs) => {
    const body = noticeTemplate.render(brand, {
      heading: "Maintenance", paragraphs, ctaUrl: "https://example.com/status", ctaLabel: "Status",
    });
    expect({ body, email: renderLayout(brand, body) }).toMatchSnapshot();
  });
});

describe("notice structured blocks", () => {
  it("renders section headings in the brand accent and readable text", () => {
    const body = render("## License\n\nDetails");
    expect(body.bodyHtml).toMatch(/<h2 style="[^"]*">License<\/h2>/);
    expect(body.bodyHtml).toContain(`color:${brand.theme.accent}`);
    expect(body.bodyText).toBe("License\n-------\n\nDetails");
    expect(body.previewText).toBe("License");
  });
  it("keeps fenced content, including blank lines and whitespace, in one box", () => {
    const body = render("Before\n\n```\n  key\n\nprompt **literal**\n```\n\nAfter");
    expect(body.bodyHtml.match(/<pre /g)).toHaveLength(1);
    expect(body.bodyHtml).toContain("  key\n\nprompt **literal**");
    expect(body.bodyHtml).toContain("white-space:pre-wrap");
    expect(body.bodyHtml).toContain("word-break:break-all");
    expect(body.bodyHtml).toContain("user-select:text");
    expect(body.bodyText).toBe("Before\n\n  key\n\nprompt **literal**\n\nAfter");
  });
  it("renders bold and strips the markers in text", () => {
    const body = render("A **bold** word\nand **another**.");
    expect(body.bodyHtml).toContain("A <strong>bold</strong> word<br>and <strong>another</strong>.");
    expect(body.bodyText).toBe("A bold word\nand another.");
  });
  it("renders list runs even inside mixed blocks", () => {
    const body = render("Steps:\n- One\n- **Two**\nDone.");
    expect(body.bodyHtml.match(/<li /g)).toHaveLength(2);
    expect(body.bodyHtml).toContain(">One</li>");
    expect(body.bodyHtml).toContain("><strong>Two</strong></li>");
    expect(body.bodyText).toBe("Steps:\n- One\n- Two\nDone.");
  });
  it.each(["## <script>alert(1)</script>", "```\n<script>alert(1)</script>\n```", "**<script>alert(1)</script>**", "- <script>alert(1)</script>"])("escapes text in %s", (input) => {
    const body = render(input);
    expect(body.bodyHtml).not.toContain("<script>");
    expect(body.bodyHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("leaves unmatched markers as plain text", () => {
    expect(render("```\nunfinished").bodyHtml).toContain("```<br>unfinished");
    expect(render("An **unfinished phrase").bodyText).toBe("An **unfinished phrase");
  });
});
