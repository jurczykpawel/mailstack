import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { tokenSha256 } from '../src/clients';
import { config } from '../src/core/config';
import { handleSend } from '../src/send';
import { sendEmail } from '../src/ses';
import { createSmtpSender } from '../src/adapters/sender/smtp';
import type { Env, SendDeps } from '../src/types';

const env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: 'test', SES_SECRET_ACCESS_KEY: 'test' } as Env;
const pdf = { filename: 'receipt.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7\nfile sentinel').toString('base64') };
const body = { brand: 'acme', template: 'notice', heading: 'Hello', attachments: [pdf] };
const legacy = config.legacyApiKey;
let deps: SendDeps;
beforeEach(() => {
  config.legacyApiKey = { enabled: true, env: 'API_KEY', scopes: ['send'], brands: '*', templates: '*', recipientOverride: true, attachments: true };
  deps = { logging: structuredClone(config.logging), sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    verifyTurnstile: vi.fn().mockResolvedValue(true), verifyAltcha: vi.fn(), now: () => new Date() };
  deps.logging!.defaults.level = 'none';
});
afterEach(() => { config.legacyApiKey = legacy; vi.restoreAllMocks(); });
const run = (data: object = body, authorization = 'Bearer test-key') => handleSend(new Request('https://mail.example/v1/send', {
  method: 'POST', headers: { authorization, origin: 'https://acme.example' }, body: JSON.stringify(data),
}), env, deps);

it('delivers validated files only to an enabled sender', async () => {
  expect((await run()).status).toBe(200);
  expect(deps.sendEmail).toHaveBeenCalledWith(env, expect.objectContaining({ attachments: [pdf] }));
  config.legacyApiKey!.attachments = false;
  const res = await run();
  expect(res.status).toBe(403); expect(await res.json()).toMatchObject({ code: 'scope' });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});
