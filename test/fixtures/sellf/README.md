# Sellf notification examples

Provider examples from Sellf commit `1650f112458a9b47d1bef32c48a47ff45ebbdfb4`
(w163), `admin-panel/src/lib/webhooks/mock-payloads.ts`, checked against the
buyer-notification table in `docs-site/src/content/docs/webhooks.md` and these
producer contracts:

- `lib/orders/bank-transfer-service.ts`: customer, paymentDeadline, cancellation lifecycle.
- `lib/orders/participants-service.ts`: numeric stage and personal participants URL.
- `lib/services/fulfill-paid-order.ts`: saved order identity and bank-transfer settlement.
- `lib/services/free-access-events.ts`: free order claims begin with `free_`.
- `lib/services/license-revoke-webhook-payload.ts` and
  `lib/webhooks/buyer-notifications.ts`: issuance metadata and licenseKey.

The provider's preview data is stored as fixed JSON, with a fixed envelope time.
Transfer previews are completed with the customer and effective deadline exactly
as emitted by their producer; the cancellation example selects the documented
admin reason and optional text. Access selects the documented free grant source.
The payment example selects bank-transfer settlement (no PI/CS), and retains the
license example's sample key in licenses[] to verify that payment ignores it.
Tests derive stage 2, manual/API issuance, optional omissions and incomplete data
from these examples. No live checkout or provider connection is used.
