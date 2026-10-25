import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { createChallenge, verifyAltcha } from '../src/altcha';
import { config } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { createSqliteStore } from '../src/core/store/sqlite';
import { handleSend } from '../src/send';
import type { Env, SendDeps } from '../src/types';
import example from '../config/mailstack.example.json';

const KEY = 'test-form-nonce-key';
const PRODUCT = 'Demo Żółć';
const START = new Date('2026-10-25T12:00:00Z');
const env = { ALTCHA_HMAC_KEY: KEY, API_KEY: 'test-api-key' } as Env;
const original = structuredClone(config.brands);
let store: ReturnType<typeof createSqliteStore>;
let deps: SendDeps;
let tasks: Promise<unknown>[];

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(START);
  Object.assign(config.brands.demo, { requireNonce: true, products: [PRODUCT], autoReply: true });
  store = createSqliteStore(':memory:');
  await store.migrate();
  tasks = [];
  deps = { store, verifyAltcha: vi.fn(verifyAltcha), verifyTurnstile: vi.fn(async () => true),
    sendEmail: vi.fn(async () => ({ ok: true, status: 200 })), now: () => new Date(),
    waitUntil: task => { tasks.push(task); } };
});
afterEach(async () => {
  await Promise.all(tasks);
  await store.db.destroy();
  config.brands = structuredClone(original);
  vi.useRealTimers();
});

async function challenge(product: string | undefined = PRODUCT, brand = 'demo', origin = `https://${brand}.example`) {
  const url = new URL(`https://mail.example/altcha/challenge?brand=${brand}`);
  if (product !== undefined) url.searchParams.set('product', product);
  return createApp().fetch(new Request(url, { headers: { origin } }), env, {} as ExecutionContext);
}
async function submission() {
  const response = await challenge();
  expect(response.status).toBe(200);
  const body = await response.json() as { nonce: string; altcha: { algorithm: string } };
  expect(body).toEqual({ nonce: expect.any(String), altcha: expect.objectContaining({ algorithm: 'SHA-256' }) });
  const altcha = btoa(JSON.stringify({ ...await createChallenge(KEY, { maxnumber: 0 }), number: 0 }));
  return { brand: 'demo', email: 'viewer@example.com', nonce: body.nonce, altcha, autoreply: false };
}
function send(body: object, headers: Record<string, string> = {}) {
  return handleSend(new Request('https://mail.example/v1/send', { method: 'POST',
    headers: { origin: 'https://demo.example', ...headers }, body: JSON.stringify(body) }), env, deps);
}
async function declined(body: object) {
  const response = await send(body);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ success: false, message: 'verification failed' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
}

