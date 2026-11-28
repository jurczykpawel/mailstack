import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildConfig, formSnippet, origin, parseD1Id, parseWorkerUrl, slug } from '../scripts/init.mjs';

const answers = { name: 'Łódź Café', id: slug('Łódź Café'), site: origin('example.com/contact'), inbox: 'owner@example.com', from: 'no-reply@example.com' };

it('derives ids and the site origin from what the user types', () => {
  expect(answers.id).toBe('lodz-cafe');
  expect(slug('!!!')).toBe('form');
  expect(answers.site).toBe('https://example.com');
  expect(origin('http://localhost:4321/x')).toBe('http://localhost:4321');
});

it.each([['cloudflare', 'none'], ['ses', 'meta']])('builds a configuration the validator accepts without warnings (%s, %s)', (sender, level) => {
  const config = buildConfig({ ...answers, sender, level });
  expect(config.brands['lodz-cafe']).toMatchObject({ from: '"Łódź Café" <no-reply@example.com>', to: ['owner@example.com'], captcha: 'altcha',
    autoReply: false, allowedOrigins: ['https://example.com', 'https://www.example.com'] });
  expect(config.sources).toEqual({});
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-init-')), file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(process.execPath, ['scripts/mailstack.ts', 'config', 'check', file], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  } finally { rmSync(dir, { recursive: true }); }
}, 30000);

it('reads wrangler output', () => {
  expect(parseD1Id('[[d1_databases]]\nbinding = "DB"\ndatabase_id = "0f2ac74b-498b-4a2f-9e1d-1b2d3c4e5f60"')).toBe('0f2ac74b-498b-4a2f-9e1d-1b2d3c4e5f60');
  expect(parseD1Id('{ "binding": "DB", "database_id": "0f2ac74b-498b-4a2f-9e1d-1b2d3c4e5f60" }')).toBe('0f2ac74b-498b-4a2f-9e1d-1b2d3c4e5f60');
  expect(() => parseD1Id('error')).toThrow();
  expect(parseWorkerUrl('Deployed mailstack-acme triggers\n  https://mailstack-acme.demo.workers.dev\n')).toBe('https://mailstack-acme.demo.workers.dev');
});

it('prints a form bound to the brand and the API', () => {
  const html = formSnippet('https://mailstack-acme.demo.workers.dev', 'acme');
  expect(html).toContain('challengeurl="https://mailstack-acme.demo.workers.dev/altcha/challenge?brand=acme"');
  expect(html).toContain('fetch("https://mailstack-acme.demo.workers.dev/v1/send"');
  expect(html).toContain('name="botcheck"');
  expect(html).toMatch(/altcha@\d+\.\d+\.\d+/);
});
