import { expect, it, vi } from 'vitest';
import { createSmtpSender } from '../src/adapters/sender/smtp';
import type { Env, SendParams } from '../src/types';
const params: SendParams = { from: 'info@example.com', to: ['buyer@example.com'], subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' };
const env = {} as Env;
it('returns the final reply and queue identifier', async () => {
  const sendMail = vi.fn().mockResolvedValue({ response: '250 2.0.0 queued as queue-1', accepted: params.to, rejected: [], messageId: '<local@example.com>' });
  const sender = createSmtpSender({ sendMail });
  expect(await sender(env, params)).toMatchObject({ ok: true, status: 250, messageId: 'queue-1', smtp: { accepted: params.to }, response: { response: '250 2.0.0 queued as queue-1' } });
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0][0]).toMatchObject({ ...params, disableFileAccess: true, disableUrlAccess: true });
});
it.each([450, 550])('returns an explicit %s refusal once', async responseCode => {
  const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error('refused'), { responseCode, response: `${responseCode} refused` }));
  expect(await createSmtpSender({ sendMail })(env, params)).toEqual({ ok: false, status: responseCode, response: { response: `${responseCode} refused` } });
  expect(sendMail).toHaveBeenCalledTimes(1);
});
it('leaves a network outcome uncertain', async () => {
  const sendMail = vi.fn().mockRejectedValue(new Error('connection closed'));
  await expect(createSmtpSender({ sendMail })(env, params)).rejects.toThrow('connection closed');
  expect(sendMail).toHaveBeenCalledTimes(1);
});
it('keeps partial acceptance successful and reports only accepted recipients', async () => {
  const result = await createSmtpSender({ sendMail: vi.fn().mockResolvedValue({ response: '250 OK: queue-2', accepted: params.to, rejected: ['other@example.com'] }) })(env, { ...params, to: [...params.to, 'other@example.com'] });
  expect(result).toMatchObject({ ok: true, messageId: 'queue-2', smtp: { accepted: params.to, rejected: ['other@example.com'] } });
});
it('extracts a Mailpit queue identifier from its final reply', async () => {
  const result = await createSmtpSender({ sendMail: vi.fn().mockResolvedValue({ response: '250 2.0.0 Ok: queued as mailpit-1', accepted: params.to, rejected: [] }) })(env, params);
  expect(result.messageId).toBe('mailpit-1');
});
it('requires SMTP connection configuration at startup', async () => {
  const { smtpFromEnv } = await import('../src/adapters/sender/smtp');
  for (const env of [{}, { SMTP_URL: 'https://example.com' }, { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '0' }, { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'user' }]) expect(() => smtpFromEnv(env)).toThrow();
});
it('uses URL connection values with a single bounded SMTP transport', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const create = vi.spyOn(nodemailer, 'createTransport');
  const { smtpFromEnv } = await import('../src/adapters/sender/smtp');
  try {
    smtpFromEnv({ SMTP_URL: 'smtps://user:p%40ss@smtp.example.com:465?pool=true' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'user', pass: 'p@ss' }, pool: false, socketTimeout: 30000 }));
  } finally { create.mockRestore(); }
});
