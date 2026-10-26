import { expect, it } from 'vitest';
import { resendPayload } from '../src/core/resend-contract';

it('accepts the stored payload shape and bounds all fields', () => {
  const payload = { to: ['buyer@example.com'], template: 'notice', data: { paragraphs: 'Hello' } };
  expect(resendPayload.parse(payload)).toEqual(payload);
  for (const change of [{ to: [] }, { to: ['invalid'] }, { cc: ['other@example.com'] }, { data: { body: 'x'.repeat(5001) } }, { template: '' }, { extra: true }]) {
    expect(resendPayload.safeParse({ ...payload, ...change }).success).toBe(false);
  }
});
