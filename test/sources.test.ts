import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { config } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { createApp } from '../src/index';
import { sourceField } from '../src/sources';
import { sourceSchema } from '../src/core/config/sources';
import { createSqliteStore } from '../src/core/store/sqlite';
import { loadConfig } from '../src/core/config/load';
import { loadNodeConfig } from '../src/core/config/node';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env, SendDeps, SendParams } from '../src/types';

const original = structuredClone(config);
const token = `msk_source_${'a'.repeat(43)}`;
const source = () => ({
  signature: { scheme: 'sha256-prefix', header: 'X-Hub-Signature-256' },
  envelope: { event: 'action', timestamp: 'repository.updated_at', data: 'sender' },
  events: { created: { action: 'send', template: 'notice', to: 'sender.email',
    fields: { heading: 'repository.name', paragraphs: 'issue.title' }, ref: 'issue.id', idempotencyKey: 'issue.id' },
    deleted: { action: 'reject' }, edited: { action: 'ignore' } },
});
const client = () => ({ id: 'source', tokenSha256: createHash('sha256').update(token).digest('hex'), scopes: ['hook:github'],
  brands: ['acme'], templates: ['notice'], signatureSecretEnv: 'SOURCE_SECRET' });
// Local source fixture follows the issue-event shape; no provider connection is used.
const payload = () => ({ action: 'created', repository: { name: 'Hello-World', updated_at: '2026-10-31T12:00:00Z' },
  sender: { email: 'reader@example.com' }, issue: { id: 1, title: 'Found a bug' } });
