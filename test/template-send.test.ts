import { afterEach, expect, it, vi } from 'vitest';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema.ts';
import { templatePlans } from '../src/templates/config.ts';
import { memoryStore } from './store-fixture.ts';
import type { Env, SendParams } from '../src/types.ts';
afterEach(() => { vi.doUnmock('../src/core/config'); vi.resetModules(); });
it.each([true, false])('handles public and trusted locale with languages=%s', async languages => {
  const cfg = parseConfig({ ...structuredClone(example), mailTemplates: { version: 1, templates: {
    contact: { locales: { en: { subject: 'English form' } } }, received: { locales: { en: { subject: 'Received', heading: 'Thank you' } } },
  } }, brands: { acme: { ...example.brands.acme, mailTemplates: languages ? { languages: { default: 'pl', allowed: ['pl', 'en'] } } : {} } } });
  vi.doMock('../src/core/config', () => ({ config: cfg, compiledTemplates: templatePlans(cfg), getBrand: (id: string) => cfg.brands[id], findBrandByOrigin: () => cfg.brands.acme }));
  const { handleSend } = await import('../src/send.ts');
  const delivered: SendParams[] = [], tasks: Promise<unknown>[] = [];
  const deps = { store: memoryStore(), verifyAltcha: async () => true, verifyTurnstile: async () => true, now: () => new Date('2026-11-06T10:00:00Z'), waitUntil: (task: Promise<unknown>) => { tasks.push(task); }, sendEmail: async (_env: Env, mail: SendParams) => { delivered.push(mail); return { ok: true, status: 200 }; } };
  const env = { API_KEY: 'key', TURNSTILE_SECRET: 'test', SES_REGION: 'eu-west-1' } as Env;
  for (const trusted of [false, true]) {
    const response = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { origin: 'https://acme.example', ...(trusted ? { authorization: 'Bearer key' } : {}) }, body: JSON.stringify({ brand: 'acme', email: 'person@example.com', name: ' Jane ', locale: 'EN-us', 'cf-turnstile-response': 'test', to: trusted ? 'buyer@example.com' : 'ignored@example.com', template: trusted ? 'contact' : 'payment' }) }), env, deps);
    expect(response.status).toBe(200); await Promise.all(tasks);
  }
  expect(delivered).toHaveLength(3);
  expect(delivered[0].to).toEqual(cfg.brands.acme.to); expect(delivered[1].to).toEqual(['person@example.com']);
  expect(delivered[0].html).toContain(languages ? 'lang="en"' : 'lang="pl"');
  expect(delivered[0].text.includes('Locale: EN-us')).toBe(!languages);
  expect(delivered[1].subject).toBe(languages ? 'Received' : 'Potwierdzenie: otrzymaliśmy Twoje zgłoszenie');
  expect(delivered[2].to).toEqual(['buyer@example.com']);
});

it('stores the selected archive with configured private fields and existing indexes', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { createSqliteStore } = await import('../src/core/store/sqlite.ts');
  const { open } = await import('../src/core/crypto/index.ts');
  const cfg = parseConfig({ ...structuredClone(example), logging: { ...structuredClone(example.logging), defaults: { ...example.logging.defaults, level: 'full' } }, mailTemplates: { version: 1, templates: {
    contact: { fields: { credential: { kind: 'text' }, customEmail: { kind: 'email' } }, secretFields: ['credential'], locales: { en: { subject: 'Form received', heading: 'Message' } } },
  } }, brands: { acme: { ...example.brands.acme, mailTemplates: { languages: { default: 'pl', allowed: ['pl', 'en'] } } } } });
  vi.doMock('../src/core/config', () => ({ config: cfg, compiledTemplates: templatePlans(cfg), getBrand: (id: string) => cfg.brands[id], findBrandByOrigin: () => cfg.brands.acme }));
  const { renderAndSend } = await import('../src/send.ts');
  const { getTemplate } = await import('../src/templates/index.ts');
  const pair = generateKeyPairSync('x25519'), privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' };
  const env = { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]) } as Env;
  const store = createSqliteStore(':memory:'); await store.migrate();
  try {
    const result = await renderAndSend({ store, logging: cfg.logging, now: () => new Date('2026-11-06T10:00:00Z'), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn(), sendEmail: async () => ({ ok: true, status: 200 }) }, env, cfg.brands.acme, getTemplate('contact')!, { credential: '  VALUE-123456  ', name: 'VALUE-123456', customEmail: 'custom@example.com' }, { to: ['buyer@example.com'], locale: 'en' });
    expect(result.ok).toBe(true);
    const row = await store.db.selectFrom('contents').selectAll().executeTakeFirstOrThrow();
    const archive = await open(row.sealed, { brand: 'acme', messageId: result.id!, purpose: 'content' }, [privateKey]);
    expect(JSON.stringify(archive)).not.toContain('VALUE-123456'); expect(archive).toMatchObject({ metadata: { render: { locale: 'en' } } });
    const subjects = await store.db.selectFrom('subjects').selectAll().execute(); expect(subjects).toHaveLength(1); expect(subjects[0].role).toBe('recipient');
  } finally { await store.db.destroy(); }
});
