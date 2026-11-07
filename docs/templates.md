# Template configuration

The eight registered IDs are `contact`, `received`, `welcome`, `payment`, `license`,
`notice`, `refund` and `bank-transfer`. Public sends always select `contact`.
The [template table](../AGENTS.md#templates) lists content fields; the
[Sellf contract](../README.md#sellf-event-contract) lists mapped requirements.
Changing copy does not change recipients, scopes, source event selection or
idempotency policy. Built-in copy is Polish unless languages are enabled.

## Layers and text

Enable global presentation with `mailTemplates.version: 1`. Precedence, from lowest
to highest, is the built-in type recipe, global defaults, global type patch, brand
defaults, brand type patch and selected form-kind patch. For a non-default locale, all matching locale patches are applied after all
neutral layers, in the same order. Dictionaries merge by key; a supplied body
replaces the complete list of blocks. Omission inherits, rather than clearing.

Global `mailTemplates` accepts `version`, `defaults` and `templates`. Brand
`mailTemplates` accepts `defaults`, `templates`, `forms` and `languages` (no version).
Defaults support shared `copy`/`labels`; type patches support `subject`, `heading`,
`previewText`, `copy`, `labels`, `ctaLabels`, `body`, `fields`, `secretFields` and
`locales`. Slot names come from `src/templates/manifest.ts`; unknown slots fail boot.

Text is a string with `{field}` placeholders or an array of strings and fragments:
`{"field":"orderId","prefix":" - ","suffix":"","empty":""}`. Prefix/suffix
are emitted with a nonempty field; `empty` supplies its alternative. Brand context
includes `{brand.id}`, `{brand.name}` and `{brand.subjectPrefix}`. Values are escaped
once and are never interpreted as further placeholders. Literal braces and raw
HTML blocks are not supported. Headers admit only the type's declared header fields;
private fields cannot be moved into subjects, headings or previews.

Additional fields are declared as `"fields":{"tracking":{"kind":"text"}}`;
kinds are `text`, `email` and `url`. `secretFields` adds classification. Locale and
form-kind presentation patches cannot redefine classification. Replay remains
unavailable for types with secret fields. Never remove a secret declaration to
make replay available.

## Body blocks

Each block has a distinct lowercase `id` and one `kind`; up to 24 blocks are allowed.

| Kind | Members beyond `id`/`kind` |
| --- | --- |
| `paragraph` | `text` (Text) |
| `fieldTable` | optional `rows: [{field,label?}]`, `allFields: true`, `exclude`, `includeMeta`, `textStyle: "inline"` or `"stacked"` |
| `message` | `field`, optional `label` |
| `metadata` | `items` from `receivedAt`, `origin`, `ip` (form types only) |
| `cta` | `url: {literal: "https://..."}` or `{field: "ctaUrl"}`, nonblank `label` |
| `code` | `field`, optional `label` |

`body.htmlJoin` is `""` or `"\n"`; `textJoin` is `"\n"` or `"\n\n"`.
CTA fields must be declared URLs. Configured URLs use HTTP(S), no credentials and
at most 2048 UTF-8 bytes. These rules apply equally to HTML and text rendering.

For example, merge this fragment at the root of the complete configuration:

```json
{
  "mailTemplates": {
    "version": 1,
    "templates": {
      "notice": {
        "heading": "{heading}",
        "body": {
          "blocks": [
            {"id":"intro","kind":"paragraph","text":"{paragraphs}"},
            {"id":"action","kind":"cta","url":{"field":"ctaUrl"},"label":"Open"}
          ]
        }
      }
    }
  }
}
```

## Optional languages

This is opt-in per brand. Start with the complete example and merge the English
fragment, which contains all eight types (run from the core checkout):

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('config/mailstack.example.json', 'utf8'));
const english = JSON.parse(readFileSync('config/mail-templates.en.example.json', 'utf8'));
config.mailTemplates = english;
config.brands.acme.mailTemplates = { languages: { default: 'pl', allowed: ['pl', 'en'] } };
writeFileSync('/tmp/mailstack-language-example.json', JSON.stringify(config, null, 2));
JS
node scripts/mailstack.ts config check /tmp/mailstack-language-example.json
```

For an existing configuration, merge rather than replace its existing type patches.
Brand `languages.default` must be in `allowed` (one to eight tags). Tags are `ll`
or `ll-RR`, normalized, for example `en-US`. Regional tags resolve exact → base →
that type's available brand default; a base candidate must itself be configured
and compiled. Do not assume any accepted tag has translated copy. A non-Polish,
non-English layout requires `languages.layout.<tag>` with `sentBy` and `phoneLabel`.
An English default needs English base copy, not only a `locales.en` patch.

A type's `locales.en` patch is presentation only. Neutral brand/form-kind overrides of subject,
heading, preview or body need corresponding locale coverage; otherwise that
candidate falls back as a whole. Type copy/label dictionaries can inherit literals;
`config check` warns about inherited copy and source overlay coverage. With
languages active, put nonempty default copy/labels in per-type patches.

`POST /v1/send` accepts `"locale":"en-US"` for an opted-in brand in both public
and trusted mode. Without languages, `locale` is an ordinary content field. Rename
an existing content field before enabling this feature. Confirmation resolves its
own template with the same preference; it can fall back independently.

A source definition may read a dotted `locale` path. The Sellf preset uses
`data.customer.locale`. `fieldsByLocale.<tag>` on a send action can localize
notice `heading/paragraphs/ctaLabel` and welcome `intro/body/ctaLabel`; cover the
base copy fields and retain the same source paths. It follows the resolved template
language. Amounts, currencies, customer data and supplied dates are not translated;
`date-pl` retains its existing behavior. No browser or IP language is inferred.

## Form kinds

Brand `forms.selector` contains `byTemplate`, `values`, `empty` and `otherwise`.
Use the corresponding selector field for each form template (`contact.type` and
`received.summary` are the normal pair). `forms.kinds.<id>.templates` holds the
presentation patches. A selector changes presentation only, never transport or
permissions. Preserve existing form copy in configuration before replacing a
custom renderer. Check the first notification and confirmation, not only resend.

## Limits, archives and updates

All template sections and source copy overlays together are capped at 256 KiB.
Compiled plans allow 1024 combinations and 8 MiB. Configured output limits are
512 KiB HTML, 256 KiB text and 998 subject bytes. The runtime declines over-limit
output before a delivery attempt; no language-specific table or D1 lookup is added.

Archive reads show the bytes and actual language recorded when sent. Old archives
may have no language metadata. Replay uses current presentation and the saved
preference; source resend gets current source data. Copy changes can alter request
identity, so reconcile pending producer retries before changing source copy.

For presentation rollback, retain a compatible runtime and restore the earlier
configuration. Do not strip signed language preferences or downgrade version-2
identity records. See [README](../README.md#template-copy-and-optional-languages).
Validate with `node scripts/mailstack.ts config check <file>`, restart Node or use
the guarded Worker release, then inspect first delivery in an isolated mailbox.
