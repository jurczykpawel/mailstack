import { afterEach, expect, it, vi } from 'vitest';
import { sendCloudflare } from '../src/adapters/sender/cloudflare';
import type { Env, SendParams } from '../src/types';

const params: SendParams = { from: 'Acme <info@acme.example>', to: ['owner@acme.example'], replyTo: 'jane@example.com',
  subject: 'Subject', html: '<p>Body</p>', text: 'Body', messageId: 'msg_1', brand: 'acme' };
const envWith = (send: (message: unknown) => Promise<unknown>) => ({ EMAIL: { send } }) as unknown as Env;
const refusal = (code: string) => Object.assign(new Error(`${code} detail for owner@acme.example`), { code });
afterEach(() => vi.restoreAllMocks());

it('sends through the binding and records the provider message id', async () => {
  const send = vi.fn().mockResolvedValue({ messageId: 'cf-1' });
  expect(await sendCloudflare(envWith(send), params)).toEqual({ ok: true, status: 200, messageId: 'cf-1', response: { messageId: 'cf-1' } });
  expect(send).toHaveBeenCalledWith({ from: { email: 'info@acme.example', name: 'Acme' }, to: ['owner@acme.example'],
    replyTo: 'jane@example.com', subject: 'Subject', html: '<p>Body</p>', text: 'Body' });
});

it('passes a bare sender address and decoded attachments', async () => {
  const send = vi.fn().mockResolvedValue({ messageId: 'cf-2' });
  await sendCloudflare(envWith(send), { ...params, from: 'info@acme.example', replyTo: undefined,
    attachments: [{ filename: 'note.txt', contentType: 'text/plain', contentBase64: 'SGVsbG8=' }] });
  const message = send.mock.calls[0][0];
  expect(message.from).toBe('info@acme.example');
  expect(message).not.toHaveProperty('replyTo');
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]).toMatchObject({ filename: 'note.txt', type: 'text/plain', disposition: 'attachment' });
  expect(new TextDecoder().decode(message.attachments[0].content)).toBe('Hello');
});

it('turns a coded refusal into an explicit failure with a readable diagnostic', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await sendCloudflare(envWith(() => Promise.reject(refusal('E_RECIPIENT_PLAN_RESTRICTED'))), params);
  expect(result).toEqual({ ok: false, status: 403, response: { code: 'E_RECIPIENT_PLAN_RESTRICTED' } });
  const line = String(error.mock.calls[0][0]);
  expect(line).toContain('E_RECIPIENT_PLAN_RESTRICTED');
  expect(line).toContain('verified destination');
  expect(line).not.toContain('owner@acme.example');
});

it('maps limits and unknown codes to refusals', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await sendCloudflare(envWith(() => Promise.reject(refusal('E_DAILY_LIMIT_EXCEEDED'))), params)).toMatchObject({ ok: false, status: 429 });
  expect(await sendCloudflare(envWith(() => Promise.reject(refusal('E_SENDER_NOT_VERIFIED'))), params)).toMatchObject({ ok: false, status: 403 });
  expect(await sendCloudflare(envWith(() => Promise.reject(refusal('E_NEW_CODE'))), params)).toMatchObject({ ok: false, status: 400 });
});

it('leaves an uncertain outcome to the caller', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(sendCloudflare(envWith(() => Promise.reject(refusal('E_INTERNAL_SERVER_ERROR'))), params)).rejects.toThrow();
  await expect(sendCloudflare(envWith(() => Promise.reject(new Error('network'))), params)).rejects.toThrow('network');
});

it('refuses without the binding and names it', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await sendCloudflare({} as Env, params)).toMatchObject({ ok: false, status: 500 });
  expect(String(error.mock.calls[0][0])).toMatch(/send_email binding EMAIL/);
});
