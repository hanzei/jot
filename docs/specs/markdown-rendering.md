# Feature Spec: Markdown Rendering

Status: **Implemented** — describes shipped behaviour.
Owner: TBD · Target: Jot webapp + mobile

---

## 1. Scope

Markdown applies to the **`content` of text notes** in full, and to **list-note
item text** in an inline-only subset (§2.1):

- **Note titles are plain.** They are rendered as text everywhere.
- **List-item Markdown renders on display surfaces only.** Note cards, mobile's
  read-only editor and the collapsed-completed parent label render it; the
  editable row still shows its source, because it is an always-live input with no
  preview mode. Closing that gap is
  [#824](https://github.com/hanzei/jot/issues/824).

Both clients render the same feature set from the same source string, so a note
written on a phone reads identically in a browser and the other way round. They
get there through entirely different libraries, which is the reason this document
exists: the two implementations have no shared code path to keep them honest, only
a shared test corpus and this spec.

| | Webapp | Mobile |
|---|---|---|
| Parser | `marked` (`gfm: true`, `breaks: true`) | `markdown-it` (`linkify: true`, `typographer: false`, `html: true`, `breaks: false`) |
| Renderer | HTML, filtered through a DOMPurify tag allowlist | `react-native-markdown-display` render rules |

---

## 2. What is supported

Stated as behaviour rather than as one library's options, since the two clients
reach it differently.

| Syntax | Behaviour |
|---|---|
| `#`, `##`, `###` | Headings, each with its own size |
| `####`, `#####`, `######` | Headings, rendered as **bold body-size text** |
| `**bold**`, `*italic*`, `~~strike~~` | Rendered |
| `` `inline code` `` | Rendered |
| Fenced and indented code | Rendered **with block layout** |
| Bullet and ordered lists | Rendered |
| `- [ ]` / `- [x]` | Rendered as ☐ / ☑, **non-interactive** |
| Blockquotes | Rendered |
| `[text](url)` and bare `https://…` | Rendered as links |
| `---`, `***` | Horizontal rule |
| Single newline | Line break |

**Link schemes are restricted to `http`, `https` and `mailto`** on both clients.
A link with any other scheme — `tel:`, `sms:`, an app deep link, `javascript:` —
renders as its label in plain text, with nothing to tap. So does a link with no
scheme at all (`/dashboard`, `example.com`). Notes are shareable, so the target
of a link can come from a collaborator, and following it is a navigation the
reader did not choose.

Syntax highlighting inside code blocks is deliberately absent (§6).

### 2.1 The list-item subset

List-item text renders **only inline constructs**:

| Syntax | Behaviour |
|---|---|
| `**bold**`, `*italic*`, `~~strike~~` | Rendered |
| `` `inline code` `` | Rendered |
| `[text](url)` and bare `https://…` | Rendered as links, same scheme policy as above |
| `![alt](url)`, raw HTML | Literal source, same as above |
| Everything block-level | **Literal source** |

"Everything block-level" is the whole point: `# x`, `- x`, `1. x`, `- [ ] x`,
`---`, `> x` and table pipes all stay exactly as typed. An item **is** a list
item — it carries its own checkbox, its own one-level nesting and its own
position — so block syntax inside one has nothing left to describe, and `- [ ]`
in particular would be a second checkbox next to the real one.

This falls out of **lexing item text as inline content** rather than parsing it
as a document, so there is nothing to suppress and nothing to keep in step with
the block rules. It is why the item renderer is a fraction of the size of the
full one, and why the two cannot drift on block syntax even in principle.

Two consequences worth stating, because both look like bugs otherwise:

- **`~~strike~~` collides with completed items**, which already render with a
  line through them. It is supported anyway: dropping it would make the subset
  something other than a subset, and a note converted from a list to text would
  gain strikethrough it had not been rendering.
- **Markdown counts against `ITEM_TEXT_MAX_LENGTH`** (500), which is measured on
  the source. An item full of `**` has less room for words than one without.

### 2.2 Converting between note types

Because §2.1 is a strict *subset* of §2, converting a note between the two types
does not need a formatting policy of its own — it follows from which constructs
the destination can display. `shared/src/noteConversion.ts` implements exactly
that rule, and both clients call it.

**Text → list.** One item per non-blank line. Only the block markdown an item
*structurally replaces* is removed, because the item already expresses it:

| Removed | Because the item has |
|---|---|
| A leading `-`, `*`, `+`, `1.` marker | its own bullet |
| A `[ ]` / `[x]` checkbox after that marker | its own `completed` state |
| A leading `#`–`######` heading prefix | no headings, and the title is separate |
| Leading `>` blockquote markers | no block structure at all |

Everything else survives as typed. Inline syntax is kept because the item
renders it — stripping `**` out of `**Buy** milk` would delete formatting the
destination displays. Block syntax that is *not* a line prefix — a fence, `---`,
a table row, `![alt](url)` — is kept too, because §2.1 shows it as literal source,
so the item displays what the user typed.

**Nesting survives.** An indented line that also carries a list marker becomes a
child of the nearest preceding top-level item, capped at the single level the
model allows. Indentation alone is not enough: an indented line *without* a
marker is far more often a wrapped continuation of the paragraph above it than a
deliberate child, and silently re-parenting it is a worse failure than dropping
nesting nobody asked for.

The clients cannot send `parent_id` here — the item ids do not exist until the
conversion is persisted — so they send `indent_level` (0 or 1) and the server
rebuilds `parent_id` in `buildCreateNoteItems`, attaching each indented item to
the nearest preceding top-level one. An indented item with no such predecessor
stays top-level. Mobile mirrors that same walk locally in
`applyConvertedNoteLocally` so an offline conversion matches what the replay
will produce.

**List → text.** The title becomes an `# h1` line; each item becomes `- [ ]` or
`- [x]`, children indented two spaces. Item text is emitted **verbatim and
deliberately unescaped**: the item and the converted text note lex the same
source with the same inline rules, so escaping would *introduce* a rendering
change rather than prevent one. Block syntax in item text needs no escaping
either — every item is emitted behind a `- [ ] ` marker, so a leading `#` or a
`---` stays inside a list item and stays literal, exactly as the item showed it.

The round trip is stable in one direction and *normalizing* in the other, which
is worth stating precisely because it is easy to overclaim:

- **List → text → list returns the same items** — text, completed state and
  nesting all survive. The one exception is an item whose text *begins* with `#`
  or `>`: that prefix is consumed on the way back, because the converter cannot
  distinguish it from the block markup it exists to strip.
- **Text → list → text normalizes rather than preserves.** Inline formatting and
  nesting survive, but every line returns as `- [ ]` / `- [x]`, so content that
  used any other structural prefix is not byte-identical: `# Groceries` comes
  back as `- [ ] Groceries`, and `* Eggs`, `1. Eggs` and `> Eggs` all come back
  as `- [ ] Eggs`. This is inherent to the destination — an item has one
  representation, so every way of writing a line collapses onto it.

Also not recovered, in either direction, is anything the line-per-item split
discards: blank lines, and the distinction between a wrapped paragraph and
separate lines.

**Known gap:** conversion does not check `ITEM_MAX_COUNT` (500) or
`ITEM_TEXT_MAX_LENGTH` before sending. A text note with more than 500 non-blank
lines, or a single line longer than 500 characters, is rejected by the server
(422 and 400 respectively) and surfaces on both clients as a generic "failed to
convert" message with no indication of the cause. The webapp's *paste* path does
guard this (`note.tooManyItems`); the convert path does not. Keeping inline
markers rather than stripping them makes the text-length cap slightly easier to
hit, since the cap is measured on the source.

---

## 3. How unsupported formatting is handled

There are **three** possible outcomes, and every unsupported construct is filed
under exactly one of them. This is the part that keeps being got wrong.

### Rendered as literal source

The user sees exactly what they typed, and can tell that Jot did not act on it.

| Construct | Shown as |
|---|---|
| `![alt](url)` | `![alt](url)`, and `![alt](url "title")` when a title is present |
| Tables | The pipe rows as typed, header row included |
| Raw HTML | `<b>bold</b> text` — inert text, never an element |

Literal means literal all the way down: a URL inside one of these regions — a
table cell, an `href` attribute — is text too, not a link. An HTML block also
swallows the Markdown inside it (`<div>` / `**bold**` / `</div>` shows the `**`),
on both clients.

### Formatting dropped, text kept

**Empty.** Nothing is handled this way today. Every unsupported construct shows
its source instead, so unsupported syntax never fails silently — markup that
quietly disappeared read as a rendering bug rather than a limitation. (This is a
change from the webapp's earlier behaviour, where raw HTML lost its markup and
kept its words.)

Note that `####`–`######` are *not* in this category: they are supported, and
render as bold body text (§2). They are the one construct that renders without a
size of its own, which is a styling decision rather than a parsing one — both
clients emit real heading elements and style them down.

### Removed entirely

**Empty by choice.** No construct is dropped without a trace. The category is
named here so that adding something to it is a deliberate act.

### Smart typography

Not an unsupported construct so much as a transformation that does not happen:
`--` stays `--` and `"hi"` keeps its straight quotes. `markdown-it`'s
`typographer` is on by default and is switched off explicitly, since `marked` has
no equivalent and enabling it on one client only is exactly the kind of drift this
spec exists to prevent.

---

## 4. Why

- **Images are not rendered** because they are a separate, first-class feature:
  they live in a gallery above the note body, not embedded in Markdown. See
  [`file-attachments.md`](file-attachments.md), which states the no-inline-embedding
  rule this implements. Rendering `![alt](url)` would additionally have the mobile
  app fetch an arbitrary third-party URL out of note content.
- **Tables are not rendered** because they do not fit a phone note card, and a
  table that renders in the browser but not on mobile is worse than one that
  renders nowhere.
- **`####`–`######` render as bold body text** because three distinct heading
  sizes are enough for a note: below h3 the steps would be indistinguishable from
  each other at note sizes. The markup still does something visible, so it does
  not read as broken.
- **Raw HTML is never rendered**, on the usual grounds. It is shown as source
  rather than stripped so that it lands in the same bucket as everything else Jot
  does not support.
- **Smart typography was dropped for parity**, as above.

---

## 5. Where it is implemented

| Concern | File |
|---|---|
| Shared link-scheme policy + literal-image format | `shared/src/markdown.ts` |
| Shared inline-subset normalizer (§2.1) | `shared/src/inlineMarkdown.ts` |
| Shared text ↔ list conversion (§2.2) | `shared/src/noteConversion.ts` |
| Shared conformance corpora (both test suites) | `shared/src/markdownCases.ts` |
| Webapp renderer + tag allowlist | `webapp/src/utils/markdown.ts` |
| Webapp item renderer | `webapp/src/components/InlineMarkdown.tsx` |
| Mobile parser, core rules, link render rule | `mobile/src/utils/markdown.tsx` |
| Mobile item lexing + plain-text flattening | `mobile/src/utils/inlineMarkdown.ts` |
| Mobile item renderer | `mobile/src/components/InlineMarkdown.tsx` |
| Mobile styles | `mobile/src/utils/markdownStyles.ts` |

**An accessibility label built from item text must be flattened first**
(`flattenInlineNodes`). Once item text renders, a label built from the raw source
announces markers the user never sees — and an `aria-label` *replaces* the
element's content for assistive technology, so those markers become the only
thing announced. Both the webapp's collapsed-completed group label and mobile's
item checkbox label go through it.

The item renderers share more than the block renderers can: both clients lex with
`marked` and normalize through `shared/src/inlineMarkdown.ts`, so the policy
decisions are made once and only the leaf rendering differs (an HTML string vs a
`<Text>` tree).

`shared/src/inlineMarkdown.ts` **declares the marked token fields it reads
structurally and imports nothing from `marked`** — not even types. Both consumers
compile `shared/src` with their own tsc and resolution runs from `shared/`
(mobile's `@jot/shared` is a symlink and resolution follows the realpath), while
CI installs dependencies in `webapp/` and `mobile/` only. So `shared/node_modules`
does not exist during a consumer's typecheck and even a type-only import fails to
resolve — the same trap as the `@babel/runtime` note in `CLAUDE.md`, and the same
fix `mobile/src/utils/markdown.tsx` uses for markdown-it. `marked` stays a
devDependency of `shared/` for its own test suite, which `shared-ci.yml` does
install.

Mobile therefore carries two Markdown libraries for now: `marked` for items and
`react-native-markdown-display` for text-note content. That is temporary, and
[#822](https://github.com/hanzei/jot/issues/822) is what ends it — the item
renderer is also the cheap proof that `marked` resolves under Metro, which is the
assumption that ticket rests on.

The mobile note **card** preview does not use any of this — it flattens Markdown
to a single line of plain text with `stripMarkdownForPreview` in
`markdownStyles.ts`. Rendering Markdown in mobile cards is
[#819](https://github.com/hanzei/jot/issues/819).

### Implementation constraints

Each of these is a trap the naive implementation falls into. They are recorded
here so the next person does not have to rediscover them.

- **`marked` has no `image` tokenizer to disable.** v18 handles images inside the
  link tokenizer, so `use({ tokenizer: { image() { return false } } })` throws
  `tokenizer 'image' does not exist`. Worse, `use()` treats a tokenizer that
  returns `false` as *"fall through to the default"*, so tables cannot be disabled
  that way either — doing so still renders a full `<table>`. **Both must be
  renderer overrides.**
- **`markdown-it`'s `.disable('image')` does not produce raw text.** It produces
  `!` followed by a *live link*, and with an empty alt an invisible clickable one.
  Mobile rewrites image tokens into text tokens in a core rule instead.
- **Nothing is disabled at parser level on mobile — everything is rewritten
  after parsing**, and `linkify` is why. `.disable('table')` looks correct in
  isolation (it leaves plain paragraph text), but linkify then turns a URL in a
  cell into a live link inside text that is supposed to be literal, which the
  webapp does not do. Same for `html: false`, which would escape the tags and
  leave linkify free to link a URL inside an `href` attribute. Parsing them and
  collapsing the tokens afterwards discards the parsed contents, links included.
  This is the one place where the obvious config change silently reintroduces a
  divergence, so it is worth re-reading before "simplifying" either option.
- **The image reconstruction format is pinned** in `formatLiteralImage`
  (`shared/src/markdown.ts`) and used by both clients, because both rebuild it
  from parsed tokens rather than echoing the source. If one side dropped the
  title or the leading `!`, `![a](b "t")` would quietly diverge again.
- **Mobile rewrites images at parser level, not in a render rule**, because
  `react-native-markdown-display` marks every image token `block: true`, which
  would break the literal source out of its paragraph and onto its own line.
- **All mobile core rules run after `linkify`.** Running them before would have
  linkify turn the URL inside a literal `![alt](url)` into a live link.
- **linkify is fuzzier than GFM and is trimmed back.** linkify-it autolinks a
  bare `example.com`; marked requires a scheme or a `www.` prefix. Turning
  `fuzzyLink` off is not the fix — it would also stop linking
  `www.example.com`, which marked *does* link — so the extra links are made and
  then unwrapped (`gfmAutolinksOnly`). Both clients accept the
  `http://`-normalized target such an autolink produces.
- **h4–h6 are styled down, not rewritten.** Both clients emit real heading
  elements and give them body size and bold weight in CSS
  (`.markdown-content :is(h4, h5, h6)`) and in the style map
  (`markdownStyles.ts`). Keeping the elements keeps the document outline intact
  for assistive technology; a parser-level rewrite would not.
- **Webapp `breaks: true` and mobile's `softbreak` rule produce the same result by
  different means** — the render rule emits `\n` despite `breaks: false`. Setting
  mobile to `breaks: true` would look like a harmless alignment and change nothing
  at all, until that rule changes.
- **Checkbox markers are positional on mobile.** `markdown-it` has no task-list
  support, so `[x]` survives as literal text and is swapped for ☑ only at the head
  of a list item's first inline token. That position check is what keeps `- [x]`
  inside a fenced code block intact, matching `marked`, which only emits a
  checkbox token for a real task-list item.

---

## 6. Deliberately not covered

- **Interactive checkboxes.** Toggling a rendered ☐ would mean writing back into
  `content` — a much larger feature than rendering.
- **Markdown in the *editable* list-item row.** The subset renders on display
  surfaces (§1); giving the always-live input a view/edit swap is
  [#824](https://github.com/hanzei/jot/issues/824).
- **Block Markdown in list items.** Not a gap to be filled later — §2.1 explains
  why an item cannot hold it.
- **Syntax highlighting** in code blocks. The webapp allowlist drops the
  `class="language-js"` attribute `marked` emits, so the language tag is parsed
  and ignored on both clients.

---

## 7. Testing

`shared/src/markdownCases.ts` holds the two lists of inputs — `MARKDOWN_CASES`
for text-note content and `MARKDOWN_ITEM_CASES` for the item subset. Each has a
suite per client, and every suite asserts one expectation per case id and fails
if any id has none, so a case cannot be covered on one client and forgotten on
the other. Adding a case breaks both suites until both are updated.

| Corpus | Webapp | Mobile |
|---|---|---|
| `MARKDOWN_CASES` | `webapp/src/utils/__tests__/markdown.test.ts` | `mobile/__tests__/markdown.test.tsx` |
| `MARKDOWN_ITEM_CASES` | `webapp/src/utils/__tests__/inlineMarkdown.test.ts` | `mobile/__tests__/inlineMarkdown.test.tsx` |

`shared/src/__tests__/inlineMarkdown.test.ts` covers the item corpus a third
time, at the normalizer, where the policy actually lives.

`webapp/e2e/tests/markdown.spec.ts` covers the same feature set through the
browser, on real note content.
