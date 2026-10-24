import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, seal } from '../src/core/crypto/index.ts';

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/keys.mjs', ...args], { encoding: 'utf8', env: { ...process.env, INDEX_KEYS: '', ...env } });
function output(result) {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), JSON.parse(line.slice(at + 1, -1).replace(/^'/, ''))];
  }));
}

it('initializes usable keys with a private file and explicit environment output', async () => {
  const dir = mkdtempSync(fileURLToPath(new URL('../.keys-test-', import.meta.url))); directories.push(dir);
  const path = join(dir, 'content.json');
  const result = run(['init', path]);
  const env = output(result);
  expect(Object.keys(env)).toEqual(['CONTENT_PUBLIC_KEYS', 'INDEX_KEYS']);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const privateKeys = JSON.parse(readFileSync(path, 'utf8'));
  const publicKeys = env.CONTENT_PUBLIC_KEYS;
  expect(publicKeys.keys[0].d).toBeUndefined();
  expect(privateKeys.keys[0].d).toBeTruthy();
  expect(result.stdout).not.toContain(privateKeys.keys[0].d);
  expect(Buffer.from(env.INDEX_KEYS[0].key, 'base64url')).toHaveLength(32);
  const context = { brand: 'acme', messageId: 'cli', purpose: 'content' };
  expect(await open(await seal({ ok: true }, context, publicKeys.keys), context, privateKeys.keys)).toEqual({ ok: true });
  const second = run(['init', path]);
  expect(second.status).toBe(1);
  expect(second.stdout).toBe('');
  expect(second.stderr).toBe('Unable to manage keys\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(privateKeys);
});

it('prepends a new index key and preserves existing keys', () => {
  const old = [{ kid: 'old', key: Buffer.alloc(32, 1).toString('base64url') }];
  const env = output(run(['rotate-index'], { INDEX_KEYS: JSON.stringify(old) }));
  expect(env.INDEX_KEYS).toHaveLength(2);
  expect(env.INDEX_KEYS[1]).toEqual(old[0]);
  expect(env.INDEX_KEYS[0].kid).not.toBe('old');
  expect(Buffer.from(env.INDEX_KEYS[0].key, 'base64url')).toHaveLength(32);
});

it.each([
  [[], {}], [['init'], {}], [['unknown'], {}],
  [['rotate-index'], { INDEX_KEYS: 'sentinel-material' }],
  [['rotate-index'], { INDEX_KEYS: JSON.stringify([{ kid: 123, key: Buffer.alloc(32, 1).toString('base64url') }]) }],
  [['rotate-index'], { INDEX_KEYS: '[{"kid":"old","key":"sentinel-material"}]' }],
])('returns fixed diagnostics for invalid arguments or configuration %j', (args, env) => {
  const result = run(args, env);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Unable to manage keys\n');
});
