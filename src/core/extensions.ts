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
/** `ack` once every delivery of the event is stored; `partial` names the last stored endpoint when more remain. `writes`
 * (sandboxed like `batch`) commit atomically with the cursor of a durable event, or as one batch for an event from memory. */
export type EventAck = ({ ack: true } | { partial: string }) & { writes?: Query[] };
type Query = { compile(): CompiledQuery };
/** Sandboxed to `ext_<name>_*`; `batch` validates every element, then runs them atomically (any rejection refuses the whole batch).
 * `enqueue` makes sure one live job exists for (`kind`, `key`): a finished one is revived, a live one is left alone; for `batch`. */
export type ExtensionDatabase = Kysely<Record<string, Record<string, unknown>>> & { batch(queries: Query[]): Promise<number[]>; enqueue(kind: string, key: string, payload: unknown): Query };
/** A core job of an extension (A 3.4.2): lease, token fence and retries stay in the core. `run` is one attempt; its writes commit
 * only under a valid token. `retry` reschedules after 1 min, 10 min, 1 h, 6 h; the fifth failure or lost claim commits `dead`. */
export interface ExtensionJob {
  ready?(): Promise<boolean>;
  reserveMs?: number;
  /** The most D1 calls and subrequests (commit included) one attempt may take (Free: 50 per invocation); default 6. */
  ops?: number;
  run(job: { payload: unknown; attempt: number }, ctx: ExtensionContext): Promise<{ retry?: boolean; writes?: Query[] }>;
  dead?(job: { payload: unknown }, ctx: ExtensionContext): Query[];
}
export interface ExtensionContext {
  panel?: PanelPrincipal;
  sesStatus?: () => Promise<import('./store/ses-status').SesStatusV1>;
  /** Admin-only SES loop test (R8): `scenario` is one of three simulator mails; the key is the caller's idempotency token. */
  sendInProcess?: (input: { brand: string; scenario: 'success' | 'bounce' | 'complaint'; key: string }) => Promise<{ id?: string; error?: 'invalid' | 'unavailable' | 'rate_limited' | 'send_failed' | 'log_required' }>;
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
  /** Job kinds, registered as `ext:<name>:<kind>`. */
  jobs?: Record<string, ExtensionJob>;
  /** Joined to the configuration digest: a change starts a new `reconcile` generation (e.g. a rotated keyring). */
  reconcileKey?: string;
  routes?(app: ExtensionApp): void | Promise<void>;
  /** Supplies API keys beyond the core's single full key; receives the validated core configuration. */
  keys?(config: Config): KeyProvider | Promise<KeyProvider>;
}
/** `durable`: the event is already stored for the fan-out job, so it is not delivered from memory. */
export type EmitEvent = (event: Omit<DomainEvent, 'id'> & { durable?: boolean }, waitUntil?: (task: Promise<unknown>) => void) => void;
