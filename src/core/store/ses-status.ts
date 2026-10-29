import { sql } from 'kysely';
import type { KyselyStore } from './index';
import type { SesOptions } from '../../events/sns';

export interface SesStatusV1 {
  version: 1;
  configured: boolean;
  region: string;
  topicArns: string[];
  accountIds: string[];
  subscriptions: { topicArn: string; confirmedAt: number | null }[];
  lastReceivedAt: number | null;
  lastReceivedType: string | null;
  received: number;
  rejected: { signature: number; topic: number; account: number };
}
type Row = { id: string; confirmed_at: number | null; received: number; rejected_signature: number;
  rejected_topic: number; rejected_account: number; last_received_at: number | null; last_received_type: string | null };
export async function readSesStatus(store: KyselyStore, options: SesOptions | undefined, region: string): Promise<SesStatusV1> {
  const rows = (await sql<Row>`select * from ses_status`.execute(store.db)).rows;
  const total = rows.find(row => row.id === 'total');
  return { version: 1, configured: !!options, region, topicArns: [...options?.topicArns ?? []], accountIds: [...options?.accountIds ?? []],
    subscriptions: (options?.topicArns ?? []).map(topicArn => ({ topicArn, confirmedAt: rows.find(row => row.id === topicArn)?.confirmed_at ?? null })),
    lastReceivedAt: total?.last_received_at ?? null, lastReceivedType: total?.last_received_type ?? null,
    received: total?.received ?? 0, rejected: { signature: total?.rejected_signature ?? 0, topic: total?.rejected_topic ?? 0, account: total?.rejected_account ?? 0 } };
}
export async function observeSes(store: KyselyStore, at: number, type: string, rejection?: 'signature' | 'topic' | 'account'): Promise<void> {
  await sql`insert into ses_status(id,received,rejected_signature,rejected_topic,rejected_account,last_received_at,last_received_type)
    values('total',1,${Number(rejection === 'signature')},${Number(rejection === 'topic')},${Number(rejection === 'account')},${at},${type})
    on conflict(id) do update set received=received+1,
    rejected_signature=rejected_signature+excluded.rejected_signature, rejected_topic=rejected_topic+excluded.rejected_topic,
    rejected_account=rejected_account+excluded.rejected_account,
    last_received_type=case when excluded.last_received_at >= last_received_at then excluded.last_received_type else last_received_type end,
    last_received_at=max(last_received_at,excluded.last_received_at)`.execute(store.db);
}
export async function confirmSes(store: KyselyStore, topic: string, at: number): Promise<void> {
  await sql`insert into ses_status(id,confirmed_at) values(${topic},${at})
    on conflict(id) do update set confirmed_at=max(confirmed_at,excluded.confirmed_at)`.execute(store.db);
}
