type Query = (sql: string, values?: (string | number)[]) => Promise<unknown[]>;
const schema = `CREATE TABLE IF NOT EXISTS staging_receiver(
  id INTEGER PRIMARY KEY, run TEXT NOT NULL, at INTEGER NOT NULL, eventId TEXT NOT NULL,
  bodyBase64 TEXT NOT NULL, headers TEXT NOT NULL, mode TEXT NOT NULL, decision TEXT NOT NULL)`;
export async function receiverCleanup(query: Query, now = Date.now()) {
  await query(schema);
  await query('DELETE FROM staging_receiver WHERE at<=?', [now - 86400000]);
}
export function receiver(query: Query, config: { token: string; key: string }, clock = Date.now,
  sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))) {
  if (![config.token, config.key].every(v => /^[A-Za-z0-9_-]{43}$/.test(v))) throw Error('Invalid receiver configuration');
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url), prefix = `/_staging/receiver/${config.token}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const run = url.pathname.slice(prefix.length), mode = url.searchParams.get('mode') ?? '204';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(run) || !['204', '500', 'timeout'].includes(mode)) return new Response(null, { status: 400 });
    if (req.method !== 'POST' && req.headers.get('authorization') !== `Bearer ${config.key}`) return new Response(null, { status: 401 });
    try {
      await receiverCleanup(query, clock());
      if (req.method === 'GET') return Response.json(await query('SELECT * FROM staging_receiver WHERE run=? ORDER BY id LIMIT 1000', [run]), {headers: {'Cache-Control': 'no-store'}});
      if (req.method === 'DELETE') { await query('DELETE FROM staging_receiver WHERE run=?', [run]); return new Response(null, { status: 204 }); }
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const headers = JSON.stringify(Object.fromEntries(req.headers));
      if (new TextEncoder().encode(headers).length > 16384 || Number(req.headers.get('content-length')) > 65536) return new Response(null, { status: 413 });
      const reader = req.body?.getReader(); let raw = '';
      if (reader) {
        while (true) {
          const {value, done} = await reader.read(); if (done) break;
          if (raw.length + value.length > 65536) { await reader.cancel(); return new Response(null, {status: 413}); }
          for (const byte of value) raw += String.fromCharCode(byte);
        }
      }
      let eventId = '';
      try { const id = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0)))).id; if (typeof id === 'string' && id.length <= 128) eventId = id; } catch { /* Non-JSON requests are still captured. */ }
      const rows = await query(`INSERT INTO staging_receiver(run,at,eventId,bodyBase64,headers,mode,decision)
        SELECT ?,?,?,?,?,?,CASE WHEN ?<>'' AND EXISTS(SELECT 1 FROM staging_receiver WHERE run=? AND eventId=?) THEN 'duplicate' ELSE 'accepted' END
        WHERE (SELECT COUNT(*) FROM staging_receiver)<1000 RETURNING id`,
        [run, clock(), eventId, btoa(raw), headers, mode, eventId, run, eventId]);
      if (!rows.length) return new Response(null, {status: 507});
      if (mode === 'timeout') await sleep(15000);
      return new Response(null, { status: mode === '500' ? 500 : 204 });
    } catch { return new Response(null, { status: 503 }); }
  };
}
