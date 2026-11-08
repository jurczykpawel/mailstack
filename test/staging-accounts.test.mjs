import { expect, it } from 'vitest';
import { stagingOptions } from '../scripts/staging/accounts.mjs';
import { stagingEnv } from './fixtures/staging.ts';
const env = { ...stagingEnv, MAILSTACK_STAGING_STATE: '/state/staging' };
it('uses explicit operator identities with workers.dev routing', () => {
  expect(stagingOptions(env)).toMatchObject({ account: 'test-account', productionAccount: 'prod-account',
    routing: 'workers-dev', state: '/state/staging', tokenItem: 'staging-token-fixture' });
});
it('requires explicit routing and state for legacy resources', () => {
  const shared = { ...env, MAILSTACK_STAGING_ACCOUNT_ID: 'prod-account' };
  expect(() => stagingOptions(shared)).toThrow('separate account');
  expect(() => stagingOptions({ ...shared, MAILSTACK_STAGING_ROUTING: 'custom-domain', MAILSTACK_STAGING_STATE: undefined })).toThrow('explicit protected state');
  expect(stagingOptions({ ...shared, MAILSTACK_STAGING_ROUTING: 'custom-domain' }).account).toBe('prod-account');
  expect(() => stagingOptions({ ...env, MAILSTACK_STAGING_ROUTING: 'other' })).toThrow('Invalid staging routing');
});
it('refuses missing installation identities instead of using maintainer defaults', () => {
  for (const key of ['MAILSTACK_STAGING_ACCOUNT_ID', 'MAILSTACK_PRODUCTION_ACCOUNT_ID', 'MAILSTACK_STAGING_STATE', 'MAILSTACK_STAGING_TOKEN_ITEM']) {
    expect(() => stagingOptions({ ...env, [key]: undefined })).toThrow(key);
  }
  expect(stagingOptions({ ...env, MAILSTACK_STAGING_ACCOUNT_ID: undefined, CLOUDFLARE_ACCOUNT_ID: 'other' }).account).toBe('other');
});
