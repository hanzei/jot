# Feature Spec: Markdown Rendering

Status: **Implemented** — describes shipped behaviour.
Owner: TBD · Target: Jot webapp + mobile

---

## 1. Scope

Markdown applies to the **`content` of text notes** in full, and to **list-note
item text** in an inline-only subset (§2.1):

- **Note titles are plain.** They are rendered as text everywhere.
- **List-item Markdown renders everywhere, on both clients.** Note cards,
  mobile's read-only editor and the collapsed-completed parent label render it,
  and so does the *editable* row, which swaps to source while it holds the caret
  (§1.2).

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
render live links, which is where a reader who wants the link already is. An
*editable* list-item row is the one other place a link stays inert, for a
different reason — §1.2.

Both clients render the same feature set from the same source string, so a note
written on a phone reads identically in a browser and the other way round.

### 1.2 The editable row swaps between rendered and source

A list-item row shows its Markdown rendered until it holds the caret, and its
source for exactly as long as it does. Type `**Milk**`, move away, and the row
reads **Milk**; come back to it and it reads `**Milk**` again, with the caret
where you pointed.

The decisions below were made on the webapp and then carried to mobile, which is
why they are written once. Where the platforms genuinely differ — how a point
becomes a caret, and what keeps the field alive across the swap — the difference
is called out inline rather than given its own section.

**Focused and editing are the same state.** That is the decision the rest
follows from. Every keystroke a row handles — Tab to indent, Enter to split,
arrows to move between rows and through the completed-item suggestions — stays
on a real text field, because a row that has the caret *is* one. There is no
render-mode duplicate of any of it, and no focusable non-interactive element in
the markup for a screen reader to find or axe to flag.

Four consequences, each of which is a trap avoided rather than a preference:

- **The field is never unmounted**, only moved out of flow and faded to zero
  opacity. Everything that reaches for a row imperatively — Enter-to-split,
  arrow navigation, "add item" focus, all through the client's map of row refs —
  keeps working on a row that happens to be rendered, and on the webapp the
  height the field comes back at was measured while it was on screen rather than
  at the moment of focus. `visibility: hidden` and `display: none` both remove
  an element from the focus order, so neither can be used there; RN's
  `display: 'none'` detaches the native view, which is the same problem.

  **On mobile this is the whole feature, not a detail of it.** React Native
  keeps the software keyboard up when focus moves directly between two mounted
  `TextInput`s, and generally does not when it moves across an unmount — so a
  row swap that unmounted the field would dismiss and reopen the keyboard, and
  jump the scroll position with it, on the most common interaction a list note
  has. Two other approaches were considered and rejected: keeping the outgoing
  field mounted for one frame (a timing guess, and one that fails under load),
  and a whole-list preview toggle (which would mean leaving preview mode to tick
  a checkbox — the primary interaction on a list note, and the reason the swap is
  per row in the first place). Never unmounting has no such failure mode, and is
  what the webapp already does.
- **A row only swaps when rendering changes something.** `buy milk` renders to
  `buy milk`, so that row keeps the always-live input it has always had. So do
  `# not a heading` and `![alt](url)`, which §2.1 shows as literal source. Only
  a row whose author typed markup that actually renders pays for any of this,
  which is what keeps a plain list exactly as it was.
- **An editable row's links are inert; a read-only row's are live.** One click
  in an editable row already means "put the caret here", and a second meaning on
  the same pixel has no way to resolve itself — so the label renders as ordinary
  text and nothing looks followable, the same outcome as a card (§1.1) reached
  by a different route. A read-only row has no caret to place, so its links work
  and it drops the hidden field entirely rather than leaving a focusable copy
  of the text behind the rendered one.
- **Completed rows render like any other**, `~~strike~~` and all, which §2.1
  already accepted for display surfaces. A struck word inside an already-struck
  row is indistinguishable; that is the cost of the subset staying a subset.

**A click or tap has to place the caret itself.** The user points at character 4
of `buy milk` and the field holds `buy **milk**`, where that character is at 6.
`inlineSourceOffset` maps a *rendered* offset back through the source spans
`normalizeInlineTokens` records — that half is shared. Without it the caret lands
at 0 on every click, which is what the *text-note* editor does today, and is
tolerable there only because it happens once per note instead of once per row.

