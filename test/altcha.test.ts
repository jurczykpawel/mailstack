import { describe, it, expect } from 'vitest';
import { createChallenge, verifyAltcha } from '../src/altcha';

const KEY = 'test-hmac-key-at-least-32-bytes-long-xx';

async function solve(ch: { salt: string; challenge: string; algorithm: string; maxnumber: number; signature: string }, _key: string) {
  // brute force the number whose SHA-256(salt+number) === challenge
  const enc = new TextEncoder();
  for (let n = 0; n <= ch.maxnumber; n++) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(ch.salt + n));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === ch.challenge) {
      const payload = { algorithm: ch.algorithm, challenge: ch.challenge, number: n, salt: ch.salt, signature: ch.signature };
      return btoa(JSON.stringify(payload));
    }
  }
  throw new Error('unsolved');
}

describe('altcha', () => {
  it('verifies a correctly solved challenge', async () => {
    const ch = await createChallenge(KEY, { maxnumber: 1000 });
    const sol = await solve(ch, KEY);
    expect(await verifyAltcha(KEY, sol)).toBe(true);
  });

  it('rejects a tampered number', async () => {
    const ch = await createChallenge(KEY, { maxnumber: 1000 });
    const bad = btoa(JSON.stringify({ algorithm: 'SHA-256', challenge: ch.challenge, number: 999999, salt: ch.salt, signature: ch.signature }));
    expect(await verifyAltcha(KEY, bad)).toBe(false);
  });

  it('rejects a forged signature (wrong key)', async () => {
    const ch = await createChallenge(KEY, { maxnumber: 1000 });
    const sol = await solve(ch, KEY);
    expect(await verifyAltcha('a-different-key-also-32-bytes-long-xx', sol)).toBe(false);
  });

  it('rejects garbage payload', async () => {
    expect(await verifyAltcha(KEY, 'not-base64-json')).toBe(false);
  });
});
