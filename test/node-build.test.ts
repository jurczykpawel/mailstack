import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('builds without brand configuration and refuses absent or invalid runtime config', () => {
  execFileSync(process.execPath, ['scripts/build-node.mjs']);
  const example = JSON.parse(readFileSync('config/mailstack.example.json', 'utf8'));
  expect(readFileSync('dist/node-api.mjs', 'utf8')).not.toContain(example.brands.acme.from);
  const env = { ...process.env }; delete env.MAILSTACK_CONFIG;
  const absent = spawnSync(process.execPath, ['dist/node-api.mjs'], { env, encoding: 'utf8' });
  expect(absent.status).toBe(1); expect(absent.stderr).toContain('MAILSTACK_CONFIG is required');
  for (const value of ['{', JSON.stringify({ ...example, sender: { type: 'other' } })]) {
    writeFileSync('dist/invalid-config.json', value);
    const result = spawnSync(process.execPath, ['dist/node-api.mjs'], { env: { ...env, MAILSTACK_CONFIG: 'dist/invalid-config.json' }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain(value === '{' ? 'invalid JSON' : '$.sender.type');
  }
}, 15000);