**Getting to that rendered offset is per client**, because only the webapp is
handed one:

- The browser has `caretPositionFromPoint`, which resolves a point to a DOM
  position; `webapp/src/utils/inlineCaret.ts` then counts the visible characters
  before it, `<br>` included.
- React Native has no equivalent, so `mobile/src/utils/inlineCaret.ts`
  reconstructs the mapping from the line boxes `onTextLayout` reports: which line
  the tap fell in, then a linear interpolation across it. That is exact only in a
  monospaced face — in a proportional one a tap inside a long line can land a
  character or two off, the same order of error the source mapping already
  tolerates elsewhere, and correctable the moment the caret is visible. The
  alternative is laying out every substring separately, on every row of every
  list note.

Both clients then hand the offset to the field: the webapp with
`setSelectionRange`, mobile through the controlled `selection` prop, released
once the input reports the caret landed (the same force-and-release the
formatting bar uses, §5.1).

**Both forms must be the same height**, or every click shifts the rows below it.
They carry the same width, padding and wrapping — one class list on the webapp,
one style object on mobile — and each client has one property that matters more
than it looks.

On the webapp that property is that **both are `block`**.

That is there to remove the line box from the question rather than to match it.
A textarea is an `inline-block` by default, so it sits on a baseline and the line
box around it reserves descender space underneath — and how much is a property of
the platform's font and UA stylesheet. Reproducing that on a span is possible
(`overflow` moves a baseline to the bottom margin edge, CSS 2.1 §10.8.1) and was
the first attempt, but it only held on the font it was measured against: on
Windows the textarea did not reserve the space and the span did, so every row
grew about 7px the moment it lost focus. Blocks have no baseline to disagree
about, and each box is then `lines × line-height + padding` from the same
inherited metrics — equal on any platform.

The same trap has a second entrance, inside the rendered form. An inline box is
as tall as its `line-height` and sits around the shared baseline, so a child in a
*different font* is offset differently from the line's strut and can push the
line box past it. `.markdown-inline code` sets `font-mono`, which made a row
containing `` `code` `` taller rendered than in source — by 0.6px on one font and
who knows what on another. `leading-none` on it keeps its inline box under the
strut on any font, and does not change the chip, since an inline element's
background paints its content area rather than its line box.

Where the two forms genuinely differ — markers moving a wrap point, so the source
occupies more lines — the change is animated over 120ms, behind
`prefersReducedMotion`.

On mobile the equivalent property is an explicit **`lineHeight`**, plus an
explicit `paddingLeft`. Left unset, a `Text` and a `TextInput` each derive their
line height from the font and disagree on Android, where the input adds the
font's own ascent/descent padding on top; an Android `TextInput` likewise
inherits the theme's `EditText` padding on any side a style does not set, while a
`Text` inherits nothing. Pinning both makes each box `lines × lineHeight +
padding` from the same numbers on either platform. Nothing is animated: the
rendered form is never wider than its source, so the wrap point moves the other
way, and a row that does change height changes it by shrinking.

**A drag does not change the height of the row it starts on.** The webapp's grip
prevents the default mousedown, so grabbing it never moves focus off the field;
otherwise the row would change height in the same tick the `PointerSensor`
activates and dnd-kit measures, and the drag would run against a rect for a size
the row no longer has. A keyboard drag needs no such guard: it arrives by Tab, so
the row has already collapsed and settled before Space starts it. Mobile reaches
the same guarantee from the other end — the row's form is *frozen* for as long as
`react-native-reorderable-list` reports it active, so whatever takes focus off
the field mid-gesture, the lifted cell keeps the size the list measured.

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

**The first non-blank line, when it is a heading, becomes the list's title**
rather than its first item — the inverse of the `# h1` line the other direction
writes, and what makes a list note keep its title across a round trip through
text. Any level is promoted, since `## Groceries` is a title the user typed as a
heading and accepting only `#` would look like the feature was broken; the level
itself is not preserved, because a list has one title and converting back writes
it as `#`. Three cases deliberately do *not* promote, and each falls back to the
line becoming an item exactly as it did before:

