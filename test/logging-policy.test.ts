import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseConfig } from "../src/core/config/schema";
import { canonicalJson } from "../src/core/crypto";
import { resolvePolicy } from "../src/core/logging/policy";
import { projectArchive } from "../src/core/logging/projection";
import { getTemplate } from "../src/templates";
import example from "../config/mailstack.example.json";

const patterns = [
  { name: "jwt", regex: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}" },
  { name: "legacy-key", regex: "\\bSF-[^\\s<\"']{8,}" },
  { name: "params", urlParams: ["token", "key", "code", "sig", "signature", "otp"] },
];
const config = () => parseConfig({ ...structuredClone(example), logging: { ...structuredClone(example.logging), patterns } });
function content(archive: ReturnType<typeof projectArchive>) {
  if (!archive || archive.level === "meta") throw new Error("Expected content projection");
  return archive;
}
const brand = example.brands.acme;
const jwt = "eyJabcdefghijk.abcdefghijk.abcdefghijk";
const legacy = "SF-example-license-value";
const url = "https://example.com/activate?token=token-value&key=key-value&code=code-value&sig=sig-value&signature=signature-value&otp=otp-value&view=order";
const secrets = [jwt, legacy, "token-value", "key-value", "code-value", "sig-value", "signature-value", "otp-value", "LICENSE-12345678", "activation-private-path"];
const data = { name: "Jane", productName: `${jwt} ${legacy} ${url}`, tier: "Pro", domain: "example.com", licenseKey: "LICENSE-12345678", activationUrl: "https://example.com/activation-private-path", instructions: `${jwt} ${legacy} ${url}` };

it("resolves all inheritance layers and hashes canonical content", async () => {
  const value = config();
  value.logging.brands.acme = { defaults: { level: "masked", show: ["name"], contentDays: 20 }, templates: { license: { requireLog: true, show: ["productName"] } } };
  const result = await resolvePolicy(value.logging, "acme", "license");
  expect(result.policy).toEqual({ ...value.logging.defaults, level: "masked", contentDays: 20, requireLog: true, show: ["productName"] });
  expect(result.policy_hash).toBe(createHash("sha256").update(canonicalJson(result.policy)).digest("hex").slice(0, 16));
  expect(await resolvePolicy(value.logging, "demo", "notice")).toMatchObject({ policy: value.logging.defaults });
  const reordered = { ...value.logging, defaults: Object.fromEntries(Object.entries(value.logging.defaults).reverse()) as typeof value.logging.defaults };
  expect((await resolvePolicy(reordered, "acme", "license")).policy_hash).toBe(result.policy_hash);
  value.logging.brands.acme.templates!.license.requireLog = false;
  expect((await resolvePolicy(value.logging, "acme", "license")).policy_hash).not.toBe(result.policy_hash);
  result.policy.show.push("changed");
  expect(value.logging.brands.acme.templates!.license.show).toEqual(["productName"]);
});

describe("archive projection", () => {
  it("projects masked and full content", () => {
    const policy = { ...config().logging.defaults, level: "masked" as const, show: Object.keys(data) };
    for (const level of [policy.level, "full"] as const) {
      const template = getTemplate("license")!;
      const original = structuredClone(data);
      const archive = content(projectArchive({ policy: { ...policy, level }, patterns, brand, template, data }));
      expect(archive.level).toBe(level);
      for (const secret of secrets) expect(JSON.stringify(archive)).not.toContain(secret);
      expect(archive).toMatchObject({ subject: expect.any(String), html: expect.any(String), text: expect.stringContaining("••••5678") });
      expect(data).toEqual(original);
      expect(template.render(brand, data).bodyText).toContain(data.licenseKey);
      expect(JSON.stringify(archive)).not.toContain("application/ld+json");
    }
  });
  it("keeps only allowed fields and labelled partial values", () => {
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["name"] }, patterns, brand, template: getTemplate("license")!, data }));
    expect(archive.text).toContain("Jane");
    expect(archive.text).toContain("[ukryte]");
    expect(archive.text).not.toContain("example.com\n");
    expect(archive.subject).toBe("Twój klucz licencji: [ukryte]");
  });
  it("applies patterns to a supplied subject and removes template markup", () => {
    const template = getTemplate("payment")!;
    const input = { invoiceUrl: url, orderId: jwt, name: legacy };
    expect(template.render(brand, input).jsonLd?.length).toBe(1);
    for (const level of ["masked", "full"] as const) {
      const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, show: Object.keys(input) }, patterns, brand, template, data: input, subject: `${jwt} ${legacy} ${url}` }));
      for (const secret of secrets) expect(JSON.stringify(archive)).not.toContain(secret);
      expect(archive.html).not.toContain("application/ld+json");
      expect(archive.text).toContain("view=order");
    }
  });
  it("allows complete values only for full includeSecrets", () => {
    for (const level of ["masked", "full"] as const) {
      const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, includeSecrets: true, show: Object.keys(data) }, patterns, brand, template: getTemplate("license")!, data }));
      expect(archive.text.includes(data.licenseKey)).toBe(level === "full");
      expect(archive.text.includes(jwt)).toBe(level === "full");
    }
  });
  it("returns no archive for none and only metadata for meta", () => {
    const input = { patterns, brand, template: getTemplate("license")!, data, metadata: { clientId: "example-client", status: "sending", createdAt: "2026-10-24T12:00:00Z" } };
    expect(projectArchive({ ...input, policy: { ...config().logging.defaults, level: "none" } })).toBeNull();
    expect(projectArchive({ ...input, policy: config().logging.defaults })).toEqual({ level: "meta", metadata: { brand: "acme", template: "license", ...input.metadata } });
  });
});

it("preserves escaped partial values in rendered HTML", () => {
  const input = { ...data, licenseKey: 'example-value-<>&"' };
  const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "full" }, patterns,
    brand: { ...brand, name: input.licenseKey }, template: getTemplate("license")!, data: input }));
  expect(archive.html).toContain("••••&lt;&gt;&amp;&quot;");
  expect(archive.html).not.toContain('••••<>&"');
});

it("retains full ordinary fields and applies encoded parameter names", () => {
  const template = getTemplate("payment")!;
  const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "full" }, patterns, brand, template,
    data: { name: "Jane", invoiceUrl: "https://example.com/invoice?%74oken=example-value&view=order" } }));
  expect(archive.text).toContain("Jane");
  expect(archive.html).not.toContain("example-value");
  expect(archive.text).not.toContain("example-value");
  expect(archive.html).toContain("view=order");
});
