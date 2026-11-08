import { operatorEnvironment, required } from './operator.mjs';
export function stagingOptions(env = operatorEnvironment()) {
  const account = required({ ...env, MAILSTACK_STAGING_ACCOUNT_ID: env.MAILSTACK_STAGING_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID }, 'MAILSTACK_STAGING_ACCOUNT_ID');
  const productionAccount = required(env, 'MAILSTACK_PRODUCTION_ACCOUNT_ID');
  const routing = env.MAILSTACK_STAGING_ROUTING ?? 'workers-dev';
  if (!['workers-dev', 'custom-domain'].includes(routing)) throw Error('Invalid staging routing');
  if (account === productionAccount && routing !== 'custom-domain') throw Error('Workers staging must use a separate account');
  if (routing === 'custom-domain' && !env.MAILSTACK_STAGING_STATE) throw Error('Legacy routing requires explicit protected state');
  return { account, productionAccount, routing,
    state: required(env, 'MAILSTACK_STAGING_STATE'),
    tokenItem: env.CLOUDFLARE_API_TOKEN ? undefined : required(env, 'MAILSTACK_STAGING_TOKEN_ITEM'),
  };
}
