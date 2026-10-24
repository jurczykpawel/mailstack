import type { Brand } from "./types";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
  brand: Brand,
): Promise<boolean> {
  if (!secret || !token) return false;

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    const hosts = new Set(brand.allowedOrigins.map((origin) => new URL(origin).hostname));
    return data.success === true
      && typeof data.hostname === "string" && hosts.has(data.hostname)
      && (brand.turnstileAction === undefined || data.action === brand.turnstileAction);
  } catch {
    return false;
  }
}
