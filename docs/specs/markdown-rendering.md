# Feature Spec: Markdown Rendering

Status: **Implemented** — describes shipped behaviour.
Owner: TBD · Target: Jot webapp + mobile

---

## 1. Scope

Markdown applies to the **`content` of text notes**, and nothing else:

- **List-note item text is plain.** No Markdown is parsed in it; the one piece of
  formatting it gets is bare-URL autolinking, via the `LinkText` component on
  each client.
- **Note titles are plain.** They are rendered as text everywhere.

Both clients render the same feature set from the same source string, so a note
written on a phone reads identically in a browser and the other way round. They
get there through entirely different libraries, which is the reason this document
exists: the two implementations have no shared code path to keep them honest, only
a shared test corpus and this spec.

| | Webapp | Mobile |
|---|---|---|
| Parser | `marked` (`gfm: true`, `breaks: true`) | `markdown-it` (`linkify: true`, `typographer: false`, `html: false`, `breaks: false`) |
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
| Shared conformance corpus (both test suites) | `shared/src/markdownCases.ts` |
| Webapp renderer + tag allowlist | `webapp/src/utils/markdown.ts` |
| Mobile parser, core rules, link render rule | `mobile/src/utils/markdown.tsx` |
| Mobile styles | `mobile/src/utils/markdownStyles.ts` |

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
- **`.disable('table')` on `markdown-it` does work correctly**, leaving plain
  paragraph text. So mobile is asymmetric on purpose — parser-level disable for
  tables, token rewrite for images. Do not "tidy" it into consistency.
- **The image reconstruction format is pinned** in `formatLiteralImage`
  (`shared/src/markdown.ts`) and used by both clients, because both rebuild it
  from parsed tokens rather than echoing the source. If one side dropped the
  title or the leading `!`, `![a](b "t")` would quietly diverge again.
- **Mobile rewrites images at parser level, not in a render rule**, because
  `react-native-markdown-display` marks every image token `block: true`, which
  would break the literal source out of its paragraph and onto its own line.
- **Both mobile core rules run after `linkify`.** Running them before would have
  linkify turn the URL inside a literal `![alt](url)` into a live link.
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
- **Markdown in list-note item text.** It stays plain (§1).
- **Syntax highlighting** in code blocks. The webapp allowlist drops the
  `class="language-js"` attribute `marked` emits, so the language tag is parsed
  and ignored on both clients.

---

## 7. Testing

`shared/src/markdownCases.ts` is the single list of inputs. Both
`webapp/src/utils/__tests__/markdown.test.ts` and
`mobile/__tests__/markdown.test.tsx` assert one expectation per case id and fail
if any id has none, so a case cannot be covered on one client and forgotten on the
other. Adding a case breaks both suites until both are updated.

`webapp/e2e/tests/markdown.spec.ts` covers the same feature set through the
browser, on real note content.
