import type { Config, Policy } from "../config/schema.ts";
import { canonicalJson } from "../crypto/index.ts";

export interface ResolvedPolicy {
  policy: Policy;
  policy_hash: string;
}

export async function resolvePolicy(logging: Config["logging"], brand: string, template: string): Promise<ResolvedPolicy> {
  const overrides = logging.brands[brand];
  const policy = structuredClone({ ...logging.defaults, ...overrides?.defaults, ...overrides?.templates?.[template] });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(policy)));
  const policy_hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return { policy, policy_hash };
}
