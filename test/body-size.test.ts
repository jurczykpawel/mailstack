import { describe, expect, it, vi } from 'vitest';
import { handleSend } from '../src/send';
import { handleSellfHook } from '../src/sellf';
import type { Env, SendDeps } from '../src/types';
import { memoryStore } from './store-fixture';

const env: Env = {
  SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: 'test', SES_SECRET_ACCESS_KEY: 'test',
  TURNSTILE_SECRET: 'test', API_KEY: 'test-token', ALTCHA_HMAC_KEY: 'test',
};

function streamRequest(path: string, text: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset + 997));
    offset = Math.min(offset + 997, bytes.length);
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request(`https://mail.example.com${path}`, {
    method: 'POST', headers, body, duplex: 'half',
  } as RequestInit);
  return { request, pull, cancel };
}

for (const mode of ['public', 'trusted', 'sellf'] as const) {
  describe(`${mode} request size`, () => {
    function setup(size: number, declared?: string) {
      const body = mode === 'sellf'
        ? { event: 'lead.captured', data: { customer: { email: 'buyer@example.com' }, product: { name: 'Demo' } } }
        : { brand: 'acme', autoreply: false, 'cf-turnstile-response': 'token' };
      const base = JSON.stringify({ ...body, _meta: '' });
      const padding = size - new TextEncoder().encode(base).length;
      const text = base.slice(0, -2) + 'ą'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2) + '"}';
      expect(new TextEncoder().encode(text).length).toBe(size);
      const input = streamRequest(mode === 'sellf' ? '/v1/hooks/sellf?brand=acme' : '/v1/send', text, {
        ...(mode === 'public' ? { origin: 'https://acme.example' } : { authorization: 'Bearer test-token' }),
        ...(declared ? { 'content-length': declared } : {}),
      });
      const store = memoryStore();
      const insert = vi.spyOn(store, 'insertMessage');
      const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
      const deps: SendDeps = { store, sendEmail, verifyTurnstile: vi.fn(async () => true), verifyAltcha: vi.fn(async () => true), now: () => new Date() };
      return { ...input, insert, sendEmail, run: () => (mode === 'sellf' ? handleSellfHook : handleSend)(input.request, env, deps) };
    }
    it('returns 413 for 66050 streamed bytes before delivery', async () => {
      const test = setup(66050);
      expect(test.request.headers.has('content-length')).toBe(false);
      const response = await test.run();
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ success: false, message: 'payload too large' });
      expect(test.insert).not.toHaveBeenCalled();
      expect(test.sendEmail).not.toHaveBeenCalled();
      expect(test.cancel).toHaveBeenCalledOnce();
    });
    it.each([65450, 65536])('accepts %i streamed bytes', async size => {
      const test = setup(size);
      expect((await test.run()).status).toBe(200);
      expect(test.sendEmail).toHaveBeenCalledOnce();
    });
    it('checks Content-Length before reading', async () => {
      const test = setup(1000, '65537');
      expect((await test.run()).status).toBe(413);
      expect(test.pull).not.toHaveBeenCalled();
      expect(test.insert).not.toHaveBeenCalled();
      expect(test.sendEmail).not.toHaveBeenCalled();
    });
  });
}

describe('bounded text', () => {
  it('decodes UTF-8 across chunk boundaries', async () => {
    const { boundedText } = await import('../src/core/http');
    const { request } = streamRequest('/test', 'ą'.repeat(1000));
    expect(await boundedText(request, 2000)).toBe('ą'.repeat(1000));
  });
  it('cancels a longer stream at the first chunk over the limit', async () => {
    const { boundedText } = await import('../src/core/http');
    const test = streamRequest('/test', 'ą'.repeat(100000));
    await expect(boundedText(test.request, 65536)).rejects.toBeInstanceOf(RangeError);
    expect(test.pull).toHaveBeenCalledTimes(66);
    expect(test.cancel).toHaveBeenCalledOnce();
    expect(test.request.body?.locked).toBe(false);
  });
  it.each([262144, 262145])('uses the 256 KiB limit for %i response bytes', async size => {
    const { boundedText } = await import('../src/core/http');
    const { request } = streamRequest('/test', 'ą'.repeat(Math.floor(size / 2)) + 'x'.repeat(size % 2));
    const result = boundedText(new Response(request.body), 256 * 1024);
    if (size > 262144) await expect(result).rejects.toBeInstanceOf(RangeError);
    else expect(new TextEncoder().encode(await result).length).toBe(size);
  });
});
