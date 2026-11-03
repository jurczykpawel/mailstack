import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, seal } from '../src/core/crypto/index.ts';
import { keyringFingerprint, parseTransitKeys } from '../src/core/keyring.ts';

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/keys.mjs', ...args], { encoding: 'utf8', env: { ...process.env, INDEX_KEYS: '', ...env } });
function output(result) {
  expect(result.status).toBe(0);
  return Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), JSON.parse(line.slice(at + 1, -1).replace(/^'/, ''))];
  }));
}

const tempDir = () => {
  const dir = mkdtempSync(fileURLToPath(new URL('../.keys-test-', import.meta.url))); directories.push(dir);
  return dir;
};
const refused = (result) => {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
};
function initialized() {
  const dir = tempDir();
  const path = join(dir, 'content.json');
  const first = run(['init', path]);
  refused(first);
  expect(first.stderr).toContain('Offline copy not verified');
  expect(first.stderr).toContain(`init ${path} --backup-verified`);
  return { dir, path, privateKeys: JSON.parse(readFileSync(path, 'utf8')) };
}

it('writes the private file but prints nothing until an offline copy is verified', async () => {
  const { dir, path, privateKeys } = initialized();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const copy = join(dir, 'offline.json');
  copyFileSync(path, copy);
  const result = run(['init', path, '--backup-verified', copy]);
  const env = output(result);
  expect(Object.keys(env)).toEqual(['CONTENT_PUBLIC_KEYS', 'INDEX_KEYS', 'TRANSIT_KEYS']);
  expect(result.stderr).toBe(`Offline copy verified. Keyring fingerprint: ${await keyringFingerprint(privateKeys.keys)}\n`);
  const publicKeys = env.CONTENT_PUBLIC_KEYS;
  expect(publicKeys.keys.map(k => [k.kid, k.x, k.d])).toEqual([[privateKeys.keys[0].kid, privateKeys.keys[0].x, undefined]]);
  expect(result.stdout).not.toContain(privateKeys.keys[0].d);
  expect(Buffer.from(env.INDEX_KEYS[0].key, 'base64url')).toHaveLength(32);
  const transit = await parseTransitKeys(JSON.stringify(env.TRANSIT_KEYS));
  expect(transit.publicKeys).toHaveLength(1);
  expect(transit.publicKeys[0].x).not.toBe(privateKeys.keys[0].x);
  const context = { brand: 'acme', messageId: 'cli', purpose: 'content' };
  expect(await open(await seal({ ok: true }, context, publicKeys.keys), context, privateKeys.keys)).toEqual({ ok: true });
  const second = run(['init', path]);
  refused(second);
  expect(second.stderr).toBe('Unable to manage keys\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(privateKeys);
});

it.each([
  ['a missing copy', () => {}],
  ['a copy of another keyring', (copy, dir) => { const other = join(dir, 'other.json'); run(['init', other]); copyFileSync(other, copy); }],
  ['a corrupted copy', (copy, dir, path) => writeFileSync(copy, readFileSync(path, 'utf8').slice(0, 40))],
  ['a copy with the same public part and a different private key', (copy, dir, path) => {
    const other = join(dir, 'other.json'); run(['init', other]);
    const keys = JSON.parse(readFileSync(path, 'utf8'));
    keys.keys[0].d = JSON.parse(readFileSync(other, 'utf8')).keys[0].d;
    writeFileSync(copy, JSON.stringify(keys));
  }],
  ['a copy with an extra key', (copy, dir, path) => {
    const other = join(dir, 'other.json'); run(['init', other]);
    const keys = JSON.parse(readFileSync(path, 'utf8'));
    keys.keys.push(JSON.parse(readFileSync(other, 'utf8')).keys[0]);
    writeFileSync(copy, JSON.stringify(keys));
  }],
  ['a hard link to the private file', (copy, dir, path) => linkSync(path, copy)],
])('refuses %s and prints no deployable keys', (_, prepare) => {
  const { dir, path } = initialized();
  const copy = join(dir, 'offline.json');
  prepare(copy, dir, path);
  const result = run(['init', path, '--backup-verified', copy]);
  refused(result);
  expect(result.stderr).toBe('Unable to manage keys\n');
});

it('refuses the private file itself and a flag without generated keys', () => {
  const { dir, path } = initialized();
  for (const args of [['init', path, '--backup-verified', path], ['init', join(dir, 'absent.json'), '--backup-verified', path],
    ['init', path, '--backup-verified'], ['init', join(dir, 'absent.json'), '--backup-verified'],
    ['rotate-index', '--backup-verified', path]]) {
    const result = run(args);
    refused(result);
    expect(result.stderr).toBe('Unable to manage keys\n');
  }
  expect(existsSync(join(dir, 'absent.json'))).toBe(false);
});

it('prepends a new index key and preserves existing keys', () => {
  const old = [{ kid: 'old', key: Buffer.alloc(32, 1).toString('base64url') }];
  const result = run(['rotate-index'], { INDEX_KEYS: JSON.stringify(old) });
  expect(result.stderr).toBe('');
  const env = output(result);
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
