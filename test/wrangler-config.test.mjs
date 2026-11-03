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
    expect(readFileSync('.wrangler/migrations/0006_domain_events.sql', 'utf8')).toMatch(/cause +TEXT NOT NULL UNIQUE[\s\S]*ext_event_cursor[\s\S]*ext_event_gaps/);
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, SES_CONFIGURATION_SET: '' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('SES_CONFIGURATION_SET = ""');
  } finally { writeFileSync('wrangler.toml', previous); }
});
it('adds the internal host as a second custom domain and disables workers.dev', () => {
  const env = { ...process.env, MAILSTACK_ROUTE: 'mail.example.com', MAILSTACK_INTERNAL_ROUTE: 'internal.example.com', MAILSTACK_D1_ID: 'PLACEHOLDER_D1_ID',
    MAILSTACK_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', MAILSTACK_ACCESS_AUD: 'a'.repeat(64) };
  const previous = readFileSync('wrangler.toml', 'utf8');
  try {
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env, stdio: 'pipe' });
    const out = readFileSync('wrangler.toml', 'utf8');
    for (const line of ['workers_dev = false', 'preview_urls = false', 'INTERNAL_HOST = "internal.example.com"',
      '{ pattern = "mail.example.com", custom_domain = true }', '{ pattern = "internal.example.com", custom_domain = true }',
      'ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"', `ACCESS_AUD = "${'a'.repeat(64)}"`]) expect(out).toContain(line);
    for (const change of [{ MAILSTACK_ROUTE: '' }, { MAILSTACK_ACCESS_TEAM_DOMAIN: '' }, { MAILSTACK_ACCESS_AUD: ' ' },
      { MAILSTACK_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }, { MAILSTACK_ACCESS_TEAM_DOMAIN: 'evil.example.com' }]) {
      expect(() => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, ...change }, stdio: 'pipe' })).toThrow();
    }
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_INTERNAL_ROUTE: '', MAILSTACK_ACCESS_TEAM_DOMAIN: '', MAILSTACK_ACCESS_AUD: '' }, stdio: 'pipe' });
    for (const line of ['INTERNAL_HOST = ""', 'ACCESS_TEAM_DOMAIN = ""', 'ACCESS_AUD = ""']) expect(readFileSync('wrangler.toml', 'utf8')).toContain(line);
  } finally { writeFileSync('wrangler.toml', previous); }
});
it('adds the egress container and its binding only with MAILSTACK_EGRESS=1 on a Pro build', async () => {
  const { egressToml } = await import('../scripts/wrangler-egress.mjs');
  const on = egressToml('1', '/pro');
  for (const line of ['new_sqlite_classes = ["EgressContainer"]', '[[containers]]', 'image = "/pro/Dockerfile.egress"', 'image_build_context = "/pro"',
    'instance_type = "lite"', 'max_instances = 1', 'name = "EGRESS"']) expect(on).toContain(line);
  // Pro without egress keeps the class migration (rollback needs no delete migration), but no container or binding.
  for (const flag of ['', ' ', '0', undefined]) expect(egressToml(flag, '/pro')).toMatch(/^\[\[migrations\]\]\ntag = "egress-v1"\nnew_sqlite_classes = \["EgressContainer"\]\n$/);
  expect(egressToml('', undefined)).toBe('');
  expect(() => egressToml('1', undefined)).toThrow('requires a Mailstack Pro build');
  expect(() => egressToml('yes', '/pro')).toThrow('MAILSTACK_EGRESS must be');
  const previous = readFileSync('wrangler.toml', 'utf8'), env = { ...process.env, MAILSTACK_ROUTE: '', MAILSTACK_INTERNAL_ROUTE: '', MAILSTACK_PRO_PATH: '' };
  try {
    expect(() => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_EGRESS: '1' }, stdio: 'pipe' })).toThrow();
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_EGRESS: '' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).not.toMatch(/containers|EgressContainer|__EGRESS__/);
  } finally { writeFileSync('wrangler.toml', previous); }
});
