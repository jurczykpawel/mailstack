import { effectivePolicies, parseConfig } from "./schema.ts";
import type { TemplatePolicies } from "./schema.ts";

export interface LoadOptions {
  templates?: TemplatePolicies;
  audit?: (event: "policy.secret_archive_enabled", context: { brand: string; template: string }) => void;
}
export function loadConfig(json: string, options: LoadOptions = {}) {
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw new Error("$: invalid JSON"); }
  const config = parseConfig(input, options.templates);
  for (const { brandId, templateId, policy, path } of effectivePolicies(config, options.templates)) {
    if (!policy.includeSecrets) continue;
    if (!options.audit) throw new Error(`$.${path("includeSecrets").join(".")}: audit sink required`);
    options.audit("policy.secret_archive_enabled", { brand: brandId, template: templateId });
  }
  return config;
}