const env = { API_KEY: '', SOURCE_SECRET: 'local-example-secret' } as unknown as Env;
function configure(change: Record<string, unknown> = {}) {
  Object.assign(config, parseConfig({ ...original, sources: { github: source() }, clients: [client()], legacyApiKey: { enabled: false }, ...change }));
}
afterEach(() => {
  for (const key of Object.keys(config)) if (!Object.hasOwn(original, key)) Reflect.deleteProperty(config, key);
  Object.assign(config, structuredClone(original));
});
async function run(body: unknown = payload(), headers: Record<string, string> = {}, path = 'github', overrides: Parameters<typeof createApp>[0] = {}, runtime = env, brand = 'acme') {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
  const deps = { sendEmail, now: () => new Date('2026-10-31T12:00:00Z') } satisfies Partial<SendDeps>;
  const signature = `sha256=${createHmac('sha256', Reflect.get(env, 'SOURCE_SECRET') as string).update(raw).digest('hex')}`;
  const response = await createApp({ ...deps, logging: config.logging, ...overrides }).fetch(new Request(`https://local.example/v1/hooks/${path}?brand=${brand}`, {
    method: 'POST', body: raw, headers: { authorization: `Bearer ${token}`, 'X-Hub-Signature-256': signature, ...headers },
  }), runtime, {} as ExecutionContext);
  return { response, sendEmail };
}
it('routes a configured second source to the shared delivery pipeline', async () => {
  configure();
  const { response, sendEmail } = await run();
  expect(response.status).toBe(200);
  expect(sendEmail).toHaveBeenCalledOnce();
  expect(sendEmail.mock.calls[0]?.[1]).toMatchObject({ to: ['reader@example.com'], replyTo: 'inbox@acme.example' });
});
it.each([
  ['authorization', ''], ['authorization', 'Bearer other'], ['X-Hub-Signature-256', ''],
  ['X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`], ['X-Hub-Signature-256', 'sha1=abc'],
])('requires the configured credentials: %s %s', async (key, value) => {
  configure();
  const { response, sendEmail } = await run(payload(), { [key]: value });
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
});
it.each([
  { scopes: ['hook:other'] }, { scopes: ['send'] }, { brands: ['demo'] }, { templates: ['payment'] },
])('enforces client selections %j', async change => {
  configure({ clients: [{ ...client(), ...change }] });
  const { response, sendEmail } = await run();
  expect(response.status).toBe(403); expect(sendEmail).not.toHaveBeenCalled();
});
it.each([['edited', 200], ['deleted', 422], ['unknown', 200], ['toString', 200]] as const)('handles action %s', async (action, status) => {
  configure(); const { response, sendEmail } = await run({ ...payload(), action });
  expect(response.status).toBe(status); expect(sendEmail).not.toHaveBeenCalled();
});
it.each([
  ['sender.email', 'bad'], ['sender.email', null], ['issue.title', ''], ['issue.title', {}],
])('validates mapped data %s %j', async (path, value) => {
  configure(); const body = payload(); const [parent, key] = path.split('.');
  Reflect.set(Reflect.get(body, parent), key, value);
  const { response, sendEmail } = await run(body);
  expect(response.status).toBe(422); expect(sendEmail).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({ code: 'invalid_event_data' });
});
it.each(['[]', 'null', '{}', '{', JSON.stringify({ ...payload(), action: 1 })])('declines malformed envelopes %s', async body => {
  configure(); const { response, sendEmail } = await run(body);
  expect(response.status).toBe(400); expect(sendEmail).not.toHaveBeenCalled();
});
it('bounds the streamed body', async () => {
  configure(); const { response, sendEmail } = await run(' '.repeat(65537));
  expect(response.status).toBe(413); expect(sendEmail).not.toHaveBeenCalled();
});
it.each([
  { signature: { scheme: 'custom' } },
  { envelope: { event: 'action()', timestamp: 'timestamp', data: 'data' } },
  { events: { created: { ...source().events.created, template: 'absent' } } },
  { events: { created: { ...source().events.created, fields: { heading: 'issue.title' } } } },
  { events: { created: { ...source().events.created, to: 'sender.__proto__.email' } } },
  { events: { created: { ...source().events.created, fields: { heading: 'issue.title', paragraphs: { path: 'issue.title', as: 'eval' } } } } },
])('refuses invalid source configuration %j', change => {
  expect(() => configure({ sources: { github: { ...source(), ...change } } })).toThrow(/sources.github/);
});
it.each([-301, -300, 0, 300, 301])('checks timestamp tolerance at %s seconds', async offset => {
  configure({ sources: { github: { ...source(), signature: { scheme: 't-v1', header: 'X-Example-Signature' } } } });
  const body = JSON.stringify(payload()), timestamp = Date.parse('2026-10-31T12:00:00Z') / 1000 + offset;
  const signature = createHmac('sha256', Reflect.get(env, 'SOURCE_SECRET')).update(`${timestamp}.${body}`).digest('hex');
  const { response, sendEmail } = await run(body, { 'X-Example-Signature': `t=${timestamp},v1=${signature}` });
  expect(response.status).toBe(Math.abs(offset) <= 300 ? 200 : 401);
  expect(sendEmail).toHaveBeenCalledTimes(Math.abs(offset) <= 300 ? 1 : 0);
});
it.each(['', 't=abc,v1=123', `t=1793448000,v1=${'0'.repeat(64)}`])('requires a valid timestamp signature %s', async header => {
  configure({ sources: { github: { ...source(), signature: { scheme: 't-v1', header: 'X-Example-Signature' } } } });
  const { response, sendEmail } = await run(payload(), { 'X-Example-Signature': header });
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
});
it.each(['t-v1', 'sha256-prefix'])('requires a configured runtime secret for %s', async scheme => {
  configure({ sources: { github: { ...source(), signature: { scheme, header: 'X-Hub-Signature-256' } } } });
  const { response, sendEmail } = await run(payload(), {}, 'github', {}, { ...env, SOURCE_SECRET: undefined } as Env);
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
});
it('allows bearer-only mode without weakening the bearer requirement', async () => {
  const entry = client(); Reflect.deleteProperty(entry, 'signatureSecretEnv');
  configure({ clients: [entry], sources: { github: { ...source(), signature: { scheme: 'bearer-only' } } } });
  expect((await run()).response.status).toBe(200);
  expect((await run(payload(), { authorization: '' })).response.status).toBe(401);
});
it('keeps signatures optional when a signing client has no reference', async () => {
  const entry = client(); Reflect.deleteProperty(entry, 'signatureSecretEnv');
  configure({ clients: [entry] });
  expect((await run(payload(), { 'X-Hub-Signature-256': '' })).response.status).toBe(200);
});
it('retains the Sellf signature reference alias for the Sellf source', async () => {
  const entry = { ...client(), scopes: ['hook:sellf'], sellfSignatureSecretEnv: 'SOURCE_SECRET' };
  Reflect.deleteProperty(entry, 'signatureSecretEnv');
  configure({ clients: [entry], sources: { sellf: source() } });
  expect((await run(payload(), {}, 'sellf')).response.status).toBe(200);
  const { response, sendEmail } = await run(payload(), { 'X-Hub-Signature-256': '' }, 'sellf');
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
  expect((await run()).response.status).toBe(404);
});
it('refuses conflicting signature references and signing references with bearer-only sources', () => {
  expect(() => configure({ clients: [{ ...client(), sellfSignatureSecretEnv: 'OTHER_SECRET' }] })).toThrow('signature references must match');
  expect(() => configure({ sources: { github: { ...source(), signature: { scheme: 'bearer-only' } } } })).toThrow('requires a signing scheme');
});
it.each(['', 'data..email', 'data[0]', 'data.email()', '__proto__.email', 'data.constructor', 'data.prototype', 'data.email + value'])('refuses non-path selections %s', to => {
  const definition = source(); definition.events.created.to = to;
  expect(() => configure({ sources: { github: definition } })).toThrow('sources.github');
});
it.each([
  ['data.value', { value: 'text' }, 'text'],
  ['data.value', {}, ''],
  [{ path: 'data.value', as: 'money-minor' }, { value: 12300 }, '123,00'],
  [{ path: 'data.value', as: 'money-minor' }, { value: '12300' }, ''],
  [{ path: 'data.value', as: 'upper' }, { value: 'pln' }, 'PLN'],
  [{ path: 'data.value', as: 'date-pl' }, { value: '2026-10-31T23:00:00-02:00' }, '1.11.2026'],
  [{ path: 'data.value', as: 'date-pl' }, { value: 'invalid' }, ''],
  [{ path: 'data.value', as: 'map', map: { true: 'pełny' } }, { value: true }, 'pełny'],
  [{ path: 'data.value', as: 'map', map: { true: 'pełny' } }, { value: false }, ''],
  [{ join: ['data.first', 'data.missing', 'data.values.0'] }, { first: 'Jan', values: ['Nowak'] }, 'Jan Nowak'],
] as const)('maps the closed field operation %j', (field, data, expected) => {
  const parsed = sourceSchema.parse({ ...source(), events: { created: { ...source().events.created, fields: { value: field } } } });
  const action = parsed.events.created;
  if (action.action !== 'send') throw new Error('Expected send');
  expect(sourceField({ data }, action.fields.value)).toBe(expected);
});
it('uses only own properties when resolving fields', () => {
  expect(sourceField({ data: Object.create({ value: 'inherited' }) }, 'data.value')).toBe('');
});
it.each([
  { ...payload(), repository: { updated_at: 'invalid' } },
  { ...payload(), sender: [] },
  { ...payload(), sender: null },
  { ...payload(), action: 'a'.repeat(129) },
])('requires valid selected envelope values %j', async body => {
  configure(); const { response, sendEmail } = await run(body);
  expect(response.status).toBe(400); expect(sendEmail).not.toHaveBeenCalled();
});
it('bounds JSON depth and mapped values before delivery', async () => {
  configure();
  let nested: unknown = {};
  for (let i = 0; i < 21; i++) nested = { nested };
  const { response, sendEmail } = await run({ ...payload(), nested });
  expect(response.status).toBe(400); expect(sendEmail).not.toHaveBeenCalled();
  const large = payload(); large.issue.title = 'a'.repeat(5001);
  const result = await run(large);
  expect(result.response.status).toBe(422); expect(result.sendEmail).not.toHaveBeenCalled();
});
it('bounds configuration maps and keeps unknown operations closed', () => {
  const definition = source();
  definition.events.created.fields = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`field${i}`, 'issue.title'])) as typeof definition.events.created.fields;
  expect(() => configure({ sources: { github: definition } })).toThrow('sources.github');
  expect(() => configure({ sources: { github: { ...source(), signature: { scheme: 'sha256-prefix', header: 'bad header' } } } })).toThrow('sources.github');
});
it('validates source template coverage through the shared runtime loader', () => {
  const input = { ...original, sources: { github: { ...source(), events: { created: { ...source().events.created, fields: {} } } } } };
  expect(() => loadConfig(JSON.stringify(input))).toThrow('required template field');
});
it('keeps source, brand and client idempotency independent through storage', async () => {
  configure({ sources: { github: source(), other: source() }, clients: [{ ...client(), scopes: ['hook:github', 'hook:other'], brands: '*' }],
    logging: { ...original.logging, defaults: { ...original.logging.defaults, level: 'none' }, brands: {} } });
  const store = createSqliteStore(':memory:'); await store.migrate();
  const sendEmail = vi.fn(async (_env: Env, _params: SendParams) => ({ ok: true, status: 200 }));
  try {
    const overrides = { store, sendEmail };
    expect((await run(payload(), {}, 'github', overrides)).response.status).toBe(200);
    const duplicate = await run(payload(), {}, 'github', overrides);
    expect(await duplicate.response.json()).toMatchObject({ success: true, idempotent: true });
    await run(payload(), {}, 'other', overrides);
    await run(payload(), {}, 'github', overrides, env, 'demo');
    const secondToken = `msk_second_${'a'.repeat(43)}`;
    config.clients!.push({ ...config.clients![0], id: 'second', tokenSha256: createHash('sha256').update(secondToken).digest('hex') });
    await run(payload(), { authorization: `Bearer ${secondToken}` }, 'github', overrides);
    expect(sendEmail).toHaveBeenCalledTimes(4);
  } finally { await store.db.destroy(); }
});
it('returns provider refusal through the delivery response contract', async () => {
  configure();
  const sendEmail = vi.fn(async () => ({ ok: false, status: 500 }));
  const { response } = await run(payload(), {}, 'github', { sendEmail });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ success: false, message: 'send failed', code: 'send_failed' });
});

