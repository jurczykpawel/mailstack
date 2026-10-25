import type { Kysely } from 'kysely';
import type { AuditEntry, AuditRow } from './audit';
import type { Config } from './config/schema';

export interface DomainEvent {
  id: string;
  type: 'message.sent' | 'message.send_failed' | 'message.unknown' | 'message.delivered' | 'message.bounced' | 'message.complained' | 'form.submitted';
  at: number; brand: string; template: string; status: string; ref?: string; messageId?: string;
}
export type ExtensionDatabase = Kysely<Record<string, Record<string, unknown>>>;
export interface ExtensionContext {
  db: ExtensionDatabase;
  appendAudit: (entry: AuditEntry) => Promise<AuditRow>;
  now: () => number;
  config: { brands: string[]; logging: Config['logging'] };
}
export interface ExtensionApp {
  route(method: string, path: string, handler: (request: Request, ctx: ExtensionContext) => Response | Promise<Response>): void;
}
export interface Extension {
  name: string;
  migrate?(db: ExtensionDatabase): Promise<void>;
  onEvent?(event: DomainEvent, ctx: ExtensionContext): void | Promise<void>;
  routes?(app: ExtensionApp): void | Promise<void>;
}
export type EmitEvent = (event: Omit<DomainEvent, 'id'>, waitUntil?: (task: Promise<unknown>) => void) => void;
