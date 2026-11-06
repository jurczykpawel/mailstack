# Template output fixtures

`legacy.json` was captured before template changes from core commit
`7d7b3b0`, using the registered renderers, shared layout and JSON-LD head
serializer at that commit. It records subject, every RenderedBody field and
final HTML/text. It is an independent baseline for future renderer changes;
do not regenerate it from a replacement renderer.

Inputs are synthetic examples following the template fields documented in
AGENTS.md and README.md. Example brand transport/theme comes from
`config/mailstack.example.json`. The existing specialized contact/received
renderer is exercised with its required registry ID and synthetic data.
No provider response or customer event is fabricated here: these are direct
renderer inputs, not source-envelope evidence. Existing source fixtures keep
their own provenance in `test/fixtures/sellf/README.md`.

The fixed contact metadata is 2026-06-10T09:30:00.000Z, an example origin and
the documentation IP 192.0.2.1; there is no current-time dependency. Cases
cover all eight types for acme/demo, missing and whitespace data, payment and
reminder branches, full/partial/unknown refund scope, fallback description,
notice formatting, markup, task/product selectors and raw table whitespace.
Unicode lengths include 99/100/101 and 199/200/201 plus 5000 code points.

These fixtures preserve the original normalization, including license name
whitespace and missing refund values. Active Text trims interpolated fields
and substitutes missing values with an empty string. Those differences,
subject normalization, constrained confirmation payloads and private-field
handling require separate assertions; they are not reasons to rewrite this
baseline. Long direct received output remains a baseline, while later
confirmation tests must assert truncation against the same original input.