- A heading behind another construct (`> # Groceries`, `- # Groceries`) — the
  `#` is nested inside a quote or a list item there, not standing as the note's
  title.
- A setext heading (`Groceries` over `=====`) — the converter is line-by-line
  by design, and recognizing setext means lookahead plus a rule for the leftover
  underline.
- A heading longer than `TITLE_MAX_LENGTH` (200) — the server would reject the
  title outright, and truncating would drop text the note still holds.

The clients send the promoted title as `title` on the convert request, alongside
the precomputed items; the server persists it rather than clearing the title as
it used to. Omitting the field leaves the note untitled, which is what every
client did before it existed.

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

- **List → text → list returns the same items *and* the title** — text,
  completed state and nesting all survive, and the `# h1` line is promoted back
  into the title it came from. The one exception is an item whose text *begins*
  with `#` or `>`: that prefix is consumed on the way back, because the
  converter cannot distinguish it from the block markup it exists to strip.
- **Text → list → text normalizes rather than preserves.** Inline formatting,
  nesting and a leading heading survive, but every other line returns as
  `- [ ]` / `- [x]`, so content that used any other structural prefix is not
  byte-identical: `* Eggs`, `1. Eggs` and `> Eggs` all come back as
  `- [ ] Eggs`. This is inherent to the destination — an item has one
  representation, so every way of writing a line collapses onto it. A leading
  `## Groceries` comes back as `# Groceries` (title level is not preserved); a
  heading anywhere later comes back as `- [ ] Groceries` like any other line.

Also not recovered, in either direction, is anything the line-per-item split
discards: blank lines, and the distinction between a wrapped paragraph and
separate lines.

**The item caps are checked before sending.** `checkConvertToListCaps`
(`shared/src/noteConversion.ts`) takes the `ConvertedListNote` `textToListNote`
already produced and checks it against `ITEM_MAX_COUNT` (500) and
`ITEM_TEXT_MAX_LENGTH` (500) — the same caps the server enforces — returning
which one was hit and its limit, or `null` when the conversion is within both.
Item count is checked first, matching the order the webapp's paste guard
(`note.tooManyItems`) already used. Keeping inline markers rather than
stripping them makes the text-length cap slightly easier to hit, since the cap
is measured on the source: `**Buy** milk` is 12 code points against the limit
and 8 on screen.

Both clients call it before a text→list conversion is sent, and both refuse
rather than truncate — the item text and count reaching the server unchanged
is what the server's own validation is checked against. The webapp checks in
`NoteModal`'s convert handler and shows the violation via the same
`note.tooManyItems` / `note.itemTooLong` messages the paste path uses. Mobile
checks inside `buildConvertNoteTypeRequest` (`mobile/src/hooks/useNotes.ts`),
throwing `NoteConversionCapError` before either the online request or the
offline apply/enqueue — so an oversized conversion is never written to local
SQLite or queued for replay, and `NoteEditorScreen` maps the thrown error to
the same two messages via `Alert.alert`.

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
`--` stays `--` and `"hi"` keeps its straight quotes. `marked` has no
equivalent of markdown-it's `typographer`, and both clients lex with `marked`,
so nothing has to be switched off — it is recorded here because mobile *did*
have it, from a renderer whose parser enabled it by default, and enabling it on
one client only is exactly the kind of drift this spec exists to prevent.

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
| Webapp editable-row swap (§1.2) | `webapp/src/components/SortableItem.tsx` |
| Shared rendered-offset → source-offset map | `inlineSourceOffset` in `shared/src/inlineMarkdown.ts` |
| Webapp click point → rendered offset | `webapp/src/utils/inlineCaret.ts` |
| Mobile block lexing entry point | `mobile/src/utils/markdown.ts` |
| Mobile block renderer (editor) | `mobile/src/components/Markdown.tsx` |
| Mobile card preview renderer | `mobile/src/components/MarkdownPreview.tsx` |
| Mobile item lexing + plain-text flattening | `mobile/src/utils/inlineMarkdown.ts` |
| Mobile item renderer | `mobile/src/components/InlineMarkdown.tsx` |
| Mobile editable-row swap (§1.2) | `mobile/src/components/ListItem.tsx` |
| Mobile tap point → rendered offset | `mobile/src/utils/inlineCaret.ts` |
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
resolve — the same trap as the `@babel/runtime` note in `CLAUDE.md`. `marked`
stays a devDependency of `shared/` for its own test suite, which `shared-ci.yml`
does install, and is a real dependency of both consumers, which do the lexing.

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

