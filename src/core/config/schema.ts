import { z } from "zod";
import { TEMPLATES } from "../../templates/index.ts";

const strings = z.array(z.string());
const days = z.number().int().positive();
const policy = z.strictObject({
  level: z.enum(["none", "meta", "masked", "full"]), contentDays: days, metaDays: days,
  requireLog: z.boolean(), resend: z.enum(["off", "replay", "source"]),
  alertOn: z.array(z.enum(["bounce_permanent", "complaint", "reject", "send_failed", "unknown", "render_failure"])),
  show: strings, includeSecrets: z.boolean(),
});
const brand = z.strictObject({
  id: z.string(), name: z.string(), from: z.string(), to: strings, allowedOrigins: strings,
  subjectPrefix: z.string(), autoReply: z.boolean().optional(), autoReplyTemplate: z.string().optional(),
  turnstileAction: z.string().optional(),
  captcha: z.enum(["altcha", "turnstile"]).optional(),
  theme: z.strictObject({
    accent: z.string(), accent2: z.string().optional(), logoUrl: z.string().optional(), siteUrl: z.string(),
    address: z.string().optional(), phone: z.string().optional(),
  }),
});
const pattern = z.union([
  z.strictObject({ name: z.string().min(1), regex: z.string().refine((value) => {
    try { new RegExp(value); return true; } catch { return false; }
  }, "invalid regular expression") }),
  z.strictObject({ name: z.string().min(1), urlParams: strings.nonempty() }),
]);
const shape = z.strictObject({
  version: z.literal(1), brands: z.record(z.string(), brand),
  logging: z.strictObject({
    defaults: policy, ceilings: z.strictObject({ contentDays: days, metaDays: days, auditDays: days }),
    patterns: z.array(pattern), brands: z.record(z.string(), z.strictObject({
      defaults: policy.partial().optional(), templates: z.record(z.string(), policy.partial()).optional(),
    })),
  }),
  clients: z.unknown().optional(), events: z.unknown().optional(), alerts: z.unknown().optional(),
});
export type Config = z.infer<typeof shape>;
export type TemplatePolicies = Record<string, { secretFields?: string[] }>;
export type Policy = z.infer<typeof policy>;
const callbackClient = z.object({
  brands: z.union([z.literal("*"), strings]), templates: z.union([z.literal("*"), strings]),
  resendCallback: z.object({ url: z.url().refine((v) => /^https?:/.test(v)), secretEnv: z.string().min(1) }),
});
export function effectivePolicies(config: Config, templates: TemplatePolicies = TEMPLATES) {
  const brandIds = Object.keys(config.brands);
  return (brandIds.length ? brandIds : ["*"]).flatMap((brandId) => {
    const overrides = config.logging.brands[brandId];
    const defaults = { ...config.logging.defaults, ...overrides?.defaults };
    const ids = new Set([...Object.keys(templates), ...Object.keys(overrides?.templates ?? {})]);
    return [...ids].map((templateId) => ({
      brandId, templateId, policy: { ...defaults, ...overrides?.templates?.[templateId] },
      path: (key: keyof Policy) => overrides?.templates?.[templateId]?.[key] !== undefined
        ? ["logging", "brands", brandId, "templates", templateId, key]
        : overrides?.defaults?.[key] !== undefined ? ["logging", "brands", brandId, "defaults", key]
          : ["logging", "defaults", key],
    }));
  });
}
function schemaWithTemplates(templates: TemplatePolicies) {
  return shape.superRefine((config, ctx) => {
    const fail = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const [id, entry] of Object.entries(config.brands)) {
      if (id !== entry.id) fail(["brands", id, "id"], "must match registry key");
    }
    for (const id of Object.keys(config.logging.brands)) {
      if (!Object.hasOwn(config.brands, id)) fail(["logging", "brands", id], "unknown brand");
    }
    const clients = Array.isArray(config.clients) ? config.clients.flatMap((value) => {
      const parsed = callbackClient.safeParse(value); return parsed.success ? [parsed.data] : [];
    }) : [];
    for (const { brandId, templateId, policy: p, path } of effectivePolicies(config, templates)) {
      if (p.contentDays > p.metaDays || p.contentDays > config.logging.ceilings.contentDays)
        fail(path("contentDays"), `exceeds $.${path("metaDays").join(".")} or ceiling`);
      if (p.metaDays > config.logging.ceilings.metaDays) fail(path("metaDays"), "exceeds ceiling");
      if (p.resend === "replay" && templates[templateId]?.secretFields?.length)
        fail(path("resend"), "template requires source or off");
      if (p.resend === "replay" && p.level !== "masked" && p.level !== "full")
        fail(path("resend"), "replay requires masked or full");
      if (p.resend === "source" && !clients.some((c) =>
        (c.brands === "*" || c.brands.includes(brandId)) &&
        (c.templates === "*" || (templateId !== "*" && c.templates.includes(templateId)))))
        fail(path("resend"), "source requires an allowed resendCallback client");
      if (p.includeSecrets && p.level !== "full") fail(path("includeSecrets"), "requires full");
    }
  });
}
export const configSchema = schemaWithTemplates(TEMPLATES);
export function parseConfig(input: unknown, templates: TemplatePolicies = TEMPLATES): Config {
  const result = schemaWithTemplates(templates).safeParse(input);
  if (result.success) return result.data;
  throw new Error(result.error.issues.flatMap((issue) => {
    const paths = issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key]) : [issue.path];
    return paths.map((path) => `$.${path.join(".")}: ${issue.code === "custom" ? issue.message : "invalid configuration"}`);
  }).join("\n"));
}
