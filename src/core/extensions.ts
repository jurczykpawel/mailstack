import type { PanelPrincipal } from './panel';
import type { Kysely } from 'kysely';
import type { AuditEntry, AuditRow } from './audit';
import type { Config } from './config/schema';
import type { KeyProvider } from '../clients';

export interface DomainEvent {
  id: string;
  type: 'message.sent' | 'message.send_failed' | 'message.unknown' | 'message.delivered' | 'message.bounced' | 'message.complained' | 'form.submitted';
  at: number; brand: string; template: string; status: string; ref?: string; messageId: string;
}
export type ExtensionDatabase = Kysely<Record<string, Record<string, unknown>>>;
export interface ExtensionContext {
  panel?: PanelPrincipal;
  sesStatus?: () => Promise<import('./store/ses-status').SesStatusV1>;
  resend?: import('./resend-contract').ResendCapability;
  db: ExtensionDatabase;
  appendAudit: (entry: AuditEntry) => Promise<AuditRow>;
  now: () => number;
  config: { brands: string[]; logging: Config['logging'] };
}
export interface ExtensionApp {
  route(method: string, path: string, handler: (request: Request, ctx: ExtensionContext) => Response | Promise<Response>): void;
}
export interface MessageDeletion {
  reason: 'erase' | 'retention';
  messages: { id: string; brand: string; template: string }[];
}
export type BeforeMessageDelete = (selection: MessageDeletion) => Promise<void>;
export interface Extension {
  name: string;
  capabilities?: ('resend')[];
  migrate?(db: ExtensionDatabase): Promise<void>;
  onBeforeDelete?(selection: MessageDeletion, ctx: ExtensionContext): void | Promise<void>;
  onEvent?(event: DomainEvent, ctx: ExtensionContext): void | Promise<void>;
  routes?(app: ExtensionApp): void | Promise<void>;
  /** Supplies API keys beyond the core's single full key; receives the validated core configuration. */
  keys?(config: Config): KeyProvider | Promise<KeyProvider>;
}
export type EmitEvent = (event: Omit<DomainEvent, 'id'>, waitUntil?: (task: Promise<unknown>) => void) => void;