it('refuses incomplete source maps in Node and Worker configuration entry points', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailstack-source-'));
  const previous = process.env.MAILSTACK_CONFIG;
  const path = join(directory, 'config.json');
  const definition = source();
  Reflect.deleteProperty(definition.events.created.fields, 'paragraphs');
  writeFileSync(path, JSON.stringify({ ...original, sources: { github: definition } }));
  try {
    process.env.MAILSTACK_CONFIG = path;
    expect(() => loadNodeConfig()).toThrow('required template field');
    const verified = spawnSync(process.execPath, ['scripts/bundle-config.ts', '--verify'], {
      encoding: 'utf8', env: { ...process.env, MAILSTACK_CONFIG: path },
    });
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('sources.github.events.created.fields.paragraphs');
    expect(verified.stderr).toContain('required template field');
    expect(verified.stdout).toBe('');
  } finally {
    if (previous === undefined) delete process.env.MAILSTACK_CONFIG;
    else process.env.MAILSTACK_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
it('creates hook clients with explicit selections through the CLI', () => {
  const args = ['scripts/mailstack.ts', 'client', 'create', '--id', 'local-source', '--scopes', 'hook:github'];
  expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(1);
  const result = spawnSync(process.execPath, [...args, '--brands', 'acme', '--templates', 'notice'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).client).toMatchObject({ scopes: ['hook:github'], brands: ['acme'], templates: ['notice'] });
});
it('uses the general signature reference on the existing Sellf route', async () => {
  configure({ sources: {}, clients: [{ ...client(), scopes: ['hook:sellf'] }] });
  const { response, sendEmail } = await run(payload(), {}, 'sellf');
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
});
it.each(['hook:', 'hook:UPPER', 'hook:a/b', `hook:${'a'.repeat(65)}`, 'hook:*'])('refuses invalid source scopes %s', scope => {
  expect(() => configure({ clients: [{ ...client(), scopes: [scope] }] })).toThrow('clients.0.scopes');
});
it('checks the signature against the exact request body', async () => {
  configure();
  const signature = createHmac('sha256', Reflect.get(env, 'SOURCE_SECRET')).update(JSON.stringify(payload())).digest('hex');
  const { response, sendEmail } = await run({ ...payload(), extra: true }, { 'X-Hub-Signature-256': `sha256=${signature}` });
  expect(response.status).toBe(401); expect(sendEmail).not.toHaveBeenCalled();
});
it('uses a body digest when the selected idempotency value is absent', async () => {
  configure({ logging: { ...original.logging, defaults: { ...original.logging.defaults, level: 'none' }, brands: {} } });
  const body = payload(); Reflect.deleteProperty(body.issue, 'id');
  const store = createSqliteStore(':memory:'); await store.migrate();
  const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
  try {
    await run(body, {}, 'github', { store, sendEmail });
    expect(await (await run(body, {}, 'github', { store, sendEmail })).response.json()).toMatchObject({ success: true, idempotent: true });
    body.issue.title = 'Another issue';
    expect((await run(body, {}, 'github', { store, sendEmail })).response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  } finally { await store.db.destroy(); }
});
