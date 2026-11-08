// Maintainer defaults. Production credentials are used only for read-only fingerprints.
export const STAGING_ACCOUNT = 'ea7bda8af2b011d391d4085c83ac73e1';
export const PRODUCTION_ACCOUNT = '92e7018cfc666807c755836278d19eaf';
export function stagingOptions(env = process.env) {
  const account = env.MAILSTACK_STAGING_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? STAGING_ACCOUNT;
  const productionAccount = env.MAILSTACK_PRODUCTION_ACCOUNT_ID ?? PRODUCTION_ACCOUNT;
  const routing = env.MAILSTACK_STAGING_ROUTING ?? 'workers-dev';
  if (!['workers-dev', 'custom-domain'].includes(routing)) throw Error('Invalid staging routing');
  if (account === productionAccount && routing !== 'custom-domain') throw Error('Workers staging must use a separate account');
  if (routing === 'custom-domain' && !env.MAILSTACK_STAGING_STATE) throw Error('Legacy routing requires explicit protected state');
  return { account, productionAccount, routing,
    state: env.MAILSTACK_STAGING_STATE ?? `${env.HOME}/.config/mailstack-staging/worker-f3`,
    tokenItem: env.MAILSTACK_STAGING_TOKEN_ITEM ?? (account === STAGING_ACCOUNT
      ? 'Mailstack staging — Cloudflare agent token (F3)' : 'CF Deploy - General API token'),
  };
}