describe('send brand selection and early responses', () => {
  function post(body: string, query = '', origin = 'https://demo.example', headers = {}) {
    return handleSend(new Request(`https://mail.example/v1/send${query}`, {
      method: 'POST', headers: { origin, ...headers }, body,
    }), env, deps);
  }

  it.each([{}, { brand: '' }])('uses query brand before nonce verification: %j', async body => {
    const response = await post(JSON.stringify(body), '?brand=demo');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, message: 'verification failed' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://demo.example');
    expect(deps.verifyAltcha).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it.each(['', '?brand=', '?brand=acme'])('retains the body brand with query %s', async query => {
    const response = await post(JSON.stringify({ brand: 'acme', botcheck: 'filled' }), query, 'https://acme.example');
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://acme.example');
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('accepts a query brand for trusted sends without nonce', async () => {
    const response = await post('{}', '?brand=demo', '', { authorization: 'Bearer test-api-key' });
    expect(response.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  const errors = [
    { body: '{', query: '?brand=demo', status: 400, message: 'invalid JSON' },
    { body: '{', query: '', status: 400, message: 'invalid JSON' },
    { body: '[]', query: '?brand=demo', status: 400, message: 'invalid JSON' },
    { body: '{"brand":"unknown"}', query: '', status: 400, message: 'unknown brand' },
    { body: '{}', query: '', status: 400, message: 'unknown brand' },
    { body: 'x'.repeat(65537), query: '?brand=demo', status: 413, message: 'payload too large' },
    { body: 'x'.repeat(65537), query: '', status: 413, message: 'payload too large' },
    { body: '{"brand":"acme"}', query: '?brand=demo', status: 400, message: 'brand mismatch' },
    { body: '{"brand":"demo"}', query: '?brand=acme', status: 400, message: 'brand mismatch' },
    { body: '{"brand":"unknown"}', query: '?brand=demo', status: 400, message: 'brand mismatch' },
  ];
  it.each(errors)('adds CORS to $status $message ($query)', async ({ body, query, status, message }) => {
    const response = await post(body, query);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, message });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://demo.example');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
  it.each(errors)('omits CORS for an unlisted origin: $message ($query)', async ({ body, query, status, message }) => {
    const response = await post(body, query, 'https://other.example');
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, message });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});

describe('public form nonce', () => {
  it.each([false, undefined])('retains public content fields with requireNonce=%j', async requireNonce => {
    Object.assign(config.brands.demo, { requireNonce });
    const altcha = btoa(JSON.stringify({ ...await createChallenge(KEY, { maxnumber: 0 }), number: 0 }));
    expect((await send({ brand: 'demo', altcha, product: 'Content product', nonce: 'Content nonce', autoreply: false })).status).toBe(200);
    const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
    expect(mail.text).toContain('Product: Content product');
    expect(mail.text).toContain('Nonce: Content nonce');
  });
  it.each([true, false, undefined])('retains trusted content fields with requireNonce=%j', async requireNonce => {
    Object.assign(config.brands.demo, { requireNonce });
    expect((await send({ brand: 'demo', product: 'Content product', nonce: 'Content nonce' }, { authorization: 'Bearer test-api-key' })).status).toBe(200);
    const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
    expect(mail.text).toContain('Product: Content product');
    expect(mail.text).toContain('Nonce: Content nonce');
  });
  it.each([false, undefined])('preserves the flat challenge and submissions with requireNonce=%j', async requireNonce => {
    Object.assign(config.brands.demo, { requireNonce });
    const response = await challenge();
    expect(await response.json()).toEqual(expect.objectContaining({ algorithm: 'SHA-256' }));
    const altcha = btoa(JSON.stringify({ ...await createChallenge(KEY, { maxnumber: 0 }), number: 0 }));
    expect((await send({ brand: 'demo', altcha })).status).toBe(200);
  });
  it('maps the signed product to type and omits control fields', async () => {
    const body = await submission();
    expect((await send({ ...body, type: 'Other', product: PRODUCT })).status).toBe(200);
    const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
    expect(mail.subject).toContain(PRODUCT);
    expect(mail.text).toContain(PRODUCT);
    expect(mail.text).not.toContain(body.nonce);
    expect(mail.text).not.toMatch(/^(Nonce|Product):/m);
    expect(mail.html).not.toMatch(/<td[^>]*>\s*(Nonce|Product)\s*</i);
  });
  it('accepts marketing consent fields and passes them to the owner mail', async () => {
    const body = await submission();
    const response = await send({ ...body, marketingConsent: true, consentVersion: 'v1', consentText: 'I agree to news' });
    expect(response.status).toBe(200);
    const mail = vi.mocked(deps.sendEmail).mock.calls[0][1];
    expect(mail.text).toContain('I agree to news');
    expect(mail.text).toContain('v1');
  });
  it('accepts an unchecked marketing consent field', async () => {
    expect((await send({ ...await submission(), marketingConsent: false })).status).toBe(200);
  });
  it('uses the product from nonce when POST omits product', async () => {
    expect((await send(await submission())).status).toBe(200);
    expect(vi.mocked(deps.sendEmail).mock.calls[0][1].subject).toContain(PRODUCT);
  });
  it('accepts only the first use', async () => {
    const body = await submission();
    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(403);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, '', 42, {}, 'invalid'])('requires a valid nonce: %j', async nonce => {
    await declined({ ...await submission(), nonce });
  });
  it.each(['Other', null, 42, ''])('requires a matching POST product: %j', async product => {
    await declined({ ...await submission(), product });
  });
  it.each(['Other', '', 'x'.repeat(101)])('declines unlisted challenge product: %s', async product => {
    expect((await challenge(product)).status).toBe(400);
  });
  it('requires product in challenge query', async () => {
    const url = 'https://mail.example/altcha/challenge?brand=demo';
    expect((await createApp().fetch(new Request(url, { headers: { origin: 'https://demo.example' } }), env, {} as ExecutionContext)).status).toBe(400);
  });
  it('retains the challenge origin allowlist', async () => {
    expect((await challenge(PRODUCT, 'demo', 'https://other.example')).status).toBe(403);
  });
  it('returns the common public rejection for a different submit origin', async () => {
    const response = await send(await submission(), { origin: 'https://other.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, message: 'verification failed' });
    expect(deps.verifyAltcha).not.toHaveBeenCalled();
  });
  it('requires the nonce brand to match', async () => {
    Object.assign(config.brands.acme, { requireNonce: true, products: [PRODUCT] });
    const response = await challenge(PRODUCT, 'acme');
    const { nonce } = await response.json() as { nonce: string };
    await declined({ ...await submission(), nonce });
  });
  it('checks the current product list', async () => {
    const body = await submission();
    Object.assign(config.brands.demo, { products: ['Other'] });
    await declined(body);
  });
  it('ends validity at ten minutes', async () => {
    const body = await submission();
    vi.setSystemTime(new Date(START.getTime() + 600000));
    await declined(body);
  });
  it('requires the original signature', async () => {
    const body = await submission();
    const index = body.nonce.length - 1;
    body.nonce = body.nonce.slice(0, index) + (body.nonce[index] === 'a' ? 'b' : 'a');
    await declined(body);
  });
  it.each(['missing', 'write'])('returns 503 when storage is unavailable: %s', async failure => {
    const body = await submission();
    if (failure === 'missing') delete deps.store;
    else vi.spyOn(store, 'consume').mockRejectedValue(new Error('unavailable'));
    expect((await send(body)).status).toBe(503);
    expect(deps.verifyAltcha).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
  it('consumes nonce before checking ALTCHA and keeps its signed expiry', async () => {
    const body = await submission();
    const consume = vi.spyOn(store, 'consume');
    await declined({ ...body, altcha: 'invalid' });
    expect(consume).toHaveBeenCalledWith(expect.stringMatching(/^nonce:/), START.getTime() + 600000);
    expect((await send(body)).status).toBe(403);
    expect(deps.verifyAltcha).toHaveBeenCalledTimes(1);
  });
  it('allows one of twenty simultaneous uses', async () => {
    const body = await submission();
    const results = await Promise.all(Array.from({ length: 20 }, () => send(body)));
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect(results.filter(response => response.status === 403)).toHaveLength(19);
    expect(deps.verifyAltcha).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
  it('includes the product in the submitter confirmation', async () => {
    expect((await send({ ...await submission(), autoreply: true })).status).toBe(200);
    await Promise.all(tasks);
    const mail = vi.mocked(deps.sendEmail).mock.calls[1][1];
    expect(mail.to).toEqual(['viewer@example.com']);
    expect(mail.text).toContain(PRODUCT);
  });
  it('leaves trusted submissions independent of nonce', async () => {
    delete deps.store;
    expect((await send({ brand: 'demo', autoreply: false }, { authorization: 'Bearer test-api-key' })).status).toBe(200);
  });
});

describe('form nonce configuration', () => {
  it('accepts optional nonce settings and 1-100 character product names', () => {
    const input = structuredClone(example);
    Object.assign(input.brands.demo, { requireNonce: true, products: ['a', 'x'.repeat(100)] });
    expect(parseConfig(input).brands.demo).toMatchObject({ requireNonce: true, products: ['a', 'x'.repeat(100)] });
  });
  it.each([{ requireNonce: 'true' }, { products: [''] }, { products: ['x'.repeat(101)] }, { products: [12] }])('validates settings: %j', settings => {
    const input = structuredClone(example);
    Object.assign(input.brands.demo, settings);
    expect(() => parseConfig(input)).toThrow();
  });
});
