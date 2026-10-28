import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { blindIndex } from '../src/core/crypto';
import { unsuppressed } from '../src/core/store/resend';
import { parseConfig } from '../src/core/config/schema';
import { createNtfyNotifier } from '../src/adapters/notify/ntfy';
import { createVerifier } from '../src/events/sns';
import { handleSesEvent } from '../src/events/ses';
import example from '../config/mailstack.example.json';
import { certificates, notification, options, request, signed } from './sns-fixture';

const pair = generateKeyPairSync('x25519');
const contentKeys = [{ ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' }];
const indexKeys = [{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }];
const addresses = ['A@acme.example', 'B@demo.example'];
const hints = ['A***@a***.example', 'B***@d***.example'];
let cert: string, key: string;
beforeAll(() => { ({ cert, key } = certificates()); });

for (const driver of ['sqlite', 'd1'] as const) describe(`alert recipients: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  afterAll(async () => { await store.db.destroy(); await mf?.dispose(); });

  it.each([
    ['Complaint', null], ['Complaint', 0], ['Complaint', 1], ['Bounce', 0], ['Bounce', 1],
  ] as const)('assigns %s to recipient %s', async (type, pos) => {
    const id = `msg_${type}_${pos}`;
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at)
      values(${id},'demo','acme','license','meta','hash','accepted',0,9999999999999)`.execute(store.db);
    for (const [i, address] of addresses.entries()) {
      const idx = await blindIndex(address, indexKeys[0]);
      await sql`insert into recipients values(${id},${i},'to',${idx.index},'i1','sealed',${hints[i]},'accepted',null)`.execute(store.db);
    }
    const logging = parseConfig(example).logging;
    logging.brands.acme = { templates: { license: { alertOn: ['complaint', 'bounce_permanent'] } } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const deps = { store, options, contentKeys, indexKeys, logging, now: () => 1000,
      verify: createVerifier(async () => new Response(cert)), panelUrl: 'https://panel.example/',
      notifier: createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo' }, fetcher) };
    const address = pos === null ? 'C@foreign.example' : addresses[pos];
    const details = type === 'Complaint' ? { complaint: { complainedRecipients: [{ emailAddress: address }] } }
      : { bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: address, diagnosticCode: '550 5.1.1' }] } };
    const event = notification(type, { mail: { messageId: 'provider-1', tags: { ms_id: [id] } }, ...details });
    const body = signed(key, event);
    const send = async (envelope = body) => (await handleSesEvent(request(envelope), deps)).json();
    expect(await send()).toEqual({ ok: true, result: 'processed' });
    expect(await send()).toEqual({ ok: true, result: 'duplicate' });
    expect(await send(signed(key, event))).toEqual({ ok: true, result: 'processed' });
    const normalized = type === 'Complaint' ? 'complaint' : 'bounce_permanent';
    const events = await sql`select recipient_pos,type from events where message_id=${id}`.execute(store.db);
    expect(events.rows).toEqual([{ recipient_pos: pos, type: normalized }, { recipient_pos: pos, type: normalized }]);
    expect(await store.db.selectFrom('messages').select(['status', 'complained']).where('id', '=', id).executeTakeFirst())
      .toEqual({ status: type === 'Complaint' ? 'accepted' : 'bounce_permanent', complained: type === 'Complaint' ? 1 : 0 });
    expect((await store.db.selectFrom('recipients').select('status').where('message_id', '=', id).orderBy('pos').execute()).map(r => r.status))
      .toEqual(addresses.map((_, i) => type === 'Bounce' && i === pos ? 'bounce_permanent' : 'accepted'));
    expect((await sql<{ allowed: number }>`select ${unsuppressed(id)} as allowed`.execute(store.db)).rows[0].allowed).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const payload = fetcher.mock.calls[0][1]!;
    expect(payload.headers).toMatchObject({ Title: `mailstack: ${normalized} acme/license`, Priority: 'high', Click: `https://panel.example/m/${id}` });
    expect(payload.body).toBe(`${pos === null ? 'unassigned' : hints[pos]} · ${type === 'Complaint' ? 'complaint' : 'Permanent 550 5.1.1'}`);
    for (const value of [...addresses, 'C@foreign.example']) expect(JSON.stringify(payload)).not.toContain(value);
    for (const position of [null, undefined, 0, 1]) {
      expect(await store.alertContext(id, position)).toEqual({ brand: 'acme', template: 'license',
        addr_hint: position == null ? 'unassigned' : hints[position] });
    }
  });
});
