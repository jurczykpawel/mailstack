import type { Config } from "./core/config/schema.ts";

export type Scope = "send" | "panel" | "webhooks:write" | `hook:${string}`;
/** Authenticated principal. The free core issues only the full key; Mailstack Pro supplies scoped clients. */
export interface Client {
  id: string; scopes: Scope[]; brands: "*" | string[]; templates: "*" | string[];
  recipientOverride: boolean; attachments: boolean;
  signatureSecretEnv?: string; sellfSignatureSecretEnv?: string;
  resendCallback?: { url: string; secretEnv: string };
}
/** Keeps a background task alive past the response (Worker `ctx.waitUntil`). */
export type Defer = (task: Promise<unknown>) => void;
/** Extension hook for keys beyond the single full key (Mailstack Pro). */
export interface KeyProvider {
  authenticate(token: string, env: object, defer?: Defer): Promise<Client | null>;
  client(id: string): Client | undefined;
}
/** Worker build of Mailstack Pro, generated into `src/core/pro.generated.ts` by `npm run setup`. */
export type ProKeys = (config: Config, env: object) => KeyProvider;
export const PRO_KEYS = "additional or restricted API keys require Mailstack Pro";

const encoder = new TextEncoder();
export async function tokenSha256(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Constant-time comparison of a token against a SHA-256 hex digest. */
export async function tokenMatches(token: string, expected: string): Promise<boolean> {
  const actual = await tokenSha256(token);
  // HMAC verification provides a native constant-time comparison in both runtimes.
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(actual));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected.toLowerCase()));
}
export async function authenticate(
  req: Request, env: object, config: Pick<Config, "legacyApiKey">, keys?: KeyProvider, defer?: Defer,
): Promise<Client | null> {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1].trim();
  if (!token) return null;
  const legacy = config.legacyApiKey;
  const secret = Reflect.get(env, legacy?.env ?? "API_KEY");
  if ((legacy?.enabled ?? true) && typeof secret === "string" && secret && await tokenMatches(token, await tokenSha256(secret))) {
    return { id: "legacy", scopes: ["send", "hook:sellf"], brands: "*", templates: "*", recipientOverride: true,
      attachments: legacy?.attachments ?? false, signatureSecretEnv: legacy?.signatureSecretEnv };
  }
  return keys ? keys.authenticate(token, env, defer) : null;
}
/** Fails startup when the configuration declares clients without a key provider. */
export function requireKeyProvider(config: Pick<Config, "clients">, keys?: KeyProvider): void {
  if (config.clients !== undefined && !keys) throw new Error(`$.clients: ${PRO_KEYS}`);
}
export function permits(client: Client, scope: Scope, brand: string, template?: string): boolean {
  return client.scopes.includes(scope) && (client.brands === "*" || client.brands.includes(brand)) &&
    (template === undefined || client.templates === "*" || client.templates.includes(template));
}
