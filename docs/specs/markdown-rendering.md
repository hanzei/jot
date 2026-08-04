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

### 1.1 Note cards render links as text

**A note card never renders a link**, on either client and for either note type.
The label shows as ordinary text — no underline, no link colour, nothing to
follow.

A card is a single control whose job is to open the note, and a link inside it
competes with that. Not hypothetically: on the webapp both handlers fire, so
clicking a link in a card followed the link *and* opened the note; on mobile the
link takes the tap and the card never opens. Item text used to paper over this
with a container-level `stopPropagation`, which the text-note body never had.

Given that a card's link cannot be followed, it must not *look* followable
either — an underline on something inert is the worse failure of the two, and a
colour that only signals "link" fails anyone who cannot use it. So the label
renders exactly as the surrounding text.

The open note is unaffected: the webapp's modal preview and mobile's editor both
render live links, which is where a reader who wants the link already is. One
consequence worth naming: because the *editable* list-item row shows source
(above), a link typed into a list item now has no live surface on the webapp at
all until [#824](https://github.com/hanzei/jot/issues/824) gives that row a view
mode. Mobile still has one, in its read-only editor.

Both clients render the same feature set from the same source string, so a note
written on a phone reads identically in a browser and the other way round.

| | Webapp | Mobile |
|---|---|---|
| Lexer | `marked` (`gfm: true`, `breaks: true`) | `marked` (`gfm: true`, `breaks: true`) |
| Normalizer | `shared/src/blockMarkdown.ts` + `inlineMarkdown.ts` | the same two modules |
| Renderer | HTML, filtered through a DOMPurify tag allowlist | React Native components |

**Everything except the last row is shared.** Both clients lex with the same
library at the same version and then normalize the tokens through the same two
modules, so what is a heading, what autolinks, where a table ends, and what an
unsupported construct degrades to are decided **once**, in `shared/`, for both
clients and both feature sets (§2.1).

**The renderers themselves cannot be shared.** One emits an HTML string for
`dangerouslySetInnerHTML`, the other a tree of React Native components, and there
is no DOM on a phone. So what stays client-specific is layout — and *only*
layout. A change to behaviour belongs in `shared/`; a change in a client is a
change to how that client draws it.

Both renderers consume the same node types (`BlockNode`, `InlineNode`), which are
deliberately smaller than marked's token union: every unsupported construct has
already been degraded to literal text before a renderer sees it, so neither
client can accidentally give one a rendering of its own. That, plus the shared
corpus (§7) and this document, is what keeps the two honest.

Mobile renders text-note content on two surfaces, from the same tokens:

| Surface | Renderer | Layout |
|---|---|---|
| Editor read mode | `mobile/src/components/Markdown.tsx` | Views and Text, full block layout |
| Note card | `mobile/src/components/MarkdownPreview.tsx` | One `<Text>`, clamped to six lines |

The card is a different **layout** of the same content, never a different feature
set — §5 covers what a single Text cannot draw and what stands in for it.

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
| `[text](url)` and bare `https://…` | Rendered as links — **except on note cards** (§1.1) |
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
| `[text](url)` and bare `https://…` | Rendered as links, same scheme policy and same card rule as above |
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

**One case: a link on a note card** (§1.1). The label survives as ordinary text
and the target is dropped, because a card cannot follow a link and must not
pretend otherwise.

It is the only thing in this category, and it is *surface*-scoped rather than
syntax-scoped — links are fully supported everywhere else. No **construct** is
handled this way: every unsupported one shows its source instead, so unsupported
syntax never fails silently, since markup that quietly disappeared read as a
rendering bug rather than a limitation. (That is a change from the webapp's
earlier behaviour, where raw HTML lost its markup and kept its words.)

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
| Shared block normalizer (§2) | `shared/src/blockMarkdown.ts` |
| Shared inline-subset normalizer (§2.1) | `shared/src/inlineMarkdown.ts` |
| Shared text ↔ list conversion (§2.2) | `shared/src/noteConversion.ts` |
| Shared conformance corpora (both test suites) | `shared/src/markdownCases.ts` |
| Webapp node-to-HTML renderer + tag allowlist | `webapp/src/utils/markdown.ts` |
| Webapp item renderer | `webapp/src/components/InlineMarkdown.tsx` |
| Mobile block lexing entry point | `mobile/src/utils/markdown.ts` |
| Mobile block renderer (editor) | `mobile/src/components/Markdown.tsx` |
| Mobile card preview renderer | `mobile/src/components/MarkdownPreview.tsx` |
| Mobile item lexing + plain-text flattening | `mobile/src/utils/inlineMarkdown.ts` |
| Mobile item renderer | `mobile/src/components/InlineMarkdown.tsx` |
| Card links-as-text switch | `links` option on both clients' renderers |
| Mobile inline leaf rendering (shared by all three) | `mobile/src/components/inlineNodes.tsx` |
| Mobile text metrics + colours | `mobile/src/utils/markdownStyles.ts` |

**An accessibility label built from item text must be flattened first**
(`flattenInlineNodes`). Once item text renders, a label built from the raw source
announces markers the user never sees — and an `aria-label` *replaces* the
element's content for assistive technology, so those markers become the only
thing announced. Both the webapp's collapsed-completed group label and mobile's
item checkbox label go through it.

**Both clients share the whole normalizer, not just the parser.** The block walk
lives in `shared/src/blockMarkdown.ts` and hands every inline run to
`normalizeInlineTokens`, so a client file contains no policy at all — no scheme
check, no image reconstruction, no table collapse. The webapp's `marked.use()`
renderer overrides are gone with it: `renderMarkdown` now walks `BlockNode`s into
HTML, and DOMPurify stays behind it as the safety net rather than as the
mechanism.

**Mobile's three renderers share one inline level.** Item text, the editor and
the card all end up in `renderInlineNodes` (`inlineNodes.tsx`), because the inline
half of the feature set is identical on all three and only the block layout
differs. Both clients also normalize inline tokens through
`shared/src/inlineMarkdown.ts`, so the policy decisions — which schemes may link,
what an image degrades to, what happens to raw HTML — are made in exactly one
place for both clients and both feature sets. **A link node's `href` is therefore
allowed by construction**, which is why no renderer re-checks the scheme: the
normalizer has already turned every other link into its own label.

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

### What the card preview substitutes

`numberOfLines` is React Native's only line clamp and it applies to a single
`<Text>`; it cannot reach across a tree of Views, which is what a block layout
is. The card therefore renders its blocks **into one Text**, which makes the
clamp native — correct ellipsis, one layout pass, nothing measured — at the cost
of every affordance that needs a box. Each one is substituted rather than
dropped, so the card shows the same content as the editor:

| Block | Editor | Card |
|---|---|---|
| Code block | Monospace in a tinted box | Monospace, no tint |
| Blockquote | A bar down the left | Muted text colour |
| Bullet / ordered item | A marker column | A `•` or `1.` prefix plus a space; nested items indented by spaces |
| Horizontal rule | A hairline View | A short run of `─` |
| Block spacing | An 8px gap | A newline |
| Link | Underlined, tappable | Plain text (§1.1 — a rule, not a limitation) |

`mobile/__tests__/markdown.test.tsx` pins this: the card's visible text must
equal the editor's for **every** case in the corpus, once whitespace and the rule
stand-in are removed. A card that dropped or invented content fails there.

### Implementation constraints

Each of these is a trap the naive implementation falls into. They are recorded
here so the next person does not have to rediscover them.

- **`marked` has no `image` tokenizer to disable.** v18 handles images inside the
  link tokenizer, so `use({ tokenizer: { image() { return false } } })` throws
  `tokenizer 'image' does not exist`. Worse, `use()` treats a tokenizer that
  returns `false` as *"fall through to the default"*, so tables cannot be disabled
  that way either — doing so still renders a full `<table>`. **Images and tables
  are therefore parsed and then degraded**, on both clients: the webapp overrides
  the renderer, mobile emits the token's text instead of walking into it. Which
  is the better outcome anyway — a table's `raw` is the source *including* its
  header row, and discarding the parsed cells is what keeps a URL inside one from
  becoming a live link.
- **The image reconstruction format is pinned** in `formatLiteralImage`
  (`shared/src/markdown.ts`) and used by both clients, because both rebuild it
  from parsed tokens rather than echoing the source. If one side dropped the
  title or the leading `!`, `![a](b "t")` would quietly diverge again.
- **Text and View levels never interleave on mobile.** Nesting a View inside a
  Text breaks text wrapping on React Native, which is what makes a *block*
  renderer the hard half: a blockquote containing a list hits it immediately. The
  rule that avoids it is structural — a block owns Views, and everything from the
  inline level down (`inlineNodes.tsx`) is Text all the way. It is also why the
  item renderer is so much smaller: an inline-only subset can never have the
  problem.
- **The card clamps by collapsing to one Text, not by measuring.** A `maxHeight`
  computed from the line height cuts mid-line and is wrong as soon as the OS text
  size changes; an `onLayout` pass truncates only after a first layout, and the
  draggable masonry grid has already cached that card's height by then. See "What
  the card preview substitutes" above.
- **`checkbox` is its own marked token and appears at two levels.** A *tight*
  task list puts it directly in the item's token list, next to a block `text`
  token; a *loose* one puts it inside the item's paragraph, at inline position.
  Mobile's walk buffers the tight run into one paragraph so the marker stays on
  the same line as its text, and swaps the token for `☐` or `☑` plus a space on the inline path
  so both shapes render the same. Handling only one of the two is the easy bug.
- **Narrowing a marked `Token` by `type` does not eliminate `Tokens.Generic`.**
  It carries an index signature, so every other member is assignable to it and
  each `case` comes out as `Tokens.X | Tokens.Generic`, with `any` for the fields
  that matter — `Exclude<Token, Tokens.Generic>` collapses to `never`, so that is
  not the way out either. `mobile/src/utils/markdown.ts` casts per case, guarded
  by the `type` check above it.
- **h4–h6 are styled down, not rewritten.** Both clients emit a real heading and
  give it body size and bold weight, in CSS (`.markdown-content :is(h4, h5, h6)`)
  and in the style map (`markdownStyles.ts`). Rewriting them to paragraphs at
  parse time would look identical and lose the semantics.
  **What "a real heading" buys differs by client**, and it is worth being precise
  rather than claiming parity: the webapp emits `<h1>`–`<h6>`, so assistive
  technology gets the full outline *with levels*. React Native's
  `accessibilityRole="header"` has no level, so mobile's editor announces "this
  is a heading" and no more. Mobile's **card** preview sets no role at all — it is
  one clamped Text inside a control that opens the note, and an outline inside a
  button is noise rather than structure.
- **Link reference definitions render nothing.** `[a]: https://example.com` lexes
  to a `def` token that marked has already resolved into the links using it, so
  both clients skip it. It is the one token type that is neither rendered nor
  degraded to source, and it is not an exception to §3: there is no source left
  to show once the reference has been substituted.

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
