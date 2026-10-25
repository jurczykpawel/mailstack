import type { CompiledQuery, Generated, Insertable, Kysely, Selectable } from 'kysely';

export type MessageStatus = 'sending' | 'sent' | 'send_failed' | 'unknown' | 'accepted' | 'delay' | 'delivered' | 'bounce_permanent' | 'bounce_transient' | 'bounce_undetermined' | 'reject' | 'render_failure';
export interface MessageTable {
  id: string; client_id: string; brand: string; template: string;
  level: 'meta' | 'masked' | 'full'; policy_hash: string; status: MessageStatus;
  complained: Generated<number>; created_at: number; sent_at: number | null;
  provider: string | null; provider_account: string | null; provider_message_id: string | null;
  provider_response_sealed: string | null; subject_sealed: string | null;
  ref_idx: string | null; ref_sealed: string | null; idem_key_hash: string | null;
  request_mac: string | null; replay_mac: string | null;
  resend_of: string | null; resend_root: string | null; attachments_meta: string | null;
  meta_expires_at: number; content_expires_at: number | null;
}
export interface RecipientRow {
  message_id: string; pos: number; role: 'to' | 'cc' | 'bcc'; addr_idx: string; idx_kid: string;
  addr_sealed: string; addr_hint: string; status: MessageStatus; last_event_at: number | null;
}
export interface SubjectRow {
  message_id: string; role: 'recipient' | 'reply_to' | 'submitter'; addr_idx: string; idx_kid: string;
}
export interface SealedRow { message_id: string; sealed: string; expires_at: number }
export interface Database {
  guards: { key: string; count: number; expires_at: number };
  messages: MessageTable; recipients: RecipientRow; subjects: SubjectRow;
  contents: SealedRow; replays: SealedRow;
}
export type MessageRow = Selectable<MessageTable>;
export interface MessageIntent {
  message: Insertable<MessageTable>; recipients: RecipientRow[]; subjects: SubjectRow[];
  content?: SealedRow; replay?: SealedRow;
}
export interface SentUpdate { providerMessageId: string; providerResponseSealed: string; sentAt: number }
export interface MessageStore {
  alertContext(id: string, pos?: number): Promise<{ brand: string; template: string; addr_hint: string } | undefined>;
  clearIdempotency(id: string, keyHash: string): Promise<void>;
  insertMessage(intent: MessageIntent): Promise<void>;
  markSent(id: string, update: SentUpdate): Promise<void>;
  markFailed(id: string, providerResponseSealed: string): Promise<void>;
  setStatus(id: string, status: MessageStatus): Promise<void>;
  findByIdempotency(clientId: string, keyHash: string): Promise<MessageRow | undefined>;
}
export type AtomicBatch = (queries: CompiledQuery[]) => Promise<number[]>;

export class MessageOperations implements MessageStore {
  constructor(readonly db: Kysely<Database>, private readonly atomic?: AtomicBatch) {}

  async alertContext(id: string, pos?: number) {
    return this.db.selectFrom('messages').leftJoin('recipients', join => join.onRef('recipients.message_id', '=', 'messages.id')
      .on('recipients.pos', '=', pos ?? 0)).select(['brand', 'template', 'addr_hint']).where('messages.id', '=', id)
      .executeTakeFirst().then(row => row ? { ...row, addr_hint: row.addr_hint ?? 'unassigned' } : undefined);
  }

  async batch(queries: CompiledQuery[]): Promise<number[]> {
    if (this.atomic) return this.atomic(queries);
    return this.db.transaction().execute(async tx => {
      const changes: number[] = [];
      for (const query of queries) changes.push(Number((await tx.executeQuery(query)).numAffectedRows ?? 0));
      return changes;
    });
  }

  async insertMessage(intent: MessageIntent): Promise<void> {
    const { message, recipients, subjects, content, replay } = intent;
    if (recipients.some(r => r.message_id !== message.id) || subjects.some(r => r.message_id !== message.id) ||
        (content && content.message_id !== message.id) || (replay && replay.message_id !== message.id)) throw new Error('Invalid message rows');
    const queries = [this.db.insertInto('messages').values(message).compile()];
    for (const row of recipients) queries.push(this.db.insertInto('recipients').values(row).compile());
    for (const row of subjects) queries.push(this.db.insertInto('subjects').values(row).compile());
    if (content) queries.push(this.db.insertInto('contents').values(content).compile());
    if (replay) queries.push(this.db.insertInto('replays').values(replay).compile());
    await this.batch(queries);
  }

  async clearIdempotency(id: string, keyHash: string): Promise<void> {
    await this.db.updateTable('messages').set({ idem_key_hash: null }).where('id', '=', id)
      .where('idem_key_hash', '=', keyHash).where('status', '=', 'send_failed').execute();
  }

  async markSent(id: string, update: SentUpdate): Promise<void> {
    await this.db.updateTable('messages').set({ status: 'sent', provider_message_id: update.providerMessageId,
      provider_response_sealed: update.providerResponseSealed, sent_at: update.sentAt }).where('id', '=', id).execute();
  }

  async markFailed(id: string, providerResponseSealed: string): Promise<void> {
    await this.db.updateTable('messages').set({ status: 'send_failed', provider_response_sealed: providerResponseSealed })
      .where('id', '=', id).execute();
  }

  async setStatus(id: string, status: MessageStatus): Promise<void> {
    await this.db.updateTable('messages').set({ status }).where('id', '=', id).execute();
  }

  async findByIdempotency(clientId: string, keyHash: string): Promise<MessageRow | undefined> {
    return this.db.selectFrom('messages').selectAll().where('client_id', '=', clientId)
      .where('idem_key_hash', '=', keyHash).executeTakeFirst();
  }
}
