import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysOnly } from './fixtures/keys';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import example from '../config/mailstack.example.json';
import { loadConfig } from '../src/core/config/load';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { renderAndSend } from '../src/send';
import { getTemplate } from '../src/templates';
import { loadExtensions } from '../src/runtime/extensions';
import { tokenSha256 } from '../src/clients';
import { panelClaims, panelEnv, signPanel } from './fixtures/panel';
import { sealed, transitEnv } from './fixtures/transit';
import { idempotencyHash } from '../src/core/logging/writer';
import { recordEvents, eventId } from '../src/core/store/events';
import { runRetention } from '../src/core/retention';
import type { Env, SendDeps } from '../src/types';
import { tombstoneRegistry } from '../src/core/offsite';
import { runJobs } from '../src/core/jobs';

for (const driver of ['sqlite', 'd1'] as const) describe(`delivery policy: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined, binding: D1Database;
  let env: Env, now: number;
  const directory = mkdtempSync(join(tmpdir(), 'mailstack-delivery-'));
  const sender = vi.fn<SendDeps['sendEmail']>();
  const configuration = (level: 'masked' | 'none') => {
    const input = structuredClone(example);
    input.logging.defaults.level = level;
    input.logging.defaults.resend = 'off';
    input.logging.brands = {};
    return loadConfig(JSON.stringify(input));
  };
  const call = (level: 'masked' | 'none', key = 'request-1', amount = '23.41', clientId = 'client-a') => {
    const cfg = configuration(level);
    return renderAndSend({ store, logging: cfg.logging, provider: 'smtp', sendEmail: sender,
      verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(), now: () => new Date(now) }, env,
    cfg.brands.acme, getTemplate('payment')!, { amount, currency: 'PLN', orderId: 'ORDER-1' }, {
      clientId, idempotencyKey: key, ref: 'ORDER-1', to: ['buyer@acme.example'],
    });
  };
  const restart = async () => {
    await store.db.destroy();
    store = driver === 'sqlite' ? createSqliteStore(join(directory, 'db.sqlite')) : createD1Store(binding);
    await store.migrate();
  };
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(join(directory, 'db.sqlite'));
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      binding = await mf.getD1Database('DB'); store = createD1Store(binding);
    }
    await store.migrate();
    const kem = new DhkemX25519HkdfSha256(), pair = await kem.generateKeyPair();
    env = { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ kid: 'c1', kty: 'OKP', crv: 'X25519',
      x: Buffer.from(await kem.serializePublicKey(pair.publicKey)).toString('base64url') }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) } as Env;
  });
  beforeEach(async () => {
    for (const table of ['events', 'recipients', 'subjects', 'contents', 'replays', 'messages', 'guards'] as const)
      await sql`delete from ${sql.table(table)}`.execute(store.db);
    now = Date.parse('2026-10-24T12:00:00Z');
    sender.mockReset().mockResolvedValue({ ok: true, status: 200, smtp: { accepted: ['buyer@acme.example'], rejected: [] } });
  });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); rmSync(directory, { recursive: true, force: true }); });

  it.each(['masked', 'none'] as const)('keeps one delivery after restarting from %s', async first => {
    const original = await call(first);
    await restart();
    const second = first === 'masked' ? 'none' : 'masked';
    expect(await call(second)).toMatchObject(first === 'masked'
      ? { ok: true, idempotent: true, id: original.id } : { status: 409, code: 'in_progress' });
    expect(sender).toHaveBeenCalledTimes(1);
    const messages = await store.db.selectFrom('messages').selectAll().execute();
    expect(messages).toHaveLength(first === 'masked' ? 1 : 0);
    if (first === 'masked') expect(messages[0].id).toBe(original.id);
  });
  it.each(['masked', 'none', 'mixed'] as const)('delivers once for twenty %s attempts', async level => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => call(level === 'mixed' ? (i % 2 ? 'none' : 'masked') : level)));
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('keeps clients independent and checks changed requests when recorded', async () => {
    await call('masked');
    expect(await call('none', 'request-1', '24.41')).toMatchObject({ status: 409, code: 'idempotency_conflict' });
    await call('none', 'request-1', '23.41', 'client-b');
    expect(await call('masked', 'request-1', '24.41', 'client-b')).toMatchObject({ status: 409, code: 'in_progress' });
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it.each(['masked', 'none'] as const)('expires %s reservations at 24 hours without deleting evidence', async level => {
    await call(level); now += 86400000 - 1;
    expect(await call(level === 'masked' ? 'none' : 'masked')).toMatchObject(level === 'masked'
      ? { idempotent: true } : { status: 409, code: 'in_progress' });
    now++;
    expect(await call('masked')).toMatchObject({ ok: true, id: expect.any(String) });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(await store.db.selectFrom('messages').selectAll().execute()).toHaveLength(level === 'masked' ? 2 : 1);
  });
  it('permits an explicit refusal retry after changing policy', async () => {
    sender.mockResolvedValueOnce({ ok: false, status: 400 });
    expect(await call('masked')).toMatchObject({ status: 502 });
    expect(await call('none')).toMatchObject({ ok: true });
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it('recognizes existing guard and message records without a backfill', async () => {
    await store.consume('idem:client-a:' + await idempotencyHash('client-a', 'old-none'), now + 86400000);
    expect(await call('masked', 'old-none')).toMatchObject({ status: 409, code: 'in_progress' });
    await call('masked', 'old-message');
    await store.db.deleteFrom('guards').execute();
    await restart();
    expect(await call('none', 'old-message')).toMatchObject({ ok: true, idempotent: true });
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('keeps an existing unlogged reservation alongside an older refused message', async () => {
    sender.mockResolvedValueOnce({ ok: false, status: 400 });
    await call('masked');
    const guard = 'idem:client-a:' + await idempotencyHash('client-a', 'request-1');
    await store.release(guard);
    await store.consume(guard, now + 86400000);
    expect(await call('masked')).toMatchObject({ status: 409, code: 'in_progress' });
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('retains the reservation across index key rotation and unavailable verification keys', async () => {
    await call('masked');
    const original = env;
    try {
      const old = JSON.parse(env.INDEX_KEYS!);
      env = { ...env, INDEX_KEYS: JSON.stringify([{ kid: 'i2', key: Buffer.alloc(32, 12).toString('base64url') }, ...old]) };
      expect(await call('none')).toMatchObject({ ok: true, idempotent: true });
      env = { ...env, INDEX_KEYS: JSON.stringify([{ kid: 'i2', key: Buffer.alloc(32, 12).toString('base64url') }]) };
      expect(await call('none')).toMatchObject({ status: 409, code: 'idempotency_conflict' });
      env = {} as Env;
      expect(await call('none')).toMatchObject({ status: 409, code: 'idempotency_conflict' });
      expect(sender).toHaveBeenCalledTimes(1);
    } finally { env = original; }
  });
  it('keeps one delivery for twenty different requests and effective policies', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? 'masked' : 'none', 'mixed-content', String(i))));
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('preserves known recipient outcomes when reconciling unresolved recipients', async () => {
    await call('masked');
    const [recipient] = await store.db.selectFrom('recipients').selectAll().execute();
    const states = ['sending', 'accepted', 'send_failed', 'delivered', 'bounce_permanent', 'bounce_transient', 'bounce_undetermined', 'reject'] as const;
    await store.db.deleteFrom('recipients').execute();
    for (const [pos, status] of states.entries()) await store.db.insertInto('recipients').values({ ...recipient, pos, status }).execute();
    await store.db.updateTable('messages').set({ status: 'sending', complained: 1 }).execute();
    now += 900001;
    await runRetention(store, now, configuration('masked'));
    expect((await store.db.selectFrom('recipients').select('status').orderBy('pos').execute()).map(r => r.status))
      .toEqual(['unknown', ...states.slice(1)]);
    await store.setStatus(recipient.message_id, 'unknown');
    expect((await store.db.selectFrom('recipients').select('status').orderBy('pos').execute()).map(r => r.status))
      .toEqual(['unknown', ...states.slice(1)]);
    expect(await store.db.selectFrom('messages').select('complained').execute()).toEqual([{ complained: 1 }]);
  });
  it('applies a late SMTP result to unknown recipients while retaining final events', async () => {
    await call('masked');
    const [recipient] = await store.db.selectFrom('recipients').selectAll().execute();
    await store.db.updateTable('recipients').set({ status: 'unknown' }).execute();
    await store.db.insertInto('recipients').values({ ...recipient, pos: 1, status: 'delivered' }).execute();
    await sql`delete from events`.execute(store.db);
    await store.markSent(recipient.message_id, { sentAt: now, providerMessageId: 'fixture', providerResponseSealed: 'sealed',
      smtp: { accepted: [0, 1], rejected: [], evidence: 'sealed' } });
    expect((await store.db.selectFrom('recipients').select('status').orderBy('pos').execute()).map(r => r.status))
      .toEqual(['accepted', 'delivered']);
  });
  it('keeps partial SMTP results and changes only unresolved recipients on failure', async () => {
    await call('masked');
    const [recipient] = await store.db.selectFrom('recipients').selectAll().execute();
    await store.db.insertInto('recipients').values({ ...recipient, pos: 1, status: 'send_failed' }).execute();
    await store.db.insertInto('recipients').values({ ...recipient, pos: 2, status: 'sending' }).execute();
    await store.markFailed(recipient.message_id, 'sealed');
    expect((await store.db.selectFrom('recipients').select('status').orderBy('pos').execute()).map(r => r.status))
      .toEqual(['accepted', 'send_failed', 'send_failed']);
  });
  it.each((['accepted', 'delay', 'delivered', 'bounce_permanent', 'bounce_transient', 'bounce_undetermined', 'reject', 'render_failure'] as const)
    .flatMap(status => (['success', 'refusal', 'exception', 'fallback'] as const).map(outcome => ({ status, outcome }))))(
    'retains $status events through late $outcome', async ({ status, outcome }) => {
      sender.mockImplementationOnce(async (_env, params) => {
        const row = { id: eventId(now), message_id: params.messageId!, recipient_pos: 0, source: 'ses-sns',
          source_event_id: outcome, type: status, occurred_at: now, received_at: now,
          auth: 'sns-sig-v2', summary: 'Provider outcome', evidence_sealed: 'provider-evidence' };
        await recordEvents(store, [row, { ...row, id: eventId(now), source_event_id: outcome + '-complaint', type: 'complaint' }]);
        if (outcome === 'exception') throw new Error('SMTP interrupted');
        return { ok: outcome === 'success', status: outcome === 'success' ? 200 : 400, messageId: 'provider-id',
          smtp: { accepted: ['buyer@acme.example'], rejected: [] } };
      });
      const finalizer = outcome === 'fallback' ? vi.spyOn(store, 'markFailed').mockRejectedValueOnce(new Error('Write unavailable')) : undefined;
      const result = await call('masked', outcome).finally(() => { finalizer?.mockRestore(); });
      expect(await store.db.selectFrom('messages').select(['status', 'complained']).where('id', '=', result.id!).executeTakeFirst())
        .toEqual({ status, complained: 1 });
      expect(await store.db.selectFrom('recipients').select(['status', 'last_event_at']).where('message_id', '=', result.id!).execute())
        .toEqual([{ status, last_event_at: now }]);
      const evidence = (await sql<{ type: string; evidence_sealed: string }>`select type,evidence_sealed from events
        where message_id=${result.id!} and source='ses-sns' order by type`.execute(store.db)).rows;
      expect(evidence).toEqual([status, 'complaint'].sort().map(type => ({ type, evidence_sealed: 'provider-evidence' })));
      if (outcome === 'success') expect(await store.db.selectFrom('messages').select(['provider_message_id', 'sent_at'])
        .where('id', '=', result.id!).executeTakeFirst()).toEqual({ provider_message_id: 'provider-id', sent_at: now });
      expect(await call('none', outcome)).toMatchObject({ ok: true, idempotent: true, id: result.id });
      expect(sender).toHaveBeenCalledTimes(1);
    });
  it.each(['markFailed', 'setStatus'] as const)('resolves stale recipients after a late refusal through %s', async method => {
    await call('masked');
    const [recipient] = await store.db.selectFrom('recipients').selectAll().execute();
    const states = ['sending', 'unknown', 'accepted', 'send_failed', 'delivered', 'bounce_permanent', 'bounce_transient', 'bounce_undetermined', 'reject', 'render_failure'] as const;
    await store.db.deleteFrom('recipients').execute();
    for (const [pos, status] of states.entries()) await store.db.insertInto('recipients').values({ ...recipient, pos, status }).execute();
    await store.db.updateTable('messages').set({ status: 'sending' }).execute();
    now += 900001;
    await restart();
    await runRetention(store, now, configuration('masked'));
    if (method === 'markFailed') await store.markFailed(recipient.message_id, 'sealed');
    else await store.setStatus(recipient.message_id, 'send_failed');
    expect(await store.db.selectFrom('messages').select('status').execute()).toEqual([{ status: 'send_failed' }]);
    expect((await store.db.selectFrom('recipients').select('status').orderBy('pos').execute()).map(r => r.status))
      .toEqual(['send_failed', 'send_failed', ...states.slice(2)]);
  });
  it('does not recreate message children after erasure and late finalization', async () => {
    await call('masked');
    const [message] = await store.db.selectFrom('messages').selectAll().execute();
    const cfg = configuration('masked');
    const token = 'msk_panel_' + 'a'.repeat(43);
    cfg.clients = [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*', recipientOverride: false, attachments: false }];
    const [keyed, importer] = keysOnly(cfg);
    const runtime = await loadExtensions(keyed, store, importer);
    const request = await signPanel(new Request('http://localhost/internal/v2/subjects/erase', { method: 'POST',
      body: JSON.stringify({ reason: 'Requested by subject', ...await sealed({ email: 'buyer@acme.example' }, 'subjects.erase') }) }), token, panelClaims());
    expect((await runtime.fetch(request, { ...env, ...panelEnv, ...transitEnv, MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY: 'true' })).status).toBe(202);
    await runJobs(store, 'request', { beforeDelete: runtime.beforeDelete, registry: () => tombstoneRegistry({ MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY: 'true' }) });
    await store.setStatus(message.id, 'unknown');
    await store.markFailed(message.id, 'sealed');
    await store.markSent(message.id, { sentAt: now, providerMessageId: 'fixture', providerResponseSealed: 'sealed',
      smtp: { accepted: [0], rejected: [], evidence: 'sealed' } });
    await runRetention(store, now, cfg);
    for (const table of ['messages', 'recipients', 'subjects', 'contents', 'replays', 'events'])
      expect((await sql`select * from ${sql.table(table)}`.execute(store.db)).rows).toEqual([]);
    expect(await call('none')).toMatchObject({ ok: true, idempotent: true });
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('keeps recipients consistent after a direct exception and restart', async () => {
    sender.mockRejectedValueOnce(new Error('SMTP interrupted'));
    expect(await call('masked')).toMatchObject({ status: 502 });
    expect(await store.db.selectFrom('recipients').select('status').execute()).toEqual([{ status: 'unknown' }]);
    await restart();
    expect(await call('none')).toMatchObject({ status: 409, code: 'outcome_unknown' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await store.db.selectFrom('recipients').select('status').execute()).toEqual([{ status: 'unknown' }]);
  });
  it('reconciles an interrupted pending delivery after restart without sending again', async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const pending = new Promise<void>(r => { finish = r; });
    sender.mockImplementationOnce(async () => { entered(); await pending; throw new Error('SMTP interrupted'); });
    const attempt = call('masked'); await started;
    // The persisted intent is the only state available to the restarted layer.
    await restart();
    expect(await call('none')).toMatchObject({ status: 409, code: 'in_progress' });
    now += 900001;
    await runRetention(store, now, configuration('masked'));
    expect(await call('masked')).toMatchObject({ status: 409, code: 'outcome_unknown' });
    expect(await store.db.selectFrom('recipients').select('status').execute()).toEqual([{ status: 'unknown' }]);
    finish(); await attempt;
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
