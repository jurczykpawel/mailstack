import { z } from 'zod';

export const SOURCE_LIMITS = { bodyBytes: 64 * 1024, depth: 20, fields: 40, valueChars: 5000 } as const;
const safeKey = z.string().min(1).max(128).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
export const sourceId = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const path = z.string().min(1).max(512).refine(value =>
  value.split('.').length <= SOURCE_LIMITS.depth && value.split('.').every(part =>
    /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/.test(part) && safeKey.safeParse(part).success));
const first = z.strictObject({ first: z.array(path).min(1).max(SOURCE_LIMITS.fields) });
const join = z.strictObject({ join: z.array(path).min(1).max(SOURCE_LIMITS.fields) });
const selection = z.union([path, first, join]);
const format = z.string().max(SOURCE_LIMITS.valueChars).refine(value => {
  const placeholders = [...value.matchAll(/\{([^{}]+)\}/g)];
  return !/[{}]/.test(value.replace(/\{[^{}]+\}/g, "")) && placeholders.every(match => path.safeParse(match[1]).success);
});
const field = z.union([
  first, z.strictObject({ format }),
  path,
  z.strictObject({ path, as: z.enum(['money-minor', 'upper', 'date-pl']) }),
  z.strictObject({ path, as: z.literal('map'), map: z.record(safeKey.regex(/^(?:boolean:(?:true|false)|number:.+|string:.*)$/s), z.string().max(SOURCE_LIMITS.valueChars))
    .refine(value => Object.keys(value).length <= SOURCE_LIMITS.fields) }),
  join,
]);
const action = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('send'), template: safeKey, to: path,
    fields: z.record(safeKey, field).refine(value => Object.keys(value).length <= SOURCE_LIMITS.fields),
    ref: selection.optional(), idempotencyKey: selection.optional(),
    requiredFields: z.array(safeKey).max(SOURCE_LIMITS.fields).optional(),
    transform: z.enum(['purchase-licenses', 'sellf-license', 'free-access']).optional() }),
  z.strictObject({ action: z.literal('ignore') }),
  z.strictObject({ action: z.literal('reject') }),
]);
export const sourceSchema = z.strictObject({
  signature: z.discriminatedUnion('scheme', [
    z.strictObject({ scheme: z.literal('bearer-only') }),
    z.strictObject({ scheme: z.literal('t-v1'), header: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
      toleranceSeconds: z.number().int().min(0).max(300).default(300) }),
    z.strictObject({ scheme: z.literal('sha256-prefix'), header: z.string().regex(/^[A-Za-z0-9-]{1,128}$/) }),
  ]),
  envelope: z.strictObject({ event: path, timestamp: path, data: path }),
  events: z.record(safeKey, action).refine(value => Object.keys(value).length <= 100),
});
export type Source = z.infer<typeof sourceSchema>;
export type SourceField = z.infer<typeof field>;

export function requiredSourceFields(action: Extract<Source['events'][string], { action: 'send' }>): string[] {
  const transform = action.transform === 'sellf-license' ? ['licenseOrder', 'issuanceSource', 'productId']
    : action.transform === 'free-access' ? ['grantSource'] : [];
  return [...new Set([...(action.requiredFields ?? []), ...transform])];
}
