import { beforeAll, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Extension } from '../src/core/extensions';
import { sql } from 'kysely';
import { withBackgroundTasks } from '../scripts/manual/lifecycle';
import { createSqliteStore } from '../src/core/store/sqlite';
import { loadExtensions } from '../src/runtime/extensions';
import { handleSesEvent } from '../src/events/ses';
import { createVerifier } from '../src/events/sns';
import { blindIndex } from '../src/core/crypto';
import { parseConfig } from '../src/core/config/schema';
import example from '../config/mailstack.example.json';
import { certificates, notification, options, request, signed } from './sns-fixture';

const pair = generateKeyPairSync('x25519');
const contentKeys = [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' }];
const indexKeys = [{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }];
let cert: string, key: string;
beforeAll(() => { ({ cert, key } = certificates()); });

it.each([
  ['Delivery'], ['Bounce'], ['Complaint'], ['Bounce', 'Delivery'],
])('drains delayed extension queue writes before closing: %j', async (...types) => {
  const root = mkdtempSync(join(tmpdir(), 'manual-lifecycle-'));
  const filename = join(root, 'events.db');
  let store = createSqliteStore(filename);
  await store.migrate();
  const idx = await blindIndex('one@example.com', indexKeys[0]);
  await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,provider_account,provider_message_id)
    values('msg_1','demo','acme','notice','meta','hash','sent',0,9999999999999,'123456789012','provider-1')`.execute(store.db);
  await sql`insert into recipients values('msg_1',0,'to',${idx.index},'i1','sealed','hint','sent',null)`.execute(store.db);
  const seen: unknown[] = [], cleanupRows: unknown[][] = [];
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cfg = parseConfig({ ...example, extensions: [{ module: 'queue-extension' }] });
  const extension: Extension = {
    name: 'queue',
    async migrate(db) {
      await db.schema.createTable('ext_queue_events').addColumn('id', 'text', c => c.primaryKey()).addColumn('payload', 'text').execute();
    },
    async onEvent(event, ctx) {
      await nextTurn();
      seen.push(event);
      await ctx.db.insertInto('ext_queue_events').values({ id: event.id, payload: JSON.stringify(event) }).execute();
    },
  };
  const runtime = await loadExtensions(cfg, store, async () => ({ default: extension }));
  let closed = false;
  try {
    const bodies = types.map(type => signed(key, notification(type, {
      bounce: { bounceType: 'Permanent', bouncedRecipients: ['one@example.com'] },
      complaint: { complainedRecipients: ['one@example.com'] },
    })));
    await withBackgroundTasks(async waitUntil => {
      for (const body of bodies) {
        const result = await handleSesEvent(request(body), {
          store, options, contentKeys, indexKeys, verify: createVerifier(async () => new Response(cert)),
          now: Date.now, emitEvent: runtime.emitEvent, waitUntil,
          // No notifier: Delivery must not rely on a pending alert to stay alive.
        });
        expect(await result.json()).toEqual({ ok: true, result: 'processed' });
      }
    }, async () => {
      cleanupRows.push((await sql`select * from ext_queue_events`.execute(store.db)).rows);
      await store.db.destroy(); closed = true;
    });
    expect(cleanupRows[0]).toHaveLength(types.length);
    expect(seen).toHaveLength(types.length);
    const expectedTypes = { Delivery: 'message.delivered', Bounce: 'message.bounced', Complaint: 'message.complained' };
    for (const [i, row] of cleanupRows[0].entries()) {
      expect(JSON.parse((row as { payload: string }).payload)).toMatchObject({
        type: expectedTypes[types[i] as keyof typeof expectedTypes], messageId: 'msg_1',
        status: types[0] === 'Bounce' ? 'bounce_permanent' : types[i] === 'Delivery' ? 'delivered' : 'sent',
      });
    }
    store = createSqliteStore(filename); closed = false;
    const emitEvent = vi.fn(runtime.emitEvent);
    await withBackgroundTasks(async waitUntil => {
      const result = await handleSesEvent(request(bodies[0]), {
        store, options, contentKeys, indexKeys, verify: createVerifier(async () => new Response(cert)),
        now: Date.now, emitEvent, waitUntil,
      });
      expect(await result.json()).toEqual({ ok: true, result: 'duplicate' });
    }, async () => {
      expect((await sql`select * from ext_queue_events`.execute(store.db)).rows).toHaveLength(types.length);
      await store.db.destroy(); closed = true;
    });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(seen).toHaveLength(types.length);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore(); if (!closed) await store.db.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 3000);

it('drains an additional nested level and rejected tasks before cleanup', async () => {
  const order: string[] = [];
  const failure = new Error('background failed');
  const work = withBackgroundTasks(async waitUntil => {
    waitUntil((async () => {
      await nextTurn();
      waitUntil((async () => {
        await nextTurn();
        waitUntil((async () => { await nextTurn(); order.push('last'); })());
        throw failure;
      })());
    })());
    return 'processed';
  }, async () => { order.push('cleanup'); });
  await expect(work).rejects.toMatchObject({ errors: [failure] });
  expect(order).toEqual(['last', 'cleanup']);
}, 3000);

it('drains registered work even when the operation fails and cleans up once', async () => {
  const order: string[] = [];
  await expect(withBackgroundTasks(async waitUntil => {
    waitUntil(nextTurn().then(() => { order.push('task'); }));
    throw new Error('operation failed');
  }, async () => { order.push('cleanup'); })).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'operation failed' })] });
  expect(order).toEqual(['task', 'cleanup']);
}, 3000);
