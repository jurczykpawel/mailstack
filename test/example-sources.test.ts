import { readFileSync, readdirSync } from 'node:fs';
import { expect, it, afterEach, vi } from 'vitest';
import { config } from '../src/core/config';
import { createApp } from '../src/index';
import { parseConfig } from '../src/core/config/schema';
import example from '../config/mailstack.example.json';
const original = structuredClone(config);
afterEach(() => Object.assign(config, structuredClone(original)));
it('delivers every Bruno Sellf example according to its declared status and rendered contract', async () => {
  Object.assign(config, parseConfig({ ...example, logging: { ...example.logging, defaults: { ...example.logging.defaults, level: 'none' } }, legacyApiKey: { enabled: true } }));
  for (const file of readdirSync('bruno/sellf-webhook').filter(f => f.endsWith('.bru'))) {
    const text = readFileSync(`bruno/sellf-webhook/${file}`, 'utf8');
    const body = JSON.parse(text.match(/body:json \{\n([\s\S]*?)\n\}/)![1]);
    const sendEmail = vi.fn(async () => ({ ok: true as const, status: 200 }));
    const response = await createApp({ sendEmail }).fetch(new Request('https://local.example/v1/hooks/sellf?brand=acme', {
      method: 'POST', body: JSON.stringify(body), headers: text.includes('auth: none') ? {} : { authorization: 'Bearer local-token' },
    }), { API_KEY: 'local-token' } as any, {} as ExecutionContext);
    expect(response.status, file).toBe(Number(text.match(/res.status: eq (\d+)/)![1]));
    if (body.event === 'refund.issued') {
      expect(sendEmail).toHaveBeenCalledOnce();
      const params = (sendEmail.mock.calls as unknown as [unknown, { text: string }][])[0][1];
      for (const value of ['49.99 USD', 'Zakres zwrotu: pełny.', 're_test_123', 'pay_test_123']) expect(params.text).toContain(value);
    }
  }
});
it('keeps example source registries and README source snippets valid', () => {
  const preset = JSON.parse(readFileSync('docs/sources/sellf.json', 'utf8'));
  expect(parseConfig(example).sources?.sellf).toEqual(preset);
  const readme = readFileSync('README.md', 'utf8');
  for (const match of readme.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    if (!match[1].includes('"sources"')) continue;
    const value = JSON.parse(match[1]);
    if (value.sources) expect(() => parseConfig({ ...example, sources: value.sources })).not.toThrow();
  }
});
