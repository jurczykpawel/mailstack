import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseConfig } from "../src/core/config/schema";
import { canonicalJson } from "../src/core/crypto";
import { resolvePolicy } from "../src/core/logging/policy";
import { projectArchive } from "../src/core/logging/projection";
import { getTemplate } from "../src/templates";
import { escapeHtml } from "../src/templates/layout";
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
  it.each(["masked", "full"] as const)("projects supplied payment subjects at level %s", (level) => {
    const input = { name: "PRIVATE-NAME", email: "private-name@example.com", amount: "149.00", currency: "USD", item: "Pro Plan" };
    const subject = `Dla ${input.name} ${input.email}: ${input.item}`;
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, show: ["amount", "currency", "item"] },
      patterns: [], brand, template: getTemplate("payment")!, data: input, subject }));
    expect(archive.subject).toBe(level === "masked" ? "Dla [ukryte] [ukryte]: Pro Plan" : subject);
    for (const value of [archive.subject, archive.html, archive.text]) {
      expect(value.includes(input.name)).toBe(level === "full");
      expect(value).toContain(input.item);
      if (level === "masked") expect(value).not.toContain(input.email);
    }
    expect(archive.text).toContain("149.00 USD");
  });
  it.each([false, true])("projects ordinary values with HTML encoding %s", (encoded) => {
    const name = 'PRIVATE <NAME> & "Co"';
    const email = "private-name@example.com";
    const input = { name, email, item: `Plan for ${name} ${email}` };
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["item"] },
      patterns: [], brand: { ...brand, name: input.item }, template: getTemplate("payment")!, data: input,
      subject: encoded ? escapeHtml(input.item) : input.item }));
    expect(archive.subject).toBe("Plan for [ukryte] [ukryte]");
    expect(archive.html).toContain(escapeHtml(input.item));
    expect(archive.text).toContain(input.item);
  });
  it("projects longer values before their component values", () => {
    const input = { name: "private-name", email: "private-name@example.com", item: "private-name@example.com private-name" };
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["item"] },
      patterns: [], brand, template: getTemplate("payment")!, data: input, subject: input.item }));
    expect(archive.subject).toBe("[ukryte] [ukryte]");
    expect(archive.html).toContain(input.item);
    expect(archive.text).toContain(input.item);
  });
  it("projects email addresses in supplied subjects independently of data fields", () => {
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["item"] },
      patterns: [], brand, template: getTemplate("payment")!, data: { item: "Pro Plan", name: "private-name" },
      subject: "Pro Plan: private-name+orders@example.com, other@example.org" }));
    expect(archive.subject).toBe("Pro Plan: [ukryte], [ukryte]");
  });
  it("keeps short and empty values from changing surrounding content", () => {
    const item = "Plan a PL";
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["item"] },
      patterns: [], brand, template: getTemplate("payment")!, data: { name: "a", country: "PL", empty: "", item }, subject: item }));
    expect(archive.subject).toBe("Plan [ukryte] [ukryte]");
    for (const value of [archive.html, archive.text]) expect(value).toContain(item);
  });
  it.each(["masked", "full"] as const)("preserves payment fields and layout at level %s", (level) => {
    const input = { name: "Pro", item: "Produkt Żółw", domain: "example.com", amount: "100", currency: "PLN" };
    const logoUrl = "https://mail.example.com/brand/logo.png";
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, show: ["item", "amount", "currency"] },
      patterns: [], brand: { ...brand, theme: { ...brand.theme, logoUrl } }, template: getTemplate("payment")!, data: input }));
    expect(archive.html).toContain(`src="${logoUrl}"`);
    for (const value of [archive.html, archive.text]) {
      expect(value).toContain(input.item);
      expect(value).toContain(level === "masked" ? "Witaj [ukryte]," : "Witaj Pro,");
    }
    expect(archive.text).toContain("Pozycja: Produkt Żółw");
  });
  it.each([
    ["Al", "Dla Al", "Dla [ukryte]"],
    ["Al", "Al, Alicja żAl Alż 1Al Al2 (Al) Al", "[ukryte], Alicja żAl Alż 1Al Al2 ([ukryte]) [ukryte]"],
    ["Ł", "Ł, Łódź aŁ Ła 1Ł Ł2", "[ukryte], Łódź aŁ Ła 1Ł Ł2"],
    ["A.", "A. A? BA. A.B", "[ukryte] A? BA. A.B"],
  ])("projects short subject value %s in %s", (name, subject, expected) => {
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level: "masked", show: ["item"] },
      patterns: [], brand, template: getTemplate("payment")!, data: { name, item: "Produkt Żółw" }, subject }));
    expect(archive.subject).toBe(expected);
    expect(archive.text).toContain("Witaj [ukryte],");
  });
  it.each(["masked", "full"] as const)("projects license values inside allowed fields at level %s", (level) => {
    const input = { ...data, productName: "Demo", instructions: `Use ${data.licenseKey} at ${data.activationUrl}` };
    const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, show: Object.keys(input) },
      patterns: [], brand, template: getTemplate("license")!, data: input, subject: input.instructions }));
    for (const value of [archive.subject, archive.html, archive.text]) {
      expect(value).not.toContain(input.licenseKey);
      expect(value).not.toContain(input.activationUrl);
      expect(value).toContain("••••5678");
      expect(value).toContain("••••path");
    }
  });
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

it.each(["masked", "full"] as const)("projects long license code boxes at level %s", (level) => {
  const licenseKey = "EXAMPLE-" + "a".repeat(358) + "1234";
  const archive = content(projectArchive({ policy: { ...config().logging.defaults, level, show: ["licenseKey"] }, patterns,
    brand, template: getTemplate("license")!, data: { licenseKey } }));
  expect(archive.html).toMatch(/<pre style="[^"]*word-break:break-all;[^"]*">••••1234<\/pre>/);
  expect(JSON.stringify(archive)).not.toContain(licenseKey);
  expect(archive.text).toContain("Klucz licencji: ••••1234");
});
