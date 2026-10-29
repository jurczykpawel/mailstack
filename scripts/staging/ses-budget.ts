// Imported exclusively by staging compositions. Never by src/ or production builds.
import type { SendDeps } from '../../src/types';
type Query = (sql: string, values?: (string | number)[]) => Promise<unknown[]>;
export function budgetSender(query: Query, sender: SendDeps['sendEmail'], limits = { day: 100, hour: 20 }, clock = Date.now): SendDeps['sendEmail'] {
  if (![limits.day, limits.hour].every(n => Number.isSafeInteger(n) && n > 0) || limits.day > 100 || limits.hour > 20) throw new Error('Invalid staging SES limits');
  return async (env, params) => {
    const deny = async (reason: string, status: number) => {
      try { await query('INSERT INTO st5_rejections(at,reason) VALUES(?,?)', [clock(), reason]); }
      catch { console.error('staging_ses_rejection_audit_unavailable'); }
      return { ok: false as const, status, response: reason };
    };
    // Failed/uncertain AWS calls retain their reservation. No clock buckets or in-memory counters.
    try {
      await query('CREATE TABLE IF NOT EXISTS st5_ses_budget(id TEXT PRIMARY KEY, at INTEGER NOT NULL, units INTEGER NOT NULL)');
      await query('CREATE INDEX IF NOT EXISTS st5_ses_budget_at ON st5_ses_budget(at)');
      await query('CREATE TABLE IF NOT EXISTS st5_rejections(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL)');
      const allowed = ['success', 'bounce', 'complaint', 'suppressionlist'].map(v => v + '@simulator.amazonses.com');
      if (params.from !== 'no-reply@mailstack-test.techskills.academy' || !params.to.length || params.to.some(v => !allowed.includes(v))) return deny('staging_recipient_not_allowed', 403);
      const now = clock(), units = params.to.length;
      const rows = await query(`INSERT INTO st5_ses_budget(id,at,units)
        SELECT ?,?,? WHERE
        COALESCE((SELECT SUM(units) FROM st5_ses_budget WHERE at>?),0)+?<=? AND
        COALESCE((SELECT SUM(units) FROM st5_ses_budget WHERE at>?),0)+?<=? RETURNING id`,
        [crypto.randomUUID(), now, units, now - 86400000, units, limits.day, now - 3600000, units, limits.hour]);
      if (!rows.length) return deny('staging_ses_limit', 429);
    } catch { return deny('staging_ses_store_unavailable', 503); }
    return sender(env, params);
  };
}
// Per-request state is provided by each composition; refusals remain explicit in the shared pipeline.
export async function budgetResponse(response: Response, reason?: string) {
  if (!reason) return response;
  return Response.json({ success: false, message: reason === 'staging_ses_limit' ? 'staging SES sending limit reached' : reason, code: reason },
    { status: reason === 'staging_ses_limit' ? 429 : 503, headers: response.headers });
}
