import { describe, it, expect } from "vitest";
import { buildBlocks, serializeToHead, serializeBlock } from "../src/markup";

describe("buildBlocks — typed builders", () => {
  it("viewAction -> EmailMessage.potentialAction ViewAction", () => {
    const [b] = buildBlocks([
      { kind: "viewAction", name: "Zobacz zamówienie", url: "https://x.example/o/1" },
    ]);
    expect(b["@context"]).toBe("https://schema.org");
    expect(b["@type"]).toBe("EmailMessage");
    expect(b.potentialAction).toMatchObject({
      "@type": "ViewAction",
      url: "https://x.example/o/1",
      name: "Zobacz zamówienie",
    });
  });

  it("rejects non-http(s) action URLs (directive dropped)", () => {
    expect(
      buildBlocks([{ kind: "viewAction", name: "x", url: "javascript:alert(1)" }]),
    ).toEqual([]);
    expect(
      buildBlocks([{ kind: "viewAction", name: "x", url: "data:text/html,x" }]),
    ).toEqual([]);
  });

  it("viewAction requires both name and url", () => {
    expect(buildBlocks([{ kind: "viewAction", url: "https://x.example" }])).toEqual([]);
    expect(buildBlocks([{ kind: "viewAction", name: "x" }])).toEqual([]);
  });

  it("confirmAction uses an HttpActionHandler", () => {
    const [b] = buildBlocks([
      { kind: "confirmAction", name: "Approve", url: "https://x.example/a" },
    ]);
    expect(b.potentialAction).toMatchObject({
      "@type": "ConfirmAction",
      name: "Approve",
      handler: { "@type": "HttpActionHandler", url: "https://x.example/a" },
    });
  });

  const fullTrackAction = {
    kind: "trackAction",
    url: "https://x.example/t",
    trackingNumber: "1Z999",
    carrier: "FedEx",
    expectedArrivalUntil: "2026-08-01T12:00:00+02:00",
    orderNumber: "ORD-1",
    merchant: "Acme Inc.",
    deliveryAddress: {
      streetAddress: "1 Example St",
      addressLocality: "Warsaw",
      addressRegion: "Mazowieckie",
      addressCountry: "PL",
      postalCode: "00-001",
    },
    itemShipped: "Widget",
  };

  it("trackAction -> ParcelDelivery with a TrackAction (all Gmail-required fields)", () => {
    const [b] = buildBlocks([fullTrackAction]);
    expect(b["@type"]).toBe("ParcelDelivery");
    expect(b.trackingNumber).toBe("1Z999");
    expect(b.potentialAction).toMatchObject({ "@type": "TrackAction", url: "https://x.example/t" });
    expect(b.carrier).toMatchObject({ "@type": "Organization", name: "FedEx" });
    expect(b.deliveryAddress).toMatchObject({ "@type": "PostalAddress", addressCountry: "PL" });
    expect(b.itemShipped).toMatchObject({ "@type": "Product", name: "Widget" });
    expect(b.partOfOrder).toMatchObject({
      "@type": "Order",
      orderNumber: "ORD-1",
      merchant: { "@type": "Organization", name: "Acme Inc." },
    });
  });

  it("trackAction drops the directive if any Gmail-required field is missing", () => {
    expect(buildBlocks([{ kind: "trackAction", url: "https://x.example/t" }])).toEqual([]);
    const { carrier, ...noCarrier } = fullTrackAction;
    expect(buildBlocks([noCarrier])).toEqual([]);
    const { deliveryAddress, ...noAddress } = fullTrackAction;
    expect(buildBlocks([noAddress])).toEqual([]);
  });

  it("discountOffer requires a discountCode", () => {
    const [b] = buildBlocks([
      {
        kind: "discountOffer",
        discountCode: "SAVE10",
        description: "10%",
        availabilityEnds: "2026-08-01",
      },
    ]);
    expect(b).toMatchObject({
      "@type": "DiscountOffer",
      discountCode: "SAVE10",
      description: "10%",
      availabilityEnds: "2026-08-01",
    });
    expect(buildBlocks([{ kind: "discountOffer" }])).toEqual([]);
  });

  it("promotionCard keeps only http(s) images and needs at least one", () => {
    const [b] = buildBlocks([
      { kind: "promotionCard", images: ["https://x.example/a.png", "notaurl"] },
    ]);
    expect(b["@type"]).toBe("PromotionCard");
    expect(b.image).toEqual(["https://x.example/a.png"]);
    expect(buildBlocks([{ kind: "promotionCard", images: [] }])).toEqual([]);
  });

  it("organization requires a name and an http(s) logo", () => {
    const [b] = buildBlocks([
      { kind: "organization", name: "Acme", logo: "https://x.example/l.png" },
    ]);
    expect(b).toMatchObject({
      "@type": "Organization",
      name: "Acme",
      logo: "https://x.example/l.png",
    });
    expect(
      buildBlocks([{ kind: "organization", name: "Acme", logo: "ftp://x" }]),
    ).toEqual([]);
  });
});

