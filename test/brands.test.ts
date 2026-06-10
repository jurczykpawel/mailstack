import { describe, it, expect } from "vitest";
import { getBrand, findBrandByOrigin } from "../src/registry";

describe("getBrand", () => {
  it("returns a defined brand by id", () => {
    expect(getBrand("acme")?.name).toBe("Acme Inc.");
    expect(getBrand("demo")?.name).toBe("Demo Brand");
  });

  it("returns undefined for an unknown id", () => {
    expect(getBrand("nope")).toBeUndefined();
    expect(getBrand("")).toBeUndefined();
  });

  it("keeps a fixed recipient list", () => {
    expect(getBrand("acme")?.to).toEqual(["inbox@acme.example"]);
  });
});

describe("findBrandByOrigin", () => {
  it("matches an allowed production origin", () => {
    expect(findBrandByOrigin("https://acme.example")?.id).toBe("acme");
    expect(findBrandByOrigin("https://demo.example")?.id).toBe("demo");
  });

  it("matches an allowed localhost origin", () => {
    expect(findBrandByOrigin("http://localhost:4322")?.id).toBe("acme");
  });

  it("returns undefined for a disallowed origin", () => {
    expect(findBrandByOrigin("https://evil.example")).toBeUndefined();
  });

  it("returns undefined for an empty origin", () => {
    expect(findBrandByOrigin("")).toBeUndefined();
  });
});
