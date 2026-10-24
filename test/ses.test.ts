import { afterEach, expect, it, vi } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { sendEmail } from '../src/ses';
import type { Env, SendParams } from '../src/types';
const env = { SES_REGION: 'eu-west-1', SES_CONFIGURATION_SET: 'mail-events', SES_ACCESS_KEY_ID: 'test', SES_SECRET_ACCESS_KEY: 'test' } as Env;
const params: SendParams = { from: 'from@example.com', to: ['to@example.com'], subject: 'Subject', html: '<p>Body</p>', text: 'Body', messageId: 'msg_123', brand: 'acme' };
afterEach(() => vi.restoreAllMocks());
it('returns the provider id and sends configuration and correlation tags', async () => {
  const fetch = vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200, headers: { 'x-test': 'header-value' } }));
  expect(await sendEmail(env, params)).toEqual({ ok: true, status: 200, messageId: 'ses-1', response: { MessageId: 'ses-1' } });
  const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(payload).toMatchObject({ ConfigurationSetName: 'mail-events', EmailTags: [{ Name: 'ms_id', Value: 'msg_123' }, { Name: 'ms_brand', Value: 'acme' }] });
  expect(payload).not.toHaveProperty('ConfigurationOverrides');
});
it('omits correlation configuration when no message row exists', async () => {
  const fetch = vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response('{}'));
  await sendEmail(env, { ...params, messageId: undefined });
  const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(payload).not.toHaveProperty('ConfigurationSetName'); expect(payload).not.toHaveProperty('EmailTags');
});
it('accepts a successful response with an empty body', async () => {
  vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response(''));
  expect(await sendEmail(env, params)).toMatchObject({ ok: true, status: 200 });
});

it('makes one provider request for an explicit refusal', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 500 })).mockResolvedValue(new Response('{}'));
  expect(await sendEmail(env, params)).toMatchObject({ ok: false, status: 500 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps an explicit refusal when its response body cannot be read', async () => {
  const response = new Response('{}', { status: 400 });
  vi.spyOn(response, 'text').mockRejectedValue(new Error('body unavailable'));
  vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(response);
  expect(await sendEmail(env, params)).toMatchObject({ ok: false, status: 400 });
});

it('reports the refusal status and provider type in one diagnostic line', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = { __type: 'AccessDeniedException', message: 'Denied for buyer@example.com', requestId: 'request-sentinel' };
  vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), { status: 403 }));
  expect(await sendEmail(env, params)).toMatchObject({ ok: false, status: 403, response });
  expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ status: 403, __type: 'AccessDeniedException' }));
  expect(JSON.stringify(error.mock.calls)).not.toContain('buyer@example.com');
  expect(JSON.stringify(error.mock.calls)).not.toContain('request-sentinel');
});

it.each(['Denied for buyer@example.com', JSON.stringify({ message: 'Denied for buyer@example.com' })])('reports only the status when the provider type is absent: %s', async body => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response(body, { status: 400 }));
  expect(await sendEmail(env, params)).toMatchObject({ ok: false, status: 400 });
  expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ status: 400 }));
});

it('does not emit a refusal diagnostic for a successful send', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AwsClient.prototype, 'fetch').mockResolvedValue(new Response('{}'));
  await sendEmail(env, params);
  expect(error).not.toHaveBeenCalled();
});