describe("buildBlocks — generic + raw", () => {
  it("schema wraps type + props with the default context", () => {
    const [b] = buildBlocks([
      { kind: "schema", type: "ParcelDelivery", props: { trackingNumber: "1Z" } },
    ]);
    expect(b).toEqual({
      "@context": "https://schema.org",
      "@type": "ParcelDelivery",
      trackingNumber: "1Z",
    });
  });

  it("raw passes an object through and injects @context", () => {
    const [b] = buildBlocks([
      { kind: "raw", value: { "@type": "FlightReservation", reservationId: "AB" } },
    ]);
    expect(b).toMatchObject({
      "@context": "https://schema.org",
      "@type": "FlightReservation",
      reservationId: "AB",
    });
  });

  it("raw respects a caller-provided @context", () => {
    const [b] = buildBlocks([
      { kind: "raw", value: { "@context": "http://schema.org", "@type": "Thing" } },
    ]);
    expect(b["@context"]).toBe("http://schema.org");
  });

  it("raw requires an object with a string @type", () => {
    expect(buildBlocks([{ kind: "raw", value: { foo: 1 } }])).toEqual([]);
    expect(buildBlocks([{ kind: "raw", value: "nope" }])).toEqual([]);
    expect(buildBlocks([{ kind: "raw", value: [1, 2] }])).toEqual([]);
  });
});

describe("buildBlocks — fail-soft + limits", () => {
  it("returns [] for non-directive input", () => {
    expect(buildBlocks(undefined)).toEqual([]);
    expect(buildBlocks("x")).toEqual([]);
    expect(buildBlocks({})).toEqual([]);
  });

  it("accepts a single directive object", () => {
    const blocks = buildBlocks({ kind: "viewAction", name: "n", url: "https://x.example" });
    expect(blocks).toHaveLength(1);
  });

  it("drops invalid directives but keeps valid ones", () => {
    const blocks = buildBlocks([
      { kind: "nope" },
      { kind: "viewAction", name: "ok", url: "https://x.example" },
      "garbage",
      42,
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]["@type"]).toBe("EmailMessage");
  });

  it("caps the number of blocks at 5", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "viewAction",
      name: "n" + i,
      url: "https://x.example/" + i,
    }));
    expect(buildBlocks(many)).toHaveLength(5);
  });
});

describe("serializeToHead", () => {
  it("wraps each block in an ld+json script tag", () => {
    const html = serializeToHead(
      buildBlocks([{ kind: "viewAction", name: "See", url: "https://x.example" }]),
    );
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"EmailMessage"');
  });

  it("neutralizes a </script> breakout embedded in a value", () => {
    const html = serializeToHead(
      buildBlocks([
        {
          kind: "viewAction",
          name: "</script><img src=x onerror=alert(1)>",
          url: "https://x.example",
        },
      ]),
    );
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script>");
  });

  it("escapes the JS line terminators U+2028 / U+2029", () => {
    const block = serializeBlock({ "@type": "Thing", name: "a\u2028b\u2029c" });
    expect(block).toContain("\\u2028");
    expect(block).toContain("\\u2029");
    expect(block).not.toMatch(/[\u2028\u2029]/);
  });

  it("returns '' when there are no blocks", () => {
    expect(serializeToHead([])).toBe("");
  });
});
