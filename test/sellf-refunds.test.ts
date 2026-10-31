import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { config } from '../src/core/config';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { open } from '../src/core/crypto';
import { idempotencyHash } from '../src/core/logging/writer';
import { tokenSha256 } from '../src/clients';
import { handleSellfHook } from './sellf-source-helper';
import { bundlePurchase } from './purchase-license-fixture';
import type { Env, SendDeps } from '../src/types';

// Synthetic refund sequence matching the source's cumulative-refund contract.
function refundEnvelope(id = 're_1', amount = 3000, totalRefunded = 3000, isFullRefund = false) {
  return { event: 'refund.issued', timestamp: '2026-10-28T22:12:43Z', data: {
    customer: { email: 'buyer@example.com', userId: null },
    product: { id: 'bundle', name: 'Pakiet Żółw', slug: 'pakiet', price: 123, currency: 'PLN', icon: null },
    payment: { id: 'payment-1', amount: 12300, currency: 'PLN', sessionId: 'cs_payment', paymentIntentId: 'pi_payment', statusBefore: 'completed', statusAfter: 'completed' },
    refund: { stripeRefundId: id, amount, currency: 'pln', reason: null as string | null, status: 'succeeded', isFullRefund, totalRefunded, refundedAt: '2026-10-28T22:12:00Z', source: 'admin' },
  } };
}
const pair = generateKeyPairSync('x25519');
const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', kid: 'c1' };
const env = { API_KEY: 'test-key',
  CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }),
  INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]),
} as Env;

