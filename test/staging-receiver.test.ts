import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { receiver } from '../scripts/staging/receiver';
function setup() {
  const db = new Database(':memory:'); let now = 100000000;
  const query = async (sql: string, values: (string | number)[] = []) => {
    const s = db.prepare(sql); return s.reader ? s.all(...values) as any[] : (s.run(...values), []);
  };
  const sleep = vi.fn(async () => {});
  const handle = receiver(query, { token: 'a'.repeat(43), key: 'b'.repeat(43) }, () => now, sleep);
  const url = `https://staging.example/_staging/receiver/${'a'.repeat(43)}/run1`;
  const send = (suffix = '', body = '{"id":"evt_1"}') => handle(new Request(url + suffix, { method: 'POST', body, headers: { 'x-test': 'raw' } }));
  const read = (method = 'GET') => handle(new Request(url, { method, headers: { authorization: `Bearer ${'b'.repeat(43)}` } }));
  return { db, handle, url, send, read, sleep, advance: () => { now += 86400000; } };
}
it('records exact bytes, headers, attempts and a single decision per event and run', async () => {
  const s = setup();
  try {
    expect((await s.send())?.status).toBe(204);
    expect((await s.send('?mode=500'))?.status).toBe(500);
    expect((await s.send('?mode=timeout'))?.status).toBe(204);
    expect(s.sleep).toHaveBeenCalledWith(15000);
    const rows = await (await s.read())!.json() as any[];
    expect(rows.map(r => r.decision)).toEqual(['accepted', 'duplicate', 'duplicate']);
    expect(rows[0]).toMatchObject({ bodyBase64: btoa('{"id":"evt_1"}'), eventId: 'evt_1', run: 'run1', mode: '204' });
    expect(JSON.parse(rows[0].headers)).toHaveProperty('x-test', 'raw');
    expect((await s.handle(new Request(s.url)))?.status).toBe(401);
    expect(await s.handle(new Request(s.url.replace('a'.repeat(43), 'wrong')))).toBeNull();
    expect((await s.send('?mode=302'))?.status).toBe(400);
    expect((await s.send('', 'x'.repeat(65537)))?.status).toBe(413);
    s.advance(); expect(await (await s.read())!.json()).toEqual([]);
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
