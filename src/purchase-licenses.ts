import { z } from 'zod';
import type { Brand, TemplateData } from './types';

export const PURCHASE_LICENSE_LIMIT = 32;
export const purchaseLicenseSlots = Array.from({ length: PURCHASE_LICENSE_LIMIT }, (_, i) => ({
  key: `purchaseLicenseKey${i}`, product: `purchaseLicenseProduct${i}`, url: `purchaseLicenseUrl${i}`,
}));
export const purchaseLicenseSecrets = purchaseLicenseSlots.flatMap(slot => [slot.key, slot.url]);
const nonempty = z.string().max(48 * 1024).refine(value => value.trim().length > 0);
export const purchaseLicensesSchema = z.array(z.object({
  productId: nonempty, token: nonempty, kid: nonempty,
  jwksUrl: z.url().max(2048).refine(value => /^https?:/.test(value)),
})).max(PURCHASE_LICENSE_LIMIT).superRefine((licenses, ctx) => {
  const seen = new Set<string>();
  for (const [i, license] of licenses.entries()) {
    if (seen.has(license.productId)) ctx.addIssue({ code: 'custom', path: [i, 'productId'], message: 'duplicate product' });
    seen.add(license.productId);
  }
  if (new TextEncoder().encode(JSON.stringify(licenses)).byteLength > 48 * 1024)
    ctx.addIssue({ code: 'custom', message: 'license data too large' });
});

export function purchaseLicenseData(data: Record<string, unknown>, brand: Brand): TemplateData {
  const licenses = purchaseLicensesSchema.parse(data.licenses ?? []);
  const products = [data.product, ...(Array.isArray(data.bundleComponents) ? data.bundleComponents : [])];
  const names = new Map<string, string>();
  for (const product of products) {
    if (product && typeof product === 'object' && 'id' in product && typeof product.id === 'string'
      && 'name' in product && typeof product.name === 'string' && product.name.trim()) {
      names.set(product.id, product.name);
    }
  }
  const fields: TemplateData = {};
  for (const [i, license] of licenses.entries()) {
    const slot = purchaseLicenseSlots[i];
    fields[slot.key] = license.token;
    fields[slot.product] = names.get(license.productId) ?? `Produkt: ${license.productId}`;
    fields[slot.url] = brand.licenseActivationUrls && Object.hasOwn(brand.licenseActivationUrls, license.productId)
      ? brand.licenseActivationUrls[license.productId] : '';
  }
  return fields;
}
