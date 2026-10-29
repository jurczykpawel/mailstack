import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createD1Store } from '../src/core/store/d1';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { KyselyStore } from '../src/core/store';
import { readSesStatus } from '../src/core/store/ses-status';
import { handleSesEvent } from '../src/events/ses';
import { createVerifier } from '../src/events/sns';
import { certificates, notification, options, request, signed } from './sns-fixture';

const { key, cert } = certificates();
for (const driver of ['sqlite', 'd1'] as const) describe(`SES status: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
  let now = Date.now();
  const fetcher: typeof fetch = async url => new Response(String(url).endsWith('.pem') ? cert : '');
  const verify = createVerifier(fetcher);
  const deps = () => ({ store, options, now: () => now, verify, fetcher, contentKeys: [], indexKeys: [] });
  const read = () => readSesStatus(store, options, 'eu-west-1');
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });
  it('reports observations and confirmation without message records', async () => {
    expect(await read()).toEqual({ version: 1, configured: true, region: 'eu-west-1', topicArns: options.topicArns, accountIds: options.accountIds,
      subscriptions: options.topicArns.map(topicArn => ({ topicArn, confirmedAt: null })), lastReceivedAt: null, lastReceivedType: null,
      received: 0, rejected: { signature: 0, topic: 0, account: 0 } });
    const body = signed(key);
    expect((await handleSesEvent(request(body), deps())).status).toBe(503);
    expect(await read()).toMatchObject({ received: 1, lastReceivedAt: now, lastReceivedType: 'Delivery' });
    const confirmation = signed(key, notification(), { Type: 'SubscriptionConfirmation', Token: 'test-token', SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(options.topicArns[0])}` });
    expect((await handleSesEvent(request(confirmation), { ...deps(), fetcher: async () => new Response('', { status: 500 }) })).status).toBe(503);
    expect((await read()).subscriptions[0].confirmedAt).toBeNull();
    expect((await handleSesEvent(request(confirmation), deps())).status).toBe(200);
    expect((await read()).subscriptions[0].confirmedAt).toBe(now);
    expect((await readSesStatus(store, { ...options, topicArns: [...options.topicArns, options.topicArns[0] + '-second'] }, 'eu-west-1')).subscriptions)
      .toEqual([{ topicArn: options.topicArns[0], confirmedAt: now }, { topicArn: options.topicArns[0] + '-second', confirmedAt: null }]);
    const badSignature = { ...body, Signature: 'AA==' };
    const badTopic = { ...body, TopicArn: options.topicArns[0] + '-other' };
    await handleSesEvent(request(badSignature), deps());
    await handleSesEvent(request(badTopic), deps());
    await handleSesEvent(request(body), { ...deps(), options: { ...options, accountIds: [] } });
    const observedAt = now;
    now--;
    await Promise.all(Array.from({ length: 8 }, () => handleSesEvent(request(body), deps())));
    await store.migrate();
    expect((await handleSesEvent(new Request('https://mail.example/v1/events/ses', { method: 'POST', body: '{}' }), deps())).status).toBe(400);
    expect(await read()).toMatchObject({ received: 14, lastReceivedAt: observedAt, rejected: { signature: 1, topic: 1, account: 1 } });
    const serialized = JSON.stringify(await read());
    for (const value of ['one@example.com', 'provider-1', 'test-token', body.Signature, badTopic.TopicArn]) expect(serialized).not.toContain(value);
    expect(await readSesStatus(store, undefined, 'eu-west-1')).toMatchObject({ configured: false, subscriptions: [], topicArns: [], accountIds: [] });
    await sql`drop table ses_status`.execute(store.db);
    await expect(read()).rejects.toThrow();
    expect((await handleSesEvent(request(confirmation), deps())).status).toBe(200);
    expect((await handleSesEvent(request(badSignature), deps())).status).toBe(403);
    expect((await handleSesEvent(request(body), deps())).status).toBe(503);
  });
});
