# Template configuration

The eight registered IDs are `contact`, `received`, `welcome`, `payment`, `license`,
`notice`, `refund` and `bank-transfer`. [Named templates](#named-templates) add
any other ID from configuration. Public sends always select `contact`.
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

The built-in `received`, `payment` and `license` greeting is "Dzień dobry," with or
without a name (a Polish name would need the vocative); `greetingWithName` and
`greetingWithoutName` replace it, e.g. `"Hello {name},"`. Amounts are printed exactly
as sent: the sending application supplies them in display format.

Text is a string with `{field}` placeholders or an array of strings and fragments:
`{"field":"orderId","prefix":" - ","suffix":"","empty":""}`. Prefix/suffix
are emitted with a nonempty field; `empty` supplies its alternative. Brand context
includes `{brand.id}`, `{brand.name}` and `{brand.subjectPrefix}`. Values are escaped
once and are never interpreted as further placeholders. Literal braces are not
supported in configured text. Headers admit only the type's declared header fields;
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
| `markdown` | `markdown`: text or array of lines, [Markdown syntax](#markdown); declared fields only |

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

## Named templates

`mailTemplates.custom.<id>` (global) and `brands.<brand>.mailTemplates.custom.<id>`
define templates under any ID matching `^[a-z][a-z0-9-]{0,63}$` that is not a
built-in name. A brand definition replaces a global one of the same ID; another
brand cannot select it. Pro clients still need the ID in `templates`; sources and
logging policies select it by name. [`config/custom-templates.example.json`](../config/custom-templates.example.json)
contains a Markdown licence, an order with rows and an HTML invitation.

| Member | Meaning |
| --- | --- |
| `subject`, `heading`, `previewText` | Text with `{field}` placeholders; `subject` and `heading` are required; secret and row fields are refused |
| `markdown` or `html` | Exactly one body: text, array of lines or `{"file": "relative/path"}` |
| `text` | HTML only: plain-text alternative; generated from the HTML when absent |
| `fields` | Optional kinds; `{"kind": "rows"}` marks an order row field |
| `secretFields`, `requiredFields` | Classification as for built-in types; required fields give source deliveries 422 when empty |
| `layout: "none"` | HTML only: the body is a complete document sent without the brand header and footer |
| `locales.<tag>` | `subject`, `heading`, `previewText`, `markdown`/`html`, `text` for brands with languages; a `text` alone replaces the alternative of the inherited HTML |

A brand definition replaces a global one with the same name for that brand only;
logging policies are checked against the definition each brand resolves, and a
source mapping must cover the required fields of every definition it can select.
A named template used as `autoReplyTemplate` may personalise its heading and body
with `name` and `summary`, but its subject (and every locale subject) must be
literal single-line text, as for built-in confirmations.

File paths are relative to `mailstack.json` and stay inside its directory. The
Node loader and Worker setup read them at boot/build, so `BUILD_CONFIG_SHA` covers
their content. `node scripts/mailstack.ts config check <file>` prints the generated
text of every HTML template without `text`; `node scripts/mailstack.ts template
preview <file> <brand> <id> [data.json]` prints the rendered HTML to stdout and the
subject and text to stderr.

### Fields

`{field}` inserts the value escaped for its position; a value is never parsed as
Markdown or HTML. `{field|fallback}` uses the fallback when empty. In text, an
empty field without fallback also removes one preceding space (`Hi {name},` gives
`Hi,`). The same `{field|fallback}` works in `subject`, `heading` and `previewText`
(and in presentation text such as `copy`), where an empty field without fallback
leaves its surrounding text unchanged; validation applies to the field name, so a
confirmation subject must stay literal even with a fallback. Line breaks in values become `<br>`. `{brand.id}`, `{brand.name}` and
`{brand.subjectPrefix}` are available in the body and headers; any other `{brand.*}` is read
as an ordinary request field. A field that is a whole link or `href`/`src`
must be an http(s) URL, otherwise the link is dropped (Markdown) or becomes `#` (HTML).
A field inside a literal URL is percent-encoded; secret fields cannot be used there.

### Markdown

Paragraphs, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links (http, https,
mailto), ordered and bulleted lists, quotes (drawn as a note), `---`, code blocks and
GFM tables. `#`/`##` give a subheading and `###` a section label in `theme.labelColor`.
Images show their alternative text. HTML written in Markdown is shown as text;
`\{` writes a literal brace. All tables of one body may have at most 1000 cells
(header width times rows, including the header; a block with a valid delimiter row
counts even if Markdown later declines it). One-line components, each on its own
line indented at most three spaces and outside fenced code blocks:

| Component | Output, omitted when empty |
| --- | --- |
| `[[button: Label \| {url}]]` | Brand button (http/https) |
| `[[fields: key=Label, other=Label]]` | Label/value table |
| `[[code: Title \| {field}]]` | Copyable code box |
| `[[note: Markdown with {fields}]]` | Highlighted note |
| `[[items: {items}]]` | Order rows: "qty × name", amount on the right, optional description |
| `[[totals: Shipping={shipping\|Free}; **Total**={total}]]` | Summary rows; `**…**` makes a row bold |

A row field accepts an array of up to 50 objects with nonempty `qty`, `name` and
`amount` and an optional `description` (strings or numbers, at most 500 characters);
anything else returns `400 invalid_rows`, and an incomplete source row `422
invalid_event_data`. A replay record may hold a row field longer than the
5000-character limit of other fields. In archives, a row cell shorter than three characters of a
hidden or classified row field masks another field only when that field's whole
value equals it. Sources map it with `{"path": "data.lines", "as": "rows"}`.
Amounts arrive formatted: Mailstack does not calculate, convert or check totals.

### HTML

HTML is parsed into a tree (parse5) and serialized again, so only these elements
reach the output: `p`, `h1`–`h6`, `ul`, `ol`, `li`, `table`, `thead`, `tbody`,
`tfoot`, `tr`, `td`, `th`, `a`, `img`, `span`, `div`, `strong`, `em`, `b`, `i`, `u`,
`s`, `br`, `hr` (plus `html`, `head`, `body`, `title`, `meta charset/name/content`
with `layout: "none"`). Attributes: `style`, `href`, `src`, `alt`, `width`, `height`,
`align`, `valign`, `role`, `cellpadding`, `cellspacing`, `colspan`, `border`,
`title`, `lang`, `dir`. `href` accepts http(s), `mailto:` and `#anchor`; `src` http(s).
`style` cannot contain fields, `url(`, `expression(`, backslashes or comments.
Anything else is a configuration error; comments are dropped. Use inline styles.
Attribute values are always written back in double quotes, so an unquoted
attribute (`<p title={label}>`) is accepted and rendered as `title="…"` with the
field escaped like any quoted attribute.
Generated text puts blocks on separate lines and links as "label (address)".

### Request content

A trusted client with `rawContent: true` (Pro `clients` entry or
`legacyApiKey.rawContent`, default false) may send
`"content": {"markdown": "..."}` or `"content": {"html": "...", "text": "..."}`
with `/v1/send`. The content replaces the selected template body; subject,
heading and the brand layout remain, `layout: "none"` is not available. Fields of
the same request fill its placeholders. Each member is limited to 16 KiB
(`413 content_too_large`); invalid shape or markup returns `422 content_invalid`;
without permission `403 scope`; with `resendOf`, `400 not_supported`. Public
requests ignore `content`. The content is part of the request identity, so a
changed body with the same `Idempotency-Key` conflicts. The archive stores
`[treść z żądania ukryta]` below `full`, and such messages have no replay.
A leaked key with this permission can send convincing brand-styled mail: grant it
only to narrowly scoped clients.

### Brand theme

Optional `theme.background` (page colour), `theme.headingFont: "serif"`,
`theme.buttonRadius` (0–999, e.g. 999 for a pill) and `theme.labelColor` (section
labels and Markdown links). Colours are `#rgb`–`#rrggbbaa`, a colour name or `rgb()`.
Without them the output is unchanged.

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
Field substitutions in one named or request body may produce at most 768 KiB of
characters (HTML and text together); rendering stops with `422
template_output_limit` as soon as that is exceeded.

Archive reads show the bytes and actual language recorded when sent. Old archives
may have no language metadata. Replay uses current presentation and the saved
preference; source resend gets current source data. Copy changes can alter request
identity, so reconcile pending producer retries before changing source copy.

For presentation rollback, retain a compatible runtime and restore the earlier
configuration. Do not strip signed language preferences or downgrade version-2
identity records. See [README](../README.md#template-copy-and-optional-languages).
Validate with `node scripts/mailstack.ts config check <file>`, restart Node or use
the guarded Worker release, then inspect first delivery in an isolated mailbox.
