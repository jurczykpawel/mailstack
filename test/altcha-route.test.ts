import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const env = { ALTCHA_HMAC_KEY: 'k'.repeat(40) } as any;
const ctx = {} as any;

describe('GET /altcha/challenge', () => {
  it('returns a challenge for an allowed origin', async () => {
    const req = new Request('https://mailer.techskills.academy/altcha/challenge?brand=tsa', {
      headers: { origin: 'https://techskills.academy' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { algorithm: string; challenge: string };
    expect(body.algorithm).toBe('SHA-256');
    expect(typeof body.challenge).toBe('string');
  });

  it('403 for a disallowed origin', async () => {
    const req = new Request('https://mailer.techskills.academy/altcha/challenge?brand=tsa', {
      headers: { origin: 'https://evil.example' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });
});
