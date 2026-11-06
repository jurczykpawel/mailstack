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
