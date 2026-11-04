import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('passes the optional SES configuration set through generated vars', () => {
  const env = { ...process.env, MAILSTACK_ROUTE: '', MAILSTACK_INTERNAL_ROUTE: '', SELLF_DEFAULT_BRAND: 'acme', MAILSTACK_D1_ID: 'PLACEHOLDER_D1_ID', MAILSTACK_D1_PREVIEW_ID: 'PLACEHOLDER_D1_PREVIEW_ID' };
  const previous = readFileSync('wrangler.toml', 'utf8');
  try {
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, SES_CONFIGURATION_SET: 'mail-events' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('SES_CONFIGURATION_SET = "mail-events"');
    expect(readFileSync('wrangler.toml', 'utf8').match(/^crons = .*$/gm)).toEqual(['crons = ["* * * * *"]']);
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
it('passes the egress service origin as a var and refuses anything but an https origin', () => {
  const previous = readFileSync('wrangler.toml', 'utf8'), env = { ...process.env, MAILSTACK_ROUTE: '', MAILSTACK_INTERNAL_ROUTE: '' };
  const gen = (url) => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_EGRESS_URL: url }, stdio: 'pipe' });
  try {
    gen('https://egress.example.com'); expect(readFileSync('wrangler.toml', 'utf8')).toContain('EGRESS_URL = "https://egress.example.com"');
    gen(''); const out = readFileSync('wrangler.toml', 'utf8');
    expect(out).toContain('EGRESS_URL = ""'); expect(out).not.toMatch(/containers|EgressContainer|durable_objects|__EGRESS__/);
    for (const bad of ['http://egress.example.com', 'https://egress.example.com/post', 'https://egress.example.com?x=1']) expect(() => gen(bad), bad).toThrow();
  } finally { writeFileSync('wrangler.toml', previous); }
});
it('N: the Worker entry exports the Internal entrypoint and passes only a valid panel audience', () => {
  const previous = readFileSync('wrangler.toml', 'utf8'), env = { ...process.env, MAILSTACK_ROUTE: '', MAILSTACK_INTERNAL_ROUTE: '' };
  const gen = (value) => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, MAILSTACK_PANEL_AUDIENCE: value }, stdio: 'pipe' });
  try {
    gen('mailstack.acme:1'); const out = readFileSync('wrangler.toml', 'utf8');
    expect(out).toContain('main = "src/worker.ts"'); expect(out).toContain('PANEL_AUDIENCE = "mailstack.acme:1"');
    for (const bad of ['a b', 'x"\nAPI_KEY = "y', 'a'.repeat(254)]) expect(() => gen(bad), bad).toThrow();
    // Profile (a) with the emergency internal route: the audience stays the one the panel Worker signs for.
    const route = { MAILSTACK_ROUTE: 'mail.example.com', MAILSTACK_INTERNAL_ROUTE: 'internal.example.com', MAILSTACK_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', MAILSTACK_ACCESS_AUD: 'aud' };
    execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, ...route, MAILSTACK_PANEL_AUDIENCE: 'internal.example.com' }, stdio: 'pipe' });
    expect(readFileSync('wrangler.toml', 'utf8')).toContain('PANEL_AUDIENCE = "internal.example.com"');
    expect(() => execFileSync(process.execPath, ['scripts/gen-wrangler.mjs'], { env: { ...env, ...route, MAILSTACK_PANEL_AUDIENCE: 'mailstack.acme:1' }, stdio: 'pipe' })).toThrow(/must equal MAILSTACK_INTERNAL_ROUTE/);
  } finally { writeFileSync('wrangler.toml', previous); }
});
