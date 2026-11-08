import { expect, it } from 'vitest';
import { stagingOptions, STAGING_ACCOUNT, PRODUCTION_ACCOUNT } from '../scripts/staging/accounts.mjs';
it('defaults Worker resources to the staging account and separate protected state', () => {
  expect(stagingOptions({ HOME: '/home/operator' })).toMatchObject({ account: STAGING_ACCOUNT, productionAccount: PRODUCTION_ACCOUNT,
    routing: 'workers-dev', state: '/home/operator/.config/mailstack-staging/worker-f3', tokenItem: 'Mailstack staging — Cloudflare agent token (F3)' });
});
it('requires explicit routing and state for legacy resources', () => {
  expect(() => stagingOptions({ CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT })).toThrow('separate account');
  expect(() => stagingOptions({ CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT, MAILSTACK_STAGING_ROUTING: 'custom-domain' })).toThrow('explicit protected state');
  expect(stagingOptions({ CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT, MAILSTACK_STAGING_ROUTING: 'custom-domain', MAILSTACK_STAGING_STATE: '/state/legacy' }).account).toBe(PRODUCTION_ACCOUNT);
  expect(() => stagingOptions({ MAILSTACK_STAGING_ROUTING: 'other' })).toThrow('Invalid staging routing');
});
