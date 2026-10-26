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
`appendAudit`. Cleanup receives no panel principal or resend capability.

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
batch. Erasure prepares batches of at most 50 messages and awaits every cleanup
before deleting any core message or child row. A hook error or deadline returns
503 with `{ success: false }`. The existing audit entry records the attempted
operation. Retention prepares batches of at most 500; a hook failure rejects the
maintenance pass before deleting that batch. A later pass selects it again.

Cleanup must be idempotent: retries may revisit already completed extension
cleanup, and successful hooks are not rolled back when a later hook fails. A
deadline does not cancel extension code. Extensions must coordinate their own
queued and active work with cleanup, awaiting durable completion before returning.
The core deletes exactly the prepared message IDs after hook completion.

Node's scheduler uses `runtime.runRetention(now)` from `loadExtensions`. Custom
integrations may pass a `BeforeMessageDelete` callback to core `runRetention` and
`internalFetch`. With no cleanup hooks, existing responses and retention policies
apply. Subject export retains its existing core response contract.
