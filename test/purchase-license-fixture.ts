import purchase from '../scripts/manual/purchase-fixture.json' with { type: 'json' };

// Synthetic purchase shaped from the Sellf PurchaseWebhookData contract.
export function bundlePurchase() { return structuredClone(purchase); }
