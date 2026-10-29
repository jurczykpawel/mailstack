import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('passes the optional SES configuration set through generated vars', () => {
  const env = { ...process.env, MAILSTACK_ROUTE: '', SELLF_DEFAULT_BRAND: 'acme', MAILSTACK_D1_ID: 'PLACEHOLDER_D1_ID', MAILSTACK_D1_PREVIEW_ID: 'PLACEHOLDER_D1_PREVIEW_ID' };
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