### 5.1 Authoring the syntax

Both clients also *write* this syntax, from a formatting bar over the editor —
bold, italic, strikethrough, a heading cycle, bullet and checklist — plus list
continuation when Enter is pressed at the end of a list item.

**The bar has two forms, and the split is §2 versus §2.1 rather than a
preference.** Over a text note's content it carries all six buttons. Over a
list-item row it carries the inline three only: an item is lexed as inline
content, so `## x`, `- x` and `- [ ] x` stay literal source there (§2.1) and a
button for them would write characters guaranteed never to render — the checkbox
one twice over, since the row already has a real checkbox. Both clients drop the
same three, so the two still read as one feature.

Inline code and links have no button on either form. That is the pre-existing
line for content and item alike: the bar covers what a selection can be wrapped
in, and a link needs a target the bar cannot ask for.

**Note titles have no bar at all** — they are plain text everywhere (§1).

| Concern | File |
|---|---|
| Shared caret/selection transforms | `shared/src/markdownEdits.ts` |
| Webapp toolbar (both variants) | `webapp/src/components/MarkdownToolbar.tsx` |
| Webapp undo-preserving write-back | `webapp/src/utils/textareaEdit.ts` |
| Mobile formatting bar (both variants) | `mobile/src/screens/noteEditor/EditorToolbars.tsx` |
| Mobile row caret handle | `mobile/src/components/ListItem.tsx` (`ListItemSelectionHandle`) |

The transforms are pure and shared, so both clients produce identical text for
the same input and selection, and one suite
(`shared/src/__tests__/markdownEdits.test.ts`) covers both. **Applying the
result is deliberately per-client.** Mobile sets state and forces the caret
through the controlled `selection` prop on `TextInput`; the webapp replays the
edit through the DOM with `execCommand('insertText')` over the changed span,
because assigning `textarea.value` — which is what a plain `setContent` makes
React do — empties the browser's native undo stack, so a toolbar press would
discard everything typed before it.

The heading button stops at `###`, matching §2: a fourth press would produce an
`####` that renders as body text.

**Where the item bar lives is per client, and both answers follow from §1.2 —
the bar must not take focus, because a row that loses the caret stops showing
its source.** The webapp prevents `mousedown` on every button (the same guard
the content bar has); mobile marks them `focusable={false}` (the same guard, for
the same reason it already needed one).

**Both clients dock the bar — content and item alike — to the editor's chrome
rather than laying it out with the text it edits**, and that is not cosmetic:
a note is as long as the user makes it, so a bar in the scrolling content sits
wherever the content ends. Placed in the webapp modal's scrollable body, a
25-item list put it ~490px below the viewport while the caret was in the top row
— present, correct, and unreachable, and a long text note's grown-to-fit
textarea did the same to the content bar. Both now sit between that body and the
action bar, in one shared slot that swaps only its button set. Mobile's Android
bars were already pinned above the action bar for the same reason.

Beyond that they diverge, because a phone has a keyboard in the way:

