import type { Client, Config } from "./core/config/schema.ts";

const encoder = new TextEncoder();
export async function tokenSha256(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function matches(token: string, expected: string): Promise<boolean> {
  const actual = await tokenSha256(token);
  // HMAC verification provides a native constant-time comparison in both runtimes.
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(actual));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected.toLowerCase()));
}
export async function authenticate(
  req: Request, env: object, config: Pick<Config, "clients" | "legacyApiKey">,
): Promise<Client | null> {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1].trim();
  if (!token) return null;
  const legacy = config.legacyApiKey;
  const secret = Reflect.get(env, legacy?.env ?? "API_KEY");
  if ((legacy?.enabled ?? true) && typeof secret === "string" && secret && await matches(token, await tokenSha256(secret))) {
    return {
      id: "legacy", tokenSha256: "", scopes: ["send", "hook:sellf"], brands: "*", templates: "*",
      recipientOverride: true, attachments: false, ...legacy,
    };
  }
  const id = /^msk_([a-z0-9-]+)_[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
  const client = config.clients?.find((entry) => entry.id === id);
  const valid = await matches(token, client?.tokenSha256 ?? "0".repeat(64));
  return valid && client ? client : null;
}
export function permits(client: Client, scope: Client["scopes"][number], brand: string, template?: string): boolean {
  return client.scopes.includes(scope) && (client.brands === "*" || client.brands.includes(brand)) &&
    (template === undefined || client.templates === "*" || client.templates.includes(template));
}
