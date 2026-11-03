import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('passes the optional SES configuration set through generated vars', () => {
  const env = { ...process.env, MAILSTACK_ROUTE: '', MAILSTACK_INTERNAL_ROUTE: '', SELLF_DEFAULT_BRAND: 'acme', MAILSTACK_D1_ID: 'PLACEHOLDER_D1_ID', MAILSTACK_D1_PREVIEW_ID: 'PLACEHOLDER_D1_PREVIEW_ID' };
  const previous = readFileSync('wrangler.toml', 'utf8');
  try {
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, SES_CONFIGURATION_SET: 'mail-events' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('SES_CONFIGURATION_SET = "mail-events"');
    expect(readFileSync('.wrangler/migrations/0002_ses_status.sql', 'utf8')).toContain('CREATE TABLE IF NOT EXISTS ses_status');
    expect(readFileSync('.wrangler/migrations/0001_initial.sql', 'utf8')).not.toContain('ses_status');
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, SES_CONFIGURATION_SET: '' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('SES_CONFIGURATION_SET = ""');
  } finally { writeFileSync('wrangler.toml', previous); }
});
it('adds the internal host as a second custom domain and disables workers.dev', () => {
  const env = { ...process.env, MAILSTACK_ROUTE: 'mail.example.com', MAILSTACK_INTERNAL_ROUTE: 'internal.example.com', MAILSTACK_D1_ID: 'PLACEHOLDER_D1_ID' };
  const previous = readFileSync('wrangler.toml', 'utf8');
  try {
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env, stdio: 'pipe' });
    const out = readFileSync('wrangler.toml', 'utf8');
    for (const line of ['workers_dev = false', 'preview_urls = false', 'INTERNAL_HOST = "internal.example.com"',
      '{ pattern = "mail.example.com", custom_domain = true }', '{ pattern = "internal.example.com", custom_domain = true }']) expect(out).toContain(line);
    expect(() => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_ROUTE: '' }, stdio: 'pipe' })).toThrow();
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_INTERNAL_ROUTE: '' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('INTERNAL_HOST = ""');
  } finally { writeFileSync('wrangler.toml', previous); }
});
