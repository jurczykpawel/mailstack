// Installation identities belong outside the public checkout. No credential values here.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function operatorEnvironment(env = process.env) {
  const path = env.MAILSTACK_STAGING_OPERATOR ?? `${env.HOME ?? homedir()}/.config/mailstack-staging/operator.json`;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (resolve(path).startsWith(root)) throw Error('Operator configuration must be outside the checkout');
  if (!existsSync(path) && !env.MAILSTACK_STAGING_OPERATOR) return { ...env };
  let config;
  try {
    if (statSync(path).mode & 0o077) throw Error();
    config = JSON.parse(readFileSync(path, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object' ||
        Object.entries(config).some(([key, value]) => !/^MAILSTACK_[A-Z0-9_]+$/.test(key) || typeof value !== 'string')) throw Error();
  } catch { throw Error('Operator configuration must be a readable 0600 JSON object of MAILSTACK_* strings'); }
  return { ...config, ...env };
}
export function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw Error(`Set ${key} in the environment or private operator configuration`);
  return value;
}