it('keeps public attachments outside the send payload', async () => {
  expect((await run({ ...body, autoreply: false }, 'Bearer invalid')).status).toBe(200);
  expect(vi.mocked(deps.sendEmail).mock.calls[0][1].attachments).toBeUndefined();
});
it.each([
  null, {}, [null], [{ ...pdf, filename: undefined }], [{ ...pdf, contentType: undefined }],
  [{ ...pdf, contentBase64: 12 }], Array(6).fill(pdf),
  ...['../file.pdf', 'a/b.pdf', 'file.exe', 'x'.repeat(101) + '.pdf', 'file.pdf\n', 'file.png', 'txt'].map(filename => [{ ...pdf, filename }]),
  ...['abc', '!!!!', 'JVBE Rg==', 'JVBERg===', 'Zh==', 'Zm9=', 'JVBERg==\n'].map(contentBase64 => [{ ...pdf, contentBase64 }]),
  [{ ...pdf, contentBase64: Buffer.from('plain text').toString('base64') }],
  [{ filename: 'a.png', contentType: 'image/png', contentBase64: pdf.contentBase64 }],
  [{ filename: 'a.jpg', contentType: 'image/jpeg', contentBase64: pdf.contentBase64 }],
])('returns 422 for invalid attachment input %#', async attachments => {
  const res = await run({ ...body, attachments });
  expect(res.status).toBe(422); expect(await res.json()).toMatchObject({ code: 'attachment_invalid', message: 'invalid attachment' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it.each(['application/zip', 'text/html', 'APPLICATION/PDF', 'constructor'])('returns 415 for %s', async contentType => {
  const res = await run({ ...body, attachments: [{ ...pdf, contentType }] });
  expect(res.status).toBe(415); expect(await res.json()).toMatchObject({ code: 'attachment_type', message: 'attachment type not allowed' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it.each([
  ['a.png', 'image/png', Buffer.from([137,80,78,71,13,10,26,10])], ['a.jpeg', 'image/jpeg', Buffer.from([255,216,255])],
  ['a.jpg', 'image/jpeg', Buffer.from([255,216,255])], ['a.txt', 'text/plain', Buffer.from('hello')],
  ['a.csv', 'text/csv', Buffer.from('a,b')], ['a.ics', 'text/calendar', Buffer.from('BEGIN:VCALENDAR')],
  ['a.xml', 'application/xml', Buffer.from('<a/>')], ['a.xml', 'text/xml', Buffer.from('<a/>')],
] as const)('accepts %s with its matching type', async (filename, contentType, bytes) => {
  expect((await run({ ...body, attachments: [{ filename, contentType, contentBase64: bytes.toString('base64') }] })).status).toBe(200);
});
it('accepts five files and an empty list', async () => {
  for (const attachments of [Array(5).fill(pdf), []]) expect((await run({ ...body, attachments })).status).toBe(200);
});
it.each([7 * 1024 * 1024, 7 * 1024 * 1024 + 1])('bounds decoded bytes at %i', async size => {
  const res = await run({ ...body, attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.alloc(size, 65).toString('base64') }] });
  expect(res.status).toBe(size === 7 * 1024 * 1024 ? 200 : 422);
});
it('applies the decoded cap across files', async () => {
  const file = { filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.alloc(4 * 1024 * 1024).toString('base64') };
  const res = await run({ ...body, attachments: [file, file] });
  expect(res.status).toBe(413);
  const smaller = { ...file, contentBase64: Buffer.alloc(3700000).toString('base64') };
  expect((await run({ ...body, attachments: [smaller, smaller] })).status).toBe(422);
});
it.each([true, false])('uses a bounded stream with attachments permission=%s', async enabled => {
  config.legacyApiKey!.attachments = enabled;
  const limit = enabled ? 10 * 1024 * 1024 : 65536;
  let read = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream({ pull(c) { read++; c.enqueue(new Uint8Array(65536)); }, cancel }, { highWaterMark: 0 });
  const req = new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer test-key' }, body: stream, duplex: 'half' } as RequestInit);
  const res = await handleSend(req, env, deps);
  expect(res.status).toBe(413); expect(read).toBe(limit / 65536 + 1); expect(cancel).toHaveBeenCalledOnce();
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it('uses 64 KiB for an invalid bearer and checks declared length before reads', async () => {
  const pull = vi.fn();
  const req = new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-length': '65537' },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
  expect((await handleSend(req, env, deps)).status).toBe(413); expect(pull).not.toHaveBeenCalled();
});
it.each([10 * 1024 * 1024, 10 * 1024 * 1024 + 1])('bounds the trusted request at %i bytes', async size => {
  const base = JSON.stringify({ ...body, _meta: '' });
  const text = base.slice(0, -2) + ' '.repeat(size - base.length) + '"}';
  const res = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer test-key' }, body: text }), env, deps);
  expect(res.status).toBe(size === 10 * 1024 * 1024 ? 200 : 413);
});
it('sends a PDF using the SES simple attachment fields', async () => {
  const fetch = vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response('{"MessageId":"ses-1"}'));
  deps.sendEmail = sendEmail;
  expect((await run()).status).toBe(200);
  const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(payload.Content.Simple.Attachments).toEqual([{ FileName: pdf.filename, RawContent: pdf.contentBase64, ContentType: pdf.contentType,
    ContentDisposition: 'ATTACHMENT', ContentTransferEncoding: 'BASE64' }]);
});
it('passes decoded buffers to the SMTP transport', async () => {
  const sendMail = vi.fn().mockResolvedValue({ response: '250 queued as queue-1', accepted: ['info@acme.example'], rejected: [] });
  deps.sendEmail = createSmtpSender({ sendMail });
  expect((await run()).status).toBe(200);
  expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ disableFileAccess: true, disableUrlAccess: true,
    attachments: [{ filename: pdf.filename, contentType: pdf.contentType, content: Buffer.from(pdf.contentBase64, 'base64') }] }));
});

it('requires send, brand, template and attachment permissions for a configured client', async () => {
  const token = 'msk_files_' + 'a'.repeat(43);
  const previous = config.clients;
  const client = { id: 'files', tokenSha256: await tokenSha256(token), scopes: ['send' as const], brands: ['acme'], templates: ['notice'], recipientOverride: false, attachments: true };
  try {
    config.clients = [client];
    expect((await run(body, `Bearer ${token}`)).status).toBe(200);
    for (const change of [{ attachments: false }, { scopes: [] }, { brands: [] }, { templates: [] }]) {
      config.clients = [{ ...client, ...change }];
      const res = await run(body, `Bearer ${token}`);
      expect(res.status).toBe(403); expect(await res.json()).toMatchObject({ code: 'scope' });
    }
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  } finally { config.clients = previous; }
});
