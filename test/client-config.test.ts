import { expect, it } from "vitest";
import { parseConfig } from "../src/core/config/schema";
import original from "../config/mailstack.example.json";

const entry = () => ({ id: "acme-app", tokenSha256: "a".repeat(64), scopes: ["send", "hook:sellf"], brands: ["acme"], templates: ["contact", "payment"], recipientOverride: false, attachments: false });

it.each([
  [{ id: "Bad_Id" }, "id"], [{ tokenSha256: "x".repeat(64) }, "tokenSha256"], [{ scopes: ["send", "panel"] }, "scopes"],
  [{ scopes: ["other"] }, "scopes"], [{ attachments: "yes" }, "attachments"], [{ rate: { perMinute: 0, perDay: 10 } }, "rate.perMinute"],
  [{ rate: { perMinute: 1, perDay: 1.5 } }, "rate.perDay"], [{ resendCallback: { url: "file:///tmp/a", secretEnv: "SECRET" } }, "resendCallback.url"],
  [{ sellfSignatureSecretEnv: "" }, "sellfSignatureSecretEnv"], [{ extra: true }, "extra"],
])("validates client fields: %j", (change, path) => {
  expect(() => parseConfig({ ...original, clients: [{ ...entry(), ...change }] })).toThrow(`$.clients.0.${path}`);
});
it("requires unique client ids and exclusive panel scopes", () => {
  expect(() => parseConfig({ ...original, clients: [entry(), entry()] })).toThrow("$.clients.1.id");
  expect(() => parseConfig({ ...original, legacyApiKey: { scopes: ["panel", "send"] } })).toThrow("$.legacyApiKey.scopes");
  expect(() => parseConfig({ ...original, clients: [{ id: "panel", tokenSha256: "A".repeat(64), scopes: ["panel"] }] })).not.toThrow();
});
it("parses future client options", () => {
  const client = { ...entry(), attachments: true, rate: { perMinute: 30, perDay: 1000 }, resendCallback: { url: "https://example.com/resend", secretEnv: "RESEND_SECRET" }, sellfSignatureSecretEnv: "SELLF_SECRET" };
  expect(parseConfig({ ...original, clients: [client] }).clients).toEqual([client]);
});

it.each([
  ["send", "brands"], ["send", "templates"], ["hook:sellf", "brands"], ["hook:sellf", "templates"],
])("requires explicit %s selections: %s", (scope, field) => {
  const client: Record<string, unknown> = { ...entry(), scopes: [scope] };
  delete client[field];
  expect(() => parseConfig({ ...original, clients: [client] })).toThrow(`$.clients.0.${field}`);
});
it("uses empty selections for a panel client", () => {
  const client = { id: "panel", tokenSha256: "a".repeat(64), scopes: ["panel"] };
  expect(parseConfig({ ...original, clients: [client] }).clients?.[0]).toMatchObject({ brands: [], templates: [] });
});
it("retains wildcard defaults for legacy configuration", () => {
  expect(parseConfig({ ...original, legacyApiKey: {} }).legacyApiKey).toMatchObject({ brands: "*", templates: "*" });
});
