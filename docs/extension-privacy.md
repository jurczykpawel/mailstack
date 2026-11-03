# Extension message cleanup

An extension may implement `onBeforeDelete(selection, ctx)`. The core awaits this
hook before deleting messages through subject erasure or metadata retention.
`selection` contains `reason: 'erase' | 'retention'` and `messages`, an array of
`{ id, brand, template }`. Each selected message appears once per extension in a
successful operation. Erasure matches all subject roles and applies the verified
panel client's brand/template selections, including expired messages.

Persist the message ID with related extension records when creating them. This is
the durable link used by both cleanup paths; no address, content, subject index,
provider response or key is passed to the hook. The context uses the existing
extension database restricted to `ext_<name>_*`, along with `now`, `config` and
`appendAudit`. The database checks and compiles each operation at execution,
including operations from derived handles. It supports table/index creation,
table alteration/removal, selects, inserts, updates and deletes; raw SQL,
transactions and streaming are unsupported. Only the documented operation families
are accepted. Expression functions are
limited to common numeric, text, aggregate and JSON functions; syntax tokens must
belong to the supported Kysely token sets. Other node kinds and SQL fragments are
rejected before store execution. Cleanup receives no panel principal or resend
capability.

All extension names are checked before any migration or route initialization.
Names must have distinct table prefixes: `demo` and `demo_other` cannot be loaded
together. Either name is valid alone; `demo` and `demoother` can coexist. Invalid
configuration reports the extension's configuration path and stops initialization.

```ts
const extension: Extension = {
  name: 'demo',
  async onBeforeDelete({ messages }, { db }) {
    for (const { id } of messages) {
      await db.deleteFrom('ext_demo_items').where('message_id', '=', id).execute();
    }
  },
};
```

Hooks run in configured extension order, with a five-second deadline per hook and
batch. Erasure runs as a background job: each portion of at most 500 messages is
passed to every cleanup before the core hides it, and its rows are deleted only in a
later phase. A hook error or deadline leaves that portion untouched and the job
retries it after a delay; earlier portions stay hidden. Retention prepares batches of at most 500; a hook failure preserves that
message batch for a later pass. Other batches and independent content, replay,
guard and resend-job expiry, stale-send reconciliation and audit pruning continue.
The pass reports the cleanup failure after this maintenance completes.

Cleanup must be idempotent: retries may revisit already completed extension
cleanup, and successful hooks are not rolled back when a later hook fails. A
deadline does not cancel extension code. Extensions must coordinate their own
queued and active work with cleanup, awaiting durable completion before returning.
The core deletes exactly the prepared message IDs after hook completion.

Node's scheduler uses `runtime.runRetention(now)` from `loadExtensions` and passes
`runtime.beforeDelete` to `runJobs`. Custom integrations may pass a
`BeforeMessageDelete` callback to core `runRetention` and `runJobs`. With no cleanup hooks, existing responses and retention policies
apply. Subject export retains its existing core response contract.
