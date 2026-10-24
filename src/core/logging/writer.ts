import type { Config } from '../config/schema';
import { blindIndex, canonicalJson, createMac, refIndex, seal } from '../crypto';
import type { SealContext } from '../crypto';
import { parseKeyring } from '../keyring';
import type { KeyEnvironment } from '../keyring';
import type { MessageIntent, MessageStore, RecipientRow, SubjectRow } from '../store/messages';
import type { Brand, TemplateData, TemplateDef } from '../../types';
import { projectArchive } from './projection';
import { resolvePolicy } from './policy';

export class LogUnavailableError extends Error {
  readonly code = 'log_unavailable';
  constructor() { super('log unavailable'); this.name = 'LogUnavailableError'; }
}
export interface RecordDeps {
  store?: MessageStore; logging: Config['logging']; env: KeyEnvironment; now: () => Date;
}
export interface RecordInput {
  clientId: string; brand: Brand; template: TemplateDef; data: TemplateData;
  recipients: { role: RecipientRow['role']; address: string }[];
  replyTo?: string; subject?: string; ref?: string; idempotencyKey?: string; markup?: unknown[];
  provider?: string; providerAccount?: string;
}

function messageId(now: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(now) << 80n) | BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join(''));
  let id = '';
  for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; }
  return 'msg_' + id;
}

function addressHint(address: string): string {
  const [local, domain] = address.trim().split('@');
  const suffix = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${Array.from(local)[0]}***@${domain[0].toLowerCase()}***${suffix.toLowerCase()}`;
}

export async function recordIntent(deps: RecordDeps, input: RecordInput): Promise<{ id: string | undefined }> {
  const { policy, policy_hash } = await resolvePolicy(deps.logging, input.brand.id, input.template.id);
  if (policy.level === 'none') return { id: undefined };
  try {
    if (!deps.store) throw new LogUnavailableError();
    const { contentKeys, indexKeys } = parseKeyring(deps.env);
    const active = indexKeys[0];
    const now = deps.now();
    const at = now.getTime();
    const id = messageId(at);
    const context = { brand: input.brand.id, messageId: id };
    const encrypt = (data: unknown, purpose: SealContext['purpose']) => seal(data, { ...context, purpose }, contentKeys);
    const subject = input.subject ?? input.template.subject(input.brand, input.data);
    const expires = at + policy.contentDays * 86400000;
    const hasContent = policy.level === 'masked' || policy.level === 'full';
    const recipients: RecipientRow[] = [];
    const subjects: SubjectRow[] = [];
    const addSubject = async (role: SubjectRow['role'], address: string) => {
      const idx = await blindIndex(address, active);
      if (!subjects.some(s => s.role === role && s.addr_idx === idx.index))
        subjects.push({ message_id: id, role, addr_idx: idx.index, idx_kid: idx.kid });
    };
    for (const [pos, recipient] of input.recipients.entries()) {
      const idx = await blindIndex(recipient.address, active);
      recipients.push({ message_id: id, pos, role: recipient.role, addr_idx: idx.index, idx_kid: idx.kid,
        addr_sealed: await encrypt(recipient.address, 'rcpt'), addr_hint: addressHint(recipient.address), status: 'sending', last_event_at: null });
      await addSubject('recipient', recipient.address);
    }
    if (input.replyTo) await addSubject('reply_to', input.replyTo);
    for (const field of input.template.subjectRoles ?? []) {
      const address = input.data[field];
      if (address && /^[^\s@]+@[^\s@]+$/.test(address.trim())) await addSubject('submitter', address);
    }
    const request = { brand: input.brand.id, template: input.template.id, recipients: input.recipients, data: input.data, subject };
    const replay = { to: input.recipients.filter(r => r.role === 'to').map(r => r.address),
      ...(input.recipients.some(r => r.role === 'cc') ? { cc: input.recipients.filter(r => r.role === 'cc').map(r => r.address) } : {}),
      ...(input.recipients.some(r => r.role === 'bcc') ? { bcc: input.recipients.filter(r => r.role === 'bcc').map(r => r.address) } : {}),
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.subject !== undefined ? { subjectOverride: input.subject } : {}),
      template: input.template.id, data: input.data, ...(input.markup !== undefined ? { markup: input.markup } : {}) };
    const idemHash = input.idempotencyKey === undefined ? null : await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(canonicalJson([input.clientId, input.idempotencyKey])));
    const intent: MessageIntent = {
      message: {
        id, client_id: input.clientId, brand: input.brand.id, template: input.template.id, level: policy.level, policy_hash,
        status: 'sending', created_at: at, sent_at: null, provider: input.provider ?? null, provider_account: input.providerAccount ?? null,
        provider_message_id: null, provider_response_sealed: null, subject_sealed: await encrypt(subject, 'subject'),
        ref_idx: input.ref === undefined ? null : (await refIndex(input.ref, active)).index,
        ref_sealed: input.ref === undefined ? null : await encrypt(input.ref, 'ref'),
        idem_key_hash: idemHash === null ? null : btoa(String.fromCharCode(...new Uint8Array(idemHash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        request_mac: canonicalJson(await createMac(request, indexKeys)),
        replay_mac: policy.resend === 'replay' ? canonicalJson(await createMac(replay, indexKeys)) : null,
        resend_of: null, resend_root: null, attachments_meta: null,
        meta_expires_at: at + policy.metaDays * 86400000, content_expires_at: hasContent ? expires : null,
      }, recipients, subjects,
    };
    if (hasContent) intent.content = { message_id: id, expires_at: expires, sealed: await encrypt(projectArchive({
      policy, patterns: deps.logging.patterns, brand: input.brand, template: input.template, data: input.data, subject: input.subject,
      metadata: { clientId: input.clientId, status: 'sending', createdAt: now.toISOString() },
    }), 'content') };
    if (policy.resend === 'replay') intent.replay = { message_id: id, expires_at: expires, sealed: await encrypt(replay, 'replay') };
    await deps.store.insertMessage(intent);
    return { id };
  } catch { throw new LogUnavailableError(); }
}
