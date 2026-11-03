import type { PanelPrincipal } from './panel';
import type { CompiledQuery, Kysely } from 'kysely';
import type { AuditEntry, AuditRow } from './audit';
import type { Config } from './config/schema';
import type { KeyProvider } from '../clients';

export interface DomainEvent {
  id: string;
  type: 'message.sent' | 'message.send_failed' | 'message.unknown' | 'message.delivered' | 'message.bounced' | 'message.complained' | 'form.submitted';
  at: number; brand: string; template: string; status: string; ref?: string; messageId: string;
  /** Durable events carry the SHA-256 of `ref` (only for consumers with `eventRef`), never `ref` itself. */
  refDigest?: string;
}
/** `ack` once every delivery of the event is stored; `partial` names the last stored endpoint when more remain. */
export type EventAck = { ack: true } | { partial: string };
/** Sandboxed to `ext_<name>_*`; `batch` validates every element, then runs them atomically (any rejection refuses the whole batch). */
export type ExtensionDatabase = Kysely<Record<string, Record<string, unknown>>> & { batch(queries: { compile(): CompiledQuery }[]): Promise<number[]> };
export interface ExtensionContext {
  panel?: PanelPrincipal;
  sesStatus?: () => Promise<import('./store/ses-status').SesStatusV1>;
  resend?: import('./resend-contract').ResendCapability;
  db: ExtensionDatabase;
  appendAudit: (entry: AuditEntry) => Promise<AuditRow>;
  now: () => number;
  config: { brands: string[]; logging: Config['logging'] };
}
/** Route handlers always run after the core panel gate and receive its verified principal. */
export type ExtensionRouteContext = ExtensionContext & { panel: PanelPrincipal };
export interface ExtensionApp {
  route(method: string, path: string, handler: (request: Request, ctx: ExtensionRouteContext) => Response | Promise<Response>): void;
}
export interface MessageDeletion {
  reason: 'erase' | 'retention';
  messages: { id: string; brand: string; template: string }[];
}
export type BeforeMessageDelete = (selection: MessageDeletion) => Promise<void>;
export interface Extension {
  name: string;
  capabilities?: ('resend')[];
  /** Schema only, as Kysely schema-builder statements; compiled at setup (Worker) or start (Node) with a ledger row. */
  migrations?: import('./ext-migrations').ExtensionMigration[];
  /** Idempotent data reconciliation for configuration `configSha`, resumable from `cursor`; runs as a job. */
  reconcile?(db: ExtensionDatabase, state: { configSha: string; cursor: string | null }): Promise<import('./ext-migrations').ReconcileStep>;
  /** Legacy schema and data setup at host start, kept until extensions move to `migrations` and `reconcile`. */
  migrate?(db: ExtensionDatabase): Promise<void>;
  onBeforeDelete?(selection: MessageDeletion, ctx: ExtensionContext): void | Promise<void>;
  /**
   * Durable events arrive from the `fanout` job, resuming after endpoint `resume`; the cursor moves only on `{ack: true}`.
   * Events without a durable row (level none, no storage) arrive once from memory and the result is ignored.
   */
  onEvent?(event: DomainEvent, ctx: ExtensionContext, resume?: string | null): void | EventAck | Promise<void | EventAck>;
  /** The consumer forwards `ref` digests: durable events then store SHA-256 of `ref` (otherwise the column stays empty). */
  eventRef?: boolean;
  routes?(app: ExtensionApp): void | Promise<void>;
  /** Supplies API keys beyond the core's single full key; receives the validated core configuration. */
  keys?(config: Config): KeyProvider | Promise<KeyProvider>;
}
/** `durable`: the event is already stored for the fan-out job, so it is not delivered from memory. */
export type EmitEvent = (event: Omit<DomainEvent, 'id'> & { durable?: boolean }, waitUntil?: (task: Promise<unknown>) => void) => void;
