import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { createD1Store } from '../src/core/store/d1';
import { blindIndex } from '../src/core/crypto';
import type { Env } from '../src/types';
import { certificates, notification, options, request, signed } from './sns-fixture';

const fixture = vi.hoisted(() => ({ cert: '' }));
vi.mock('../src/events/sns', async (original) => {
  const sns = await original<typeof import('../src/events/sns')>();
  return { ...sns, createVerifier: () => sns.createVerifier(async () => new Response(fixture.cert)) };
});
vi.mock('../src/core/config', async (original) => {
  const configuration = await original<typeof import('../src/core/config')>();
  const { options } = await import('./sns-fixture-options');
  return { ...configuration, config: { ...configuration.config, events: { ses: options } } };
});
import worker from '../src/index';

let mf: Miniflare, env: Env, key: string;
let store: ReturnType<typeof createD1Store>;
beforeAll(async () => {
  const dir = mkdtempSync('.ses-keys-test-');
  try {
    const output = execFileSync(process.execPath, ['scripts/keys.mjs', 'init', join(dir, 'content.json')], { encoding: 'utf8' });
    const bindings = Object.fromEntries(output.trim().split('\n').map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 2, -1)];
    }));
    expect(Object.keys(JSON.parse(bindings.CONTENT_PUBLIC_KEYS))).toEqual(['keys']);
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
    const database = await mf.getD1Database('DB');
    store = createD1Store(database);
    await store.migrate();
    const indexKey = JSON.parse(bindings.INDEX_KEYS)[0];
    const idx = await blindIndex('one@example.com', indexKey);
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      values('msg_1','demo','acme','notice','meta','hash','sending',0,9999999999999)`.execute(store.db);
    await sql`insert into recipients values('msg_1',0,'to',${idx.index},${idx.kid},'sealed','hint','sending',null)`.execute(store.db);
    env = { ...bindings, DB: database } as Env;
    const certs = certificates(); key = certs.key; fixture.cert = certs.cert;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

it('processes a notification with the environment emitted by keys init', async () => {
  const result = await worker.fetch(request(signed(key)), env, {} as ExecutionContext);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true, result: 'processed' });
  expect((await sql`select * from events`.execute(store.db)).rows).toHaveLength(1);
});
it('returns 503 when key bindings cannot be parsed', async () => {
  for (const content of ['{', '[]', '{"keys":[]}']) {
    const result = await worker.fetch(request(signed(key, notification(), { TopicArn: options.topicArns[0] })),
      { ...env, CONTENT_PUBLIC_KEYS: content }, {} as ExecutionContext);
    expect(result.status).toBe(503);
  }
});