- **The webapp** keeps one bar per note, aimed at the content textarea or at
  whichever row holds the caret, and hides it — `visibility: hidden`, keeping
  its slot — while there is no such field. The reserved slot is load-bearing:
  the modal is centred in the viewport, so a bar that mounted and unmounted
  would grow the panel and shift the content out from under the pointer each
  time editing started. It also takes the buttons out of the focus order while
  inert, so the hidden bar is hidden from everyone rather than only from the
  mouse. `aria-controls` names the field it is aimed at and is absent while it
  is hidden, which is the same question as "is it live?" and so is answered
  once.

  **"Is a row still being edited?" is answered once focus has settled, not when
  a field blurs.** Tab out of a row's field and focus goes to that row's own
  delete control, then its assignee control, and only then the toolbar — so a
  bar that hid on the bare blur was gone before Tab could reach it, and the next
  Tab went straight past it to the action bar. Keyboard users could not reach it
  at all. The clear is therefore deferred and then asks where focus actually
  landed; anything inside a row or inside the toolbar keeps the bar, and the row
  keeps showing source so the selection the next press acts on stays visible.
  The same deferral is what stops row-to-row movement flickering the bar.

  **The content bar needs none of that**, and that is the one place the two
  variants part company. A text note's edit mode is explicit — it ends on
  Escape, on Done, or on a click outside the panel, never on a blur — so the bar
  is live exactly while the textarea is on screen and has nothing to report back.
  Tab out of the textarea now passes the rest of the scrolling body (labels,
  share avatars) before reaching the bar, which is the right order for where the
  bar sits, and costs nothing precisely because leaving the field does not end
  the edit.
- **Mobile puts it where the keyboard is.** On iOS the content field and every
  row carry a bar's `nativeID`, so an `InputAccessoryView` docks above the
  keyboard for whichever is focused and nothing has to track which. On Android
  both render inline above the action bar while their field holds the caret,
  the item one with the clear deferred ~150ms so tapping from one row to the
  next does not flash it away and back.

A text note has exactly one editing surface where a list has N rows for one bar
to serve, so only the item variant has to work out *which* field it is aimed at.
That is a difference in bookkeeping, not in placement: both land in the same
slot, above the action bar, and a user switching between a text note and a list
finds the same buttons in the same place.

One more difference, invisible in the UI: the webapp reads the caret straight
off the focused `<textarea>`, while mobile's rows own their selection state
(§1.2's force-and-release), so the editor reaches it through a per-row imperative
handle rather than lifting it. An item at `ITEM_TEXT_MAX_LENGTH` drops the press
on both clients with a toast — the markers are characters the user did not type,
and truncating would eat the tail of the text instead.

`Ctrl`/`Cmd`+`B` and `+I` reuse `toggleInlineMarker` from a keydown handler
rather than a toolbar button, on both surfaces: the content field and a list
item's row (`webapp/src/components/NoteModal.tsx`, `handleItemKeyDown`), since
an item renders the same inline subset as content (§2.1). They are the same two
transforms the bar's first two buttons run, so the two routes cannot disagree.
Heading, bullet and checkbox stay toolbar-only and text-note-only; strikethrough
is on both bars but has no keyboard shortcut on either surface.

---

## 6. Deliberately not covered

- **Interactive checkboxes.** Toggling a rendered ☐ would mean writing back into
  `content` — a much larger feature than rendering.
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

The editable row's swap (§1.2) is covered per client rather than by the corpus,
since it is a state machine rather than a rendering:
`webapp/src/components/__tests__/SortableItem.test.tsx` and
`mobile/__tests__/ListItem.test.tsx` for which form is showing and that the
field survives it, `webapp/src/utils/__tests__/inlineCaret.test.ts` and
`mobile/__tests__/inlineCaret.test.ts` for the point-to-caret mapping — the
half of it that exists without a layout engine.

The formatting bars (§5.1) are covered per client too, since what they write is
already tested at the shared transforms and what is left is per-surface wiring:
`webapp/src/components/__tests__/NoteModal.test.tsx` and
`mobile/__tests__/NoteEditorScreen.formatting-bar.test.tsx` for the content bar,
the same NoteModal suite and
`mobile/__tests__/NoteEditorScreen.item-formatting-bar.test.tsx` for the item
one. Each asserts that the block buttons are *absent* from the item variant, so
adding one back breaks a test on both clients rather than shipping a button that
writes source nothing renders.

`webapp/e2e/tests/markdown.spec.ts` covers the same feature set through the
browser, on real note content — including the three things only a browser shows:
that a bar press leaves the row focused (so it keeps its source form), that the
edit is still undoable afterwards, and that the docked bar is in the viewport
while the caret sits at the top of content taller than the modal. The last one
is asserted for a long list *and* a long text note, since the in-flow layout it
replaced put each of them out of reach on its own terms.
