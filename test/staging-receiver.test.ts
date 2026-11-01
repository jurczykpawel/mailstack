import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { receiver } from '../scripts/staging/receiver';
type CapturedRequest = { id: number; run: string; at: number; eventId: string; bodyBase64: string;
  headers: string; mode: string; decision: string };
type CapturePage = { requests: CapturedRequest[]; nextCursor: string | null };
function setup() {
  const db = new Database(':memory:'); let now = 100000000;
  const query = async (sql: string, values: (string | number)[] = []) => {
    const s = db.prepare(sql); return s.reader ? s.all(...values) as any[] : (s.run(...values), []);
  };
  const sleep = vi.fn(async () => {});
  const handle = receiver(query, { token: 'a'.repeat(43), key: 'b'.repeat(43) }, () => now, sleep);
  const url = `https://staging.example/_staging/receiver/${'a'.repeat(43)}/run1`;
  const send = (suffix = '', body = '{"id":"evt_1"}') => handle(new Request(url + suffix, { method: 'POST', body, headers: { 'x-test': 'raw' } }));
  const read = (method = 'GET', suffix = '') => handle(new Request(url + suffix, { method, headers: { authorization: `Bearer ${'b'.repeat(43)}` } }));
  return { db, handle, url, send, read, sleep, advance: () => { now += 86400000; } };
}
it('records exact bytes, headers, attempts and a single decision per event and run', async () => {
  const s = setup();
  try {
    expect((await s.send())?.status).toBe(204);
    expect((await s.send('?mode=500'))?.status).toBe(500);
    expect((await s.send('?mode=timeout'))?.status).toBe(204);
    expect(s.sleep).toHaveBeenCalledWith(15000);
    const { requests: rows, nextCursor } = await (await s.read())!.json() as CapturePage;
    expect(nextCursor).toBeNull();
    expect(rows.map(r => r.decision)).toEqual(['accepted', 'duplicate', 'duplicate']);
    expect(rows[0]).toMatchObject({ bodyBase64: btoa('{"id":"evt_1"}'), eventId: 'evt_1', run: 'run1', mode: '204' });
    expect(JSON.parse(rows[0].headers)).toHaveProperty('x-test', 'raw');
    expect((await s.handle(new Request(s.url)))?.status).toBe(401);
    expect(await s.handle(new Request(s.url.replace('a'.repeat(43), 'wrong')))).toBeNull();
    expect((await s.send('?mode=302'))?.status).toBe(400);
    expect((await s.send('', 'x'.repeat(65537)))?.status).toBe(413);
    s.advance(); expect(await (await s.read())!.json()).toEqual({ requests: [], nextCursor: null });
  } finally { s.db.close(); }
});
it('bounds stored rows, isolates cleanup by run and reports unavailable storage', async () => {
  const s = setup();
  try {
    await s.send();
    s.db.exec(`INSERT INTO staging_receiver(run,at,eventId,bodyBase64,headers,mode,decision)
      SELECT 'other',100000000,'other','','','204','accepted'`);
    expect((await s.read('DELETE'))?.status).toBe(204);
    expect(s.db.prepare('SELECT count(*) n FROM staging_receiver').get()).toEqual({n: 1});
    for (let i = 0; i < 1000; i++) await s.send();
    expect((await s.send())?.status).toBe(507);
  } finally { s.db.close(); }
  expect((await s.send())?.status).toBe(503);
});
it('records a single first receipt under concurrent D1 writes', async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-06-01',d1Databases:['DB']}));
  try {
    const db = await mf.getD1Database('DB');
    const query = async (sql: string, values: (string|number)[] = []) => (await db.prepare(sql).bind(...values).all()).results;
    const handle = receiver(query,{token:'a'.repeat(43),key:'b'.repeat(43)});
    const url = `https://staging.example/_staging/receiver/${'a'.repeat(43)}/concurrent`;
    const responses = await Promise.all(Array.from({length:12},()=>handle(new Request(url,{method:'POST',body:'{"id":"evt_1"}'}))));
    expect(responses.every(r=>r?.status===204)).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) n FROM staging_receiver WHERE decision='accepted'").first('n')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) n FROM staging_receiver').first('n')).toBe(12);
  } finally { await mf.dispose(); }
});

it('retrieves complete maximum-size requests across bounded ID pages', async () => {
  const s = setup();
  try {
    const expected = [];
    for (let i = 0; i < 25; i++) {
      const json = JSON.stringify({ id: 'shared', padding: '' });
      const body = i === 24 ? Buffer.from(Array.from({ length: 65536 }, (_, n) => n % 256))
        : Buffer.from(json.replace('"padding":""', '"padding":"' + 'x'.repeat(65536 - json.length) + '"'));
      const headers = { 'content-type': 'application/octet-stream', 'x-attempt': String(i), 'x-padding': '' };
      headers['x-padding'] = 'h'.repeat(16384 - JSON.stringify(Object.fromEntries(new Headers(headers))).length);
      expect(Buffer.byteLength(JSON.stringify(Object.fromEntries(new Headers(headers))))).toBe(16384);
      const mode = i % 2 ? '500' : '204';
      expect(body.length).toBe(65536);
      expect((await s.handle(new Request(s.url + '?mode=' + mode, { method: 'POST', body, headers })))?.status).toBe(Number(mode));
      expected.push({ id: i + 1, run: 'run1', at: 100000000, eventId: i === 24 ? '' : 'shared',
        bodyBase64: body.toString('base64'), headers: JSON.stringify(Object.fromEntries(new Headers(headers))),
        mode, decision: i === 0 || i === 24 ? 'accepted' : 'duplicate' });
    }
    // Store a different run and remove an ID to exercise gaps in the cursor.
    await s.handle(new Request(s.url.replace('run1', 'other'), { method: 'POST', body: 'other' }));
    s.db.prepare('DELETE FROM staging_receiver WHERE id=?').run(7);
    expected.splice(6, 1);
    const loaded: unknown[] = [];
    const query = vi.fn(async (sql: string, values: (string | number)[] = []) => {
      const statement = s.db.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    });
    const handle = receiver(query, { token: 'a'.repeat(43), key: 'b'.repeat(43) }, () => 100000000);
    let after = '0';
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const response = await handle(new Request(s.url + '?after=' + after, { headers: { authorization: `Bearer ${'b'.repeat(43)}` } }));
      expect(response?.status).toBe(200);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      const page = await response!.json() as CapturePage;
      expect(page.requests).toHaveLength(pageNumber < 2 ? 10 : 4);
      loaded.push(...page.requests);
      expect(page.nextCursor).toBe(pageNumber < 2 ? String(page.requests.at(-1)!.id) : null);
      after = page.nextCursor ?? '0';
    }
    expect(loaded).toEqual(expected);
    const selects = query.mock.calls.filter(([sql]) => sql.startsWith('SELECT'));
    expect(selects).toHaveLength(3);
    for (const [sql, values = []] of selects) {
      expect(sql).toMatch(/WHERE run=\? AND id>\? ORDER BY id LIMIT \?/);
      expect(values[2]).toBe(11);
      expect(s.db.prepare(sql).all(...values).length).toBeLessThanOrEqual(11);
    }
    expect(await (await s.read('GET', '?after=25'))!.json()).toEqual({ requests: [], nextCursor: null });
  } finally { s.db.close(); }
});
it.each(['', '-1', '1.5', '1e2', 'abc', '9007199254740992', '01'])('rejects invalid read cursor %j', async after => {
  const s = setup();
  try { expect((await s.read('GET', '?after=' + after))?.status).toBe(400); }
  finally { s.db.close(); }
});
