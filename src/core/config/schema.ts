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
  requireNonce: z.boolean().optional(),
  products: z.array(z.string().min(1).max(100)).optional(),
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
const scopes = z.array(z.enum(["send", "hook:sellf", "panel"])).refine(
  (values) => !values.includes("panel") || values.length === 1, "panel requires a separate client");
const selection = z.union([z.literal("*"), z.array(z.string().min(1))]);
const permissions = {
  scopes, brands: selection, templates: selection,
  recipientOverride: z.boolean().default(false), attachments: z.boolean().default(false),
};
export const clientSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/), tokenSha256: z.string().regex(/^[a-f0-9]{64}$/i), ...permissions,
  brands: selection.optional(), templates: selection.optional(),
  rate: z.strictObject({ perMinute: days, perDay: days }).optional(),
  resendCallback: z.strictObject({
    url: z.url().refine((value) => /^https?:/.test(value)), secretEnv: z.string().min(1),
  }).optional(),
  sellfSignatureSecretEnv: z.string().min(1).optional(),
}).superRefine((client, ctx) => {
  if (client.scopes.some((scope) => scope === "send" || scope === "hook:sellf")) {
    for (const field of ["brands", "templates"] as const) {
      if (client[field] === undefined)
        ctx.addIssue({ code: "custom", path: [field], message: "required for send or hook:sellf" });
    }
  }
}).transform((client) => ({ ...client, brands: client.brands ?? [], templates: client.templates ?? [] }));
const legacySchema = z.strictObject({
  ...permissions, brands: selection.default("*"), templates: selection.default("*"),
  enabled: z.boolean().default(true), env: z.string().min(1).default("API_KEY"),
  scopes: scopes.default(["send", "hook:sellf"]), recipientOverride: z.boolean().default(true),
});
export type Client = z.infer<typeof clientSchema>;
const shape = z.strictObject({
  sender: z.strictObject({ type: z.enum(["ses", "smtp"]) }).optional(),
  version: z.literal(1), brands: z.record(z.string(), brand),
  logging: z.strictObject({
    defaults: policy, ceilings: z.strictObject({ contentDays: days, metaDays: days, auditDays: days }),
    patterns: z.array(pattern), brands: z.record(z.string(), z.strictObject({
      defaults: policy.partial().optional(), templates: z.record(z.string(), policy.partial()).optional(),
    })),
  }),
  clients: z.array(clientSchema).optional(), legacyApiKey: legacySchema.optional(), events: z.strictObject({ ses: z.strictObject({
    topicArns: z.array(z.string().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+(?:\.fifo)?$/)).nonempty(),
    accountIds: z.array(z.string().regex(/^\d{12}$/)).nonempty(), allowSignatureV1: z.boolean().default(false),
  }).optional() }).optional(), alerts: z.unknown().optional(),
});
export type Config = z.infer<typeof shape>;
export type TemplatePolicies = Record<string, { secretFields?: string[] }>;
export type Policy = z.infer<typeof policy>;
export function effectivePolicies(config: Config, templates: TemplatePolicies = TEMPLATES) {
  const brandIds = Object.keys(config.brands);
  return (brandIds.length ? brandIds : ["*"]).flatMap((brandId) => {
    const overrides = Object.hasOwn(config.logging.brands, brandId) ? config.logging.brands[brandId] : undefined;
    const defaults = { ...config.logging.defaults, ...overrides?.defaults };
    const ids = new Set([...Object.keys(templates), ...Object.keys(overrides?.templates ?? {})]);
    return [...ids].map((templateId) => {
      const templatePolicy = overrides?.templates && Object.hasOwn(overrides.templates, templateId) ? overrides.templates[templateId] : undefined;
      return { brandId, templateId, policy: { ...defaults, ...templatePolicy },
        path: (key: keyof Policy) => templatePolicy?.[key] !== undefined
          ? ["logging", "brands", brandId, "templates", templateId, key]
          : overrides?.defaults?.[key] !== undefined ? ["logging", "brands", brandId, "defaults", key]
            : ["logging", "defaults", key],
      };
    });
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
    const clients = (config.clients ?? []).filter((client) => client.resendCallback);
    const ids = new Set<string>();
    for (const [index, client] of (config.clients ?? []).entries()) {
      if (ids.has(client.id)) ctx.addIssue({ code: "custom", path: ["clients", index, "id"], message: "duplicate client id" });
      ids.add(client.id);
    }
    for (const { brandId, templateId, policy: p, path } of effectivePolicies(config, templates)) {
      if (p.contentDays > p.metaDays || p.contentDays > config.logging.ceilings.contentDays)
        fail(path("contentDays"), `exceeds $.${path("metaDays").join(".")} or ceiling`);
      if (p.metaDays > config.logging.ceilings.metaDays) fail(path("metaDays"), "exceeds ceiling");
      if (p.resend === "replay" && Object.hasOwn(templates, templateId) && templates[templateId]?.secretFields?.length)
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
