import { createHash } from 'node:crypto';
import { canonicalJson } from './crypto';
import { auditHead, insertAudit, serializeAudit } from './store/audit';
import type { KyselyStore } from './store';

export interface AuditEntry {
  at: number; actor: string; action: string; target?: string | null; details?: unknown;
}
export interface AuditRow {
  seq: number; at: number; actor: string; action: string; target: string | null;
  details: string | null; prev_hash: string; hash: string;
}
export type AuditAnchor = Pick<AuditRow, 'seq' | 'hash'>;
export const AUDIT_GENESIS = '0'.repeat(64);
function digest(row: Omit<AuditRow, 'hash'>): string {
  return createHash('sha256').update([row.prev_hash, row.seq, row.at, row.actor, row.action,
    row.target ?? '', row.details ?? ''].join('\n')).digest('hex');
}
export function appendAudit(store: KyselyStore, entry: AuditEntry): Promise<AuditRow> {
  return serializeAudit(store, async () => {
    const details = entry.details === undefined ? null : canonicalJson(entry.details);
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await auditHead(store);
      const row: AuditRow = { seq: (head?.seq ?? 0) + 1, at: entry.at, actor: entry.actor,
        action: entry.action, target: entry.target ?? null, details, prev_hash: head?.hash ?? AUDIT_GENESIS, hash: '' };
      row.hash = digest(row);
      try { if (await insertAudit(store, row)) return row; }
      catch (error) {
        if (!(error instanceof Error) || !/UNIQUE constraint failed: audit.seq|PRIMARY KEY.*audit/i.test(error.message)) throw error;
      }
    }
    throw new Error('Audit append unavailable');
  });
}
export function verifyChain(rows: readonly AuditRow[], anchor?: AuditAnchor): boolean {
  if (!rows.length) return !anchor || (anchor.seq === 0 && anchor.hash === AUDIT_GENESIS);
  try {
    const first = rows[0];
    const anchoredStart = anchor?.seq === first.seq - 1 && anchor.hash === first.prev_hash;
    if (!anchoredStart && (first.seq !== 1 || first.prev_hash !== AUDIT_GENESIS)) {
      const boundary = rows.some(row => {
        if (row.action !== 'audit.pruned' || !row.details) return false;
        const marker = JSON.parse(row.details);
        return marker.upTo === first.seq - 1 && marker.hashAtUpTo === first.prev_hash;
      });
      if (!boundary) return false;
    }
    let previous: AuditAnchor = { seq: first.seq - 1, hash: first.prev_hash };
    for (const row of rows) {
      if (row.seq !== previous.seq + 1 || row.prev_hash !== previous.hash || row.hash !== digest(row)) return false;
      if (row.details !== null && canonicalJson(JSON.parse(row.details)) !== row.details) return false;
      previous = row;
    }
    return !anchor || anchoredStart || rows.some(row => row.seq === anchor.seq && row.hash === anchor.hash);
  } catch { return false; }
}