for (const driver of ['sqlite', 'd1'] as const) describe(`Sellf refunds: ${driver}`, () => {
  let store: KyselyStore;
  let mf: Miniflare | undefined;
  let deps: SendDeps;
  let now: number;
  const originalClients = structuredClone(config.clients);
  const request = (body: unknown, brand = 'acme', token = 'test-key') => handleSellfHook(new Request(`https://mail.example/v1/hooks/sellf?brand=${brand}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), env, deps);
  const mails = () => vi.mocked(deps.sendEmail).mock.calls.map(call => call[1]);
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  beforeEach(async () => {
    await store.db.deleteFrom('messages').execute();
    await store.db.deleteFrom('guards').execute();
    now = Date.parse('2026-10-28T22:12:43Z');
    deps = { store, logging: structuredClone(config.logging), now: () => new Date(now),
      verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(), emitEvent: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200 }) };
    deps.logging!.defaults.level = 'meta';
  });
  afterEach(() => { config.clients = structuredClone(originalClients); vi.restoreAllMocks(); });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

  for (const event of ['purchase', 'refund'] as const) {
    const envelope = () => event === 'purchase' ? bundlePurchase() : refundEnvelope();
    it.each(['meta', 'masked', 'full'] as const)(`${event} waits for a recorded result at level %s`, async level => {
      deps.logging!.defaults.level = level;
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const insert = store.insertMessage.bind(store);
      vi.spyOn(store, 'insertMessage').mockImplementationOnce(async intent => {
        entered.resolve();
        await resume.promise;
        await insert(intent);
      });
      const winner = request(envelope());
      await entered.promise;
      const reads = vi.spyOn(store, 'findByIdempotency');
      try {
        const duplicate = await request(envelope());
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toEqual({ success: false, code: 'in_progress', message: 'in progress' });
        expect(reads.mock.calls.length).toBeGreaterThan(2);
        expect(reads.mock.calls.length).toBeLessThanOrEqual(6);
        expect(mails()).toHaveLength(0);
      } finally { resume.resolve(); await winner; }
      const response = await winner;
      expect(response.status).toBe(200);
      const body = await response.json() as { id: string };
      expect(body.id).toMatch(/^msg_/);
      expect(await (await request(envelope())).json()).toEqual({ ...body, idempotent: true });
      expect(mails()).toHaveLength(1);
      expect(await store.db.selectFrom('messages').selectAll().execute()).toHaveLength(1);
    });

    it.each(['meta', 'masked', 'full'] as const)(`${event} keeps read failures pending at level %s`, async level => {
      deps.logging!.defaults.level = level;
      for (const requireLog of [false, true]) for (const failedRead of [2, 3]) {
        deps.logging!.defaults.requireLog = requireLog;
        await store.db.deleteFrom('messages').execute();
        await store.db.deleteFrom('guards').execute();
        vi.mocked(deps.sendEmail).mockClear();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const insert = store.insertMessage.bind(store);
        const insertion = vi.spyOn(store, 'insertMessage').mockImplementationOnce(async intent => {
          entered.resolve(); await resume.promise; await insert(intent);
        });
        const winner = request(envelope());
        await entered.promise;
        const find = store.findByIdempotency.bind(store);
        let reads = 0;
        const reading = vi.spyOn(store, 'findByIdempotency').mockImplementation(async (...args) => {
          if (++reads === failedRead) throw new Error('Unavailable');
          return find(...args);
        });
        try {
          const duplicate = await request(envelope());
          expect(duplicate.status).toBe(409);
          expect(await duplicate.json()).toEqual({ success: false, code: 'in_progress', message: 'in progress' });
          expect(mails()).toHaveLength(0);
        } finally {
          resume.resolve(); await winner;
          reading.mockRestore(); insertion.mockRestore();
        }
        const original = await winner;
        expect(original.status).toBe(200);
        const body = await original.json() as { id: string };
        expect(body.id).toMatch(/^msg_/);
        expect(await (await request(envelope())).json()).toEqual({ ...body, idempotent: true });
        expect(mails()).toHaveLength(1);
        expect(await store.db.selectFrom('messages').selectAll().execute()).toHaveLength(1);
      }
    });

    it(`${event} returns the completed result when it becomes readable`, async () => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const insert = store.insertMessage.bind(store);
      vi.spyOn(store, 'insertMessage').mockImplementationOnce(async intent => {
        entered.resolve(); await resume.promise; await insert(intent);
      });
      const winner = request(envelope());
      await entered.promise;
      const find = store.findByIdempotency.bind(store);
      let reads = 0;
      vi.spyOn(store, 'findByIdempotency').mockImplementation(async (...args) => {
        if (++reads === 2) {
          resume.resolve();
          await winner;
          return undefined;
        }
        return find(...args);
      });
      try {
        const duplicate = await request(envelope());
        expect(duplicate.status).toBe(200);
        const original = await winner;
        expect(await duplicate.json()).toEqual({ ...await original.json() as object, idempotent: true });
        expect(reads).toBeGreaterThan(2);
        expect(mails()).toHaveLength(1);
      } finally { resume.resolve(); await winner; }
    });

    it.each(['refusal', 'write failure'] as const)(`${event} keeps pending and %s results separate`, async outcome => {
      deps.logging!.defaults.requireLog = true;
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const insert = store.insertMessage.bind(store);
      vi.spyOn(store, 'insertMessage').mockImplementationOnce(async intent => {
        entered.resolve(); await resume.promise;
        if (outcome === 'write failure') throw new Error('Unavailable');
        await insert(intent);
      });
      if (outcome === 'refusal') vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
      const winner = request(envelope());
      await entered.promise;
      try {
        const duplicate = await request(envelope());
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toMatchObject({ success: false, code: 'in_progress' });
        expect(mails()).toHaveLength(0);
      } finally { resume.resolve(); await winner; }
      const failed = await winner;
      expect(failed.status).toBe(outcome === 'refusal' ? 502 : 503);
      expect(await failed.json()).toMatchObject({ code: outcome === 'refusal' ? 'send_failed' : 'log_unavailable' });
      const retried = await request(envelope());
      expect(retried.status).toBe(200);
      const body = await retried.json() as { id: string };
      expect(body.id).toMatch(/^msg_/);
      expect(await (await request(envelope())).json()).toEqual({ ...body, idempotent: true });
      expect(mails()).toHaveLength(outcome === 'refusal' ? 2 : 1);
    });

    it(`${event} retains the unrecorded duplicate response at none`, async () => {
      deps.logging!.defaults.level = 'none';
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      vi.mocked(deps.sendEmail).mockImplementationOnce(async () => {
        entered.resolve(); await resume.promise; return { ok: true, status: 200 };
      });
      const winner = request(envelope());
      await entered.promise;
      try {
        expect(await (await request(envelope())).json()).toEqual({ success: true, idempotent: true });
        const reading = vi.spyOn(store, 'findByIdempotency')
          .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Unavailable'));
        try {
          expect(await (await request(envelope())).json()).toEqual({ success: true, idempotent: true });
        } finally { reading.mockRestore(); }
      } finally { resume.resolve(); await winner; }
      expect(await (await winner).json()).toEqual({ success: true });
      expect(await (await request(envelope())).json()).toEqual({ success: true, idempotent: true });
      expect(mails()).toHaveLength(1);
      expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
    });
  }

  it('sends both partial refunds and retains each duplicate result', async () => {
    const first = refundEnvelope();
    const second = refundEnvelope('re_2', 2000, 5000);
    const a = await request(first);
    const b = await request(second);
    expect([a.status, b.status]).toEqual([200, 200]);
    const aBody = await a.json() as { id: string };
    const bBody = await b.json() as { id: string };
    expect(aBody.id).toMatch(/^msg_/);
    expect(bBody.id).toMatch(/^msg_/);
    expect(aBody.id).not.toBe(bBody.id);
    expect(await (await request(first)).json()).toEqual({ ...aBody, idempotent: true });
    expect(await (await request(second)).json()).toEqual({ ...bBody, idempotent: true });
    expect(mails()).toHaveLength(2);
    expect(mails()[0].text).toContain('Zwróciliśmy 30.00 PLN');
    expect(mails()[1].text).toContain('Zwróciliśmy 20.00 PLN');
    expect(mails()[1].text).toContain('Łącznie zwrócono: 50.00 PLN');
    const rows = await store.db.selectFrom('messages').selectAll().execute();
    for (const row of rows) expect(await open(row.ref_sealed!, { brand: 'acme', messageId: row.id, purpose: 'ref' }, [privateKey])).toBe('pi_payment');
  });

  it('renders every refund detail in HTML and text for partial and full refunds', async () => {
    deps.logging!.defaults.level = 'full';
    const partial = refundEnvelope();
    const full = refundEnvelope('re_full', 12300, 12300, true);
    full.data.payment.id = 'payment-full';
    full.data.payment.sessionId = 'cs_full';
    full.data.payment.paymentIntentId = 'pi_full';
    full.data.refund.reason = 'requested_by_customer';
    expect((await request(partial)).status).toBe(200);
    expect((await request(full)).status).toBe(200);
    for (const [i, body] of [partial, full].entries()) {
      for (const content of [mails()[i].html, mails()[i].text]) {
        for (const value of ['Pakiet Żółw', body.data.payment.id, body.data.payment.paymentIntentId, body.data.refund.stripeRefundId,
          'Status zwrotu: zakończony (succeeded)', `Zakres zwrotu: ${i ? 'pełny' : 'częściowy'}`, body.data.refund.refundedAt,
          `Łącznie zwrócono: ${i ? '123.00' : '30.00'} PLN`]) expect(content).toContain(value);
      }
    }
    expect(mails()[0].text).not.toContain('Powód:');
    expect(mails()[1].text).toContain('Powód: requested_by_customer');
    expect(mails()[1].text).toContain('Zwróciliśmy 123.00 PLN');
    const rows = await store.db.selectFrom('messages').selectAll().execute();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const content = await store.db.selectFrom('contents').selectAll().where('message_id', '=', row.id).executeTakeFirstOrThrow();
      const archive = await open(content.sealed, { brand: 'acme', messageId: row.id, purpose: 'content' }, [privateKey]);
      const saved = archive as { html: string; text: string };
      const mail = mails().find(mail => mail.text === saved.text);
      expect(mail).toBeDefined();
      expect(saved.html).toBe(mail!.html);
    }
  });

  it.each([true, false])('archives the known refund scope with default masked fields: %s', async isFullRefund => {
    deps.logging!.defaults.level = 'masked';
    delete deps.logging!.defaults.show;
    const body = refundEnvelope('re_scope', 12300, 12300, isFullRefund);
    body.data.refund.reason = 'PRIVATE-REASON';
    expect((await request(body)).status).toBe(200);
    for (const output of [mails()[0].html, mails()[0].text]) {
      expect(output).toContain(`Zakres zwrotu: ${isFullRefund ? 'pełny' : 'częściowy'}.`);
      expect(output).toContain('Powód: PRIVATE-REASON');
    }
    const [row] = await store.db.selectFrom('messages').selectAll().execute();
    const content = await store.db.selectFrom('contents').selectAll().where('message_id', '=', row.id).executeTakeFirstOrThrow();
    const saved = await open(content.sealed, { brand: 'acme', messageId: row.id, purpose: 'content' }, [privateKey]) as { html: string; text: string };
    for (const output of [saved.html, saved.text]) {
      expect(output).toContain(`Zakres zwrotu: ${isFullRefund ? 'pełny' : 'częściowy'}.`);
      expect(output).toContain('123.00 PLN');
      expect(output).toContain('Powód: [ukryte]');
      expect(output).not.toContain('PRIVATE-REASON');
      expect(output).not.toContain(body.data.customer.email);
    }
  });

  it.each(['meta', 'masked', 'full'] as const)('compares changed refund content at level %s', async level => {
    deps.logging!.defaults.level = level;
    const body = refundEnvelope('re_2', 2000, 5000);
    await request(body);
    body.data.refund.totalRefunded = 6000;
    const response = await request(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(mails()).toHaveLength(1);
  });

  it('sends the second refund once while parallel requests are pending', async () => {
    await request(refundEnvelope());
    let complete!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const sending = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(deps.sendEmail).mockImplementationOnce(async () => { entered(); await pending; return { ok: true, status: 200 }; });
    const second = refundEnvelope('re_2', 2000, 5000);
    const winner = request(second);
    await sending;
    try {
      const duplicate = await request(second);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: 'in_progress' });
    } finally { complete(); }
    const response = await winner;
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; id: string };
    expect(await (await request(second)).json()).toEqual({ ...body, idempotent: true });
    expect(mails()).toHaveLength(2);
  });

  it.each(['meta', 'none'] as const)('isolates two brands and two clients at level %s', async level => {
    deps.logging!.defaults.level = level;
    const tokens = ['msk_app-a_' + 'a'.repeat(43), 'msk_app-b_' + 'b'.repeat(43)];
    config.clients = await Promise.all(tokens.map(async (token, i) => ({ id: `app-${i ? 'b' : 'a'}`, tokenSha256: await tokenSha256(token), scopes: ['hook:sellf'] as ['hook:sellf'], brands: ['acme', 'demo'], templates: ['refund'], recipientOverride: false, attachments: false })));
    for (const token of tokens) for (const brand of ['acme', 'demo']) {
      expect((await request(refundEnvelope(), brand, token)).status).toBe(200);
      expect(await (await request(refundEnvelope(), brand, token)).json()).toMatchObject({ success: true, idempotent: true });
    }
    expect(mails()).toHaveLength(4);
  });

  it.each(['meta', 'none'] as const)('allows retry after explicit provider refusal at level %s', async level => {
    deps.logging!.defaults.level = level;
    vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
    expect((await request(refundEnvelope())).status).toBe(502);
    expect((await request(refundEnvelope())).status).toBe(200);
    expect(await (await request(refundEnvelope())).json()).toMatchObject({ success: true, idempotent: true });
    expect(mails()).toHaveLength(2);
  });

  it('deduplicates each refund at none without comparing content', async () => {
    deps.logging!.defaults.level = 'none';
    for (const body of [refundEnvelope(), refundEnvelope('re_2', 2000, 5000)]) {
      expect(await (await request(body)).json()).toEqual({ success: true });
      body.data.refund.totalRefunded += 100;
      expect(await (await request(body)).json()).toEqual({ success: true, idempotent: true });
    }
    expect(mails()).toHaveLength(2);
    expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
  });

  it.each([undefined, null, '', ' '])('declines invalid refund identifiers before any storage or send: %j', async id => {
    const body = refundEnvelope();
    const response = await request({ ...body, data: { ...body.data, refund: { ...body.data.refund, stripeRefundId: id } } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'invalid_event_data', fields: ['refundId'] });
    expect(mails()).toEqual([]);
    expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
    expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
  });

  it.each([undefined, null, '', 'pending', 'failed'])('leaves refund status validation to the sender: %j', async status => {
    const body = refundEnvelope();
    expect((await request({ ...body, data: { ...body.data, refund: { ...body.data.refund, status } } })).status).toBe(200);
    expect(mails()).toHaveLength(1);
    expect(await store.db.selectFrom('messages').selectAll().execute()).toHaveLength(1);
  });

  it.each(['payment', 'refund'])('accepts numeric %s identifiers as template content', async kind => {
    const body = refundEnvelope();
    if (kind === 'payment') body.data.payment.id = 123 as unknown as string;
    else body.data.refund.stripeRefundId = 123 as unknown as string;
    expect((await request(body)).status).toBe(200);
    expect(mails()[0].text).toContain('123');
  });

  it.each(['meta', 'none'] as const)('retains the 24-hour lifetime at level %s', async level => {
    deps.logging!.defaults.level = level;
    await request(refundEnvelope());
    now += 86400000 - 1;
    await store.purgeGuards(now);
    expect(await (await request(refundEnvelope())).json()).toMatchObject({ idempotent: true });
    now++;
    await store.purgeGuards(now);
    const response = await request(refundEnvelope());
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('idempotent');
    expect(mails()).toHaveLength(2);
  });

  it('does not match a previously stored payment-based refund key', async () => {
    deps.logging!.defaults.level = 'none';
    const oldHash = await idempotencyHash('legacy', 'sellf:refund.issued:cs_payment');
    await store.claimIdempotency('legacy', oldHash, now, false);
    expect(await (await request(refundEnvelope())).json()).toEqual({ success: true });
    expect(mails()).toHaveLength(1);
    expect(await store.db.selectFrom('guards').selectAll().execute()).toHaveLength(2);
  });

  it('deduplicates concurrent copies of the second refund at none', async () => {
    deps.logging!.defaults.level = 'none';
    await request(refundEnvelope());
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(refundEnvelope('re_2', 2000, 5000))));
    expect(responses.every(r => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(async r => await r.json() as { idempotent?: true }));
    expect(bodies.filter(body => body.idempotent)).toHaveLength(7);
    expect(mails()).toHaveLength(2);
  });

  it.each([undefined, null, '', ' '])('declines invalid payment identifiers without recording: %j', async id => {
    const body = refundEnvelope();
    expect((await request({ ...body, data: { ...body.data, payment: { ...body.data.payment, id } } })).status).toBe(422);
    expect(mails()).toEqual([]);
    expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
    expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
  });

  it.each(['brands', 'templates', 'scopes'] as const)('retains client %s restrictions', async field => {
    const token = 'msk_restricted_' + 'a'.repeat(43);
    config.clients = [{ id: 'restricted', tokenSha256: await tokenSha256(token), scopes: ['hook:sellf'], brands: ['acme'], templates: ['refund'], recipientOverride: false, attachments: false }];
    config.clients[0][field] = [];
    expect((await request(refundEnvelope(), 'acme', token)).status).toBe(403);
    expect(mails()).toEqual([]);
    expect(await store.db.selectFrom('guards').selectAll().execute()).toEqual([]);
  });

  it('uses the session identifier when the payment intent is absent and escapes supplied text', async () => {
    const body = refundEnvelope();
    const { paymentIntentId: _pi, ...payment } = body.data.payment;
    body.data.product.name = '<b>Żółw & Co</b>';
    body.data.refund.reason = '<b>request & reason</b>';
    expect((await request({ ...body, data: { ...body.data, payment } })).status).toBe(200);
    expect(mails()[0].text).toContain('Numer transakcji: cs_payment');
    expect(mails()[0].html).toContain('&lt;b&gt;Żółw &amp; Co&lt;/b&gt;');
    expect(mails()[0].html).toContain('&lt;b&gt;request &amp; reason&lt;/b&gt;');
    expect(mails()[0].html).not.toContain('<b>request');
    const [row] = await store.db.selectFrom('messages').selectAll().execute();
    expect(await open(row.ref_sealed!, { brand: 'acme', messageId: row.id, purpose: 'ref' }, [privateKey])).toBe('cs_payment');
  });
});
