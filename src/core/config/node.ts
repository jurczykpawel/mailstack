import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { loadConfig } from "./load.ts";
import type { LoadOptions } from "./load.ts";

export function readConfigFile(path: string) {
  let json: string;
  try { json = readFileSync(path, "utf8"); } catch { throw new Error("$: cannot read MAILSTACK_CONFIG file"); }
  return json.includes('"file"') ? inlineTemplateFiles(json, dirname(path)) : json;
}
/** Replaces `{"file": "relative/path"}` template bodies with the file text, so the configuration hash covers them. */
function inlineTemplateFiles(json: string, base: string): string {
  let config: { mailTemplates?: { custom?: object }; brands?: Record<string, { mailTemplates?: { custom?: object } }> };
  try { config = JSON.parse(json); } catch { return json; }
  const sections = [["mailTemplates", config.mailTemplates?.custom], ...Object.entries(config.brands ?? {}).map(([id, brand]) => [`brands.${id}.mailTemplates`, brand?.mailTemplates?.custom])] as const;
  for (const [root, custom] of sections) for (const [id, definition] of Object.entries(custom ?? {})) {
    for (const [at, variant] of [["", definition], ...Object.entries(definition?.locales ?? {}).map(([tag, value]) => [`.locales.${tag}`, value])]) for (const key of ["markdown", "html", "text"]) {
      const file = variant?.[key]?.file;
      if (typeof file !== "string") continue;
      const path = `$.${root}.custom.${id}${at}.${key}`;
      try {
        const target = realpathSync(resolve(base, file)), inside = relative(realpathSync(base), target);
        if (isAbsolute(file) || inside.startsWith("..") || isAbsolute(inside)) throw new Error();
        variant[key] = readFileSync(target, "utf8");
      } catch { throw new Error(`${path}: cannot read template file`); }
    }
  }
  return JSON.stringify(config);
}
export function loadNodeConfig(options: LoadOptions = {}) {
  const path = process.env.MAILSTACK_CONFIG;
  if (!path) throw new Error("$: MAILSTACK_CONFIG is required");
  return loadConfig(readConfigFile(path), options);
}
