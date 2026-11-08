import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { operatorEnvironment } from '../scripts/staging/operator.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config(value) {
  const dir = mkdtempSync(join(tmpdir(), 'staging-operator-')); dirs.push(dir);
  const path = join(dir, 'operator.json');
  writeFileSync(path, value, { mode: 0o600 });
  return { path, env: { HOME: dir, MAILSTACK_STAGING_OPERATOR: path } };
}
it('loads private identities and gives explicit environment values precedence', () => {
  const { env } = config(JSON.stringify({ MAILSTACK_STAGING_ACCOUNT_ID: 'file-account', MAILSTACK_STAGING_TOKEN_ITEM: 'private-item' }));
  expect(operatorEnvironment({ ...env, MAILSTACK_STAGING_ACCOUNT_ID: 'override' })).toMatchObject({ MAILSTACK_STAGING_ACCOUNT_ID: 'override', MAILSTACK_STAGING_TOKEN_ITEM: 'private-item' });
});
it('rejects unreadable, malformed and unprotected operator configuration without echoing its contents', () => {
  for (const value of ['private-not-json', '[]', 'null', '{"MAILSTACK_TOKEN":17}', '{"OTHER":"private-value"}']) {
    const { env } = config(value);
    expect(() => operatorEnvironment(env)).toThrow('readable 0600 JSON');
  }
  const { path, env } = config('{}');
  chmodSync(path, 0o644);
  expect(() => operatorEnvironment(env)).toThrow('readable 0600 JSON');
  expect(() => operatorEnvironment({ ...env, MAILSTACK_STAGING_OPERATOR: path + '.missing' })).toThrow('readable 0600 JSON');
});
it('rejects operator files inside the checkout', () => {
  expect(() => operatorEnvironment({ MAILSTACK_STAGING_OPERATOR: 'config/operator.json' })).toThrow('outside the checkout');
});
it('refuses unconfigured Worker, Node and manual entrypoints before provider calls', () => {
  const { path, env } = config('{}');
  for (const script of ['scripts/staging/worker.mjs', 'scripts/staging/node.mjs', 'scripts/manual/worker.mjs']) {
    const child = spawnSync(process.execPath, [script, 'status'], { env, encoding: 'utf8' });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('in the environment or private operator configuration');
    expect(child.stdout).toBe('');
  }
  // Avoid the real operator file when checking the environment-only path.
  rmSync(path);
  expect(operatorEnvironment({ HOME: env.HOME })).toEqual({ HOME: env.HOME });
});
