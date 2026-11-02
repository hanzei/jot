// Syntax highlighting for fenced code blocks, decided once for both clients.
//
// This module owns the policy: which languages highlight, what a token is
// called, and what colour it is drawn in. It imports nothing — shared/ has no
// runtime dependencies — so each client creates its own highlight.js instance,
// registers exactly `HIGHLIGHT_LANGUAGES` on it, and hands it to
// `highlightCode`, the same arrangement as `marked` and `normalizeBlockTokens`.
// The client half is webapp/src/utils/codeHighlighter.ts and
// mobile/src/utils/codeHighlighter.ts; the behaviour is specified in
// docs/specs/markdown-rendering.md §2.3.

/**
 * The languages a fence may name, by highlight.js grammar name.
 *
 * Each grammar's own aliases come with it — `js`, `ts`, `py`, `sh`, `html`,
 * `yml` and so on. Anything else renders as plain monospace. The list is short
 * on purpose: every grammar ships in both bundles, and no language is guessed,
 * because auto-detection runs every grammar and still mislabels prose.
 */
export const HIGHLIGHT_LANGUAGES = [
  'bash',
  'css',
  'go',
  'javascript',
  'json',
  'python',
  'sql',
  'typescript',
  'xml',
  'yaml',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

/**
 * What a highlighted token is, coarsely.
 *
 * highlight.js names several dozen scopes; both clients draw seven. Fewer
 * colours stay distinguishable from each other at the contrast `CODE_PALETTE`
 * has to hold, and a renderer that keys on this union cannot miss one.
 */
export const CODE_SCOPES = [
  'keyword',
  'type',
  'string',
  'attribute',
  'literal',
  'title',
  'comment',
] as const;

export type CodeScope = (typeof CODE_SCOPES)[number];

/** A stretch of code drawn one way. `null` is plain code text. */
export interface CodeRun {
  text: string;
  scope: CodeScope | null;
}

/**
 * Token colours, per theme, and the panel a code block sits on.
 *
 * The panel is opaque on purpose. A translucent tint lets the note colour show
 * through, and a palette that holds 4.5:1 on every swatch — coral included —
 * ends up indistinguishable from body text. On one known panel it only has to
 * hold against that panel (`shared/src/__tests__/codeHighlight.test.ts`).
 *
 * `light` is for dark-on-light text and `dark` for light-on-dark, which is not
 * the same question as the app theme: mobile keeps a note's light swatch in
 * dark mode, so a coloured note there takes `light`.
 */
export const CODE_PALETTE = {
  light: {
    panel: '#f3f4f6',
    scopes: {
      keyword: '#c33d43',
      type: '#b05200',
      string: '#007f18',
      attribute: '#007794',
      literal: '#0068dd',
      title: '#9442d9',
      comment: '#656d78',
    },
  },
  dark: {
    panel: '#111827',
    scopes: {
      keyword: '#ff8484',
      type: '#f4902c',
      string: '#53bf5c',
      attribute: '#00b9d8',
      literal: '#49b0ff',
      title: '#d78aff',
      comment: '#88919c',
    },
  },
} as const satisfies Record<'light' | 'dark', { panel: string; scopes: Record<CodeScope, string> }>;

/**
 * Scopes drawn in italic as well as colour. A comment is the one token that
 * reads as "not code", and a muted grey cannot carry that alone at 4.5:1.
 */
export const CODE_ITALIC_SCOPES: ReadonlySet<CodeScope> = new Set<CodeScope>(['comment']);

/**
 * The parts of highlight.js's `HLJSApi` this module calls, declared
 * structurally for the reason given on `InlineMarkdownToken`. A highlight.js
 * instance is assignable to it as is.
 */
export interface CodeHighlighter {
  getLanguage(name: string): object | undefined;
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}

/**
 * highlight.js scope → Jot scope. `null` resets to plain text: `subst` is the
 * code inside a template string, which is not itself a string. A scope missing
 * from the map inherits from the span around it, so a wrapper like `tag` or
 * `function` leaves its contents to their own scopes.
 *
 * A dotted key is a sub-scope (`variable.language` is `this`/`self`) and wins
 * over its first segment.
 */
const SCOPE_BY_HLJS: ReadonlyMap<string, CodeScope | null> = new Map(Object.entries({
  keyword: 'keyword',
  'selector-tag': 'keyword',
  name: 'keyword',
  meta: 'keyword',
  doctag: 'keyword',
  'variable.language': 'keyword',

  type: 'type',
  built_in: 'type',

  string: 'string',
  regexp: 'string',
  symbol: 'string',

  attr: 'attribute',
  attribute: 'attribute',
  property: 'attribute',
  variable: 'attribute',
  'template-variable': 'attribute',
  'selector-attr': 'attribute',
  'selector-pseudo': 'attribute',

  number: 'literal',
  literal: 'literal',
  'variable.constant': 'literal',

  title: 'title',
  section: 'title',
  'selector-id': 'title',
  'selector-class': 'title',

  comment: 'comment',
  quote: 'comment',

  subst: null,
} satisfies Record<string, CodeScope | null>));

/**
 * The language a fence's info string names, normalized: its first word, lower
 * cased, or null for an indented block or a bare fence. Whether it is one Jot
 * highlights is the highlighter's question, not this one's.
 */
export function codeLanguage(info: string | undefined): string | null {
  const word = (info ?? '').trim().split(/\s/, 1)[0] ?? '';
  return word ? word.toLowerCase() : null;
}

/**
 * Highlights a code block, or returns null when it should render plain: no
 * language, a language that is not registered, or a highlighter that fails.
 *
 * The runs always concatenate back to `text` exactly — that is checked rather
 * than assumed, and a mismatch is treated as a failure — so a renderer can
 * substitute them for the plain text without losing a character.
 */
export function highlightCode(
  highlighter: CodeHighlighter,
  text: string,
  language: string | null,
): CodeRun[] | null {
  if (!language || !highlighter.getLanguage(language)) return null;

  let html: string;
  try {
    html = highlighter.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }

  const runs = codeRunsFromHtml(html);
  if (runs === null || runs.map((run) => run.text).join('') !== text) return null;
  return runs;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

/**
 * Reads highlight.js's HTML output back into runs.
 *
 * That output is a closed format: `<span class="…">`, `</span>`, and text with
 * exactly the five characters above escaped. Every `<` in it is therefore a
 * tag, so a scan is enough — no HTML parser, which mobile does not have. It is
 * also highlight.js's public output, unlike the token tree behind it.
 *
 * Returns null on anything outside that format, and `highlightCode` falls back
 * to plain text.
 */
function codeRunsFromHtml(html: string): CodeRun[] | null {
  const runs: CodeRun[] = [];
  const stack: (CodeScope | null)[] = [null];
  const tokens = /<span class="([^"]*)">|<\/span>|[^<]+/gy;

  let match: RegExpExecArray | null;
  while (tokens.lastIndex < html.length && (match = tokens.exec(html)) !== null) {
    const [whole, classes] = match;
    const current = stack[stack.length - 1] ?? null;

    if (classes !== undefined) {
      stack.push(scopeForClasses(classes, current));
    } else if (whole === '</span>') {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      const text = whole.replace(/&#?\w+;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
      const last = runs[runs.length - 1];
      if (last && last.scope === current) last.text += text;
      else runs.push({ text, scope: current });
    }
  }

  // The sticky regex stops at the first character it cannot read; anything
  // left over means the output was not in the expected format.
  return tokens.lastIndex === html.length ? runs : null;
}

/**
 * The scope of a span from its class list: `hljs-title function_` is scope
 * `title`, sub-scope `function`.
 */
function scopeForClasses(classes: string, inherited: CodeScope | null): CodeScope | null {
  const [first = '', ...rest] = classes.split(' ');
  const scope = first.replace(/^hljs-/, '');
  const subScopes = rest.map((part) => part.replace(/_+$/, ''));
  const dotted = [scope, ...subScopes].join('.');

  for (const key of [dotted, scope]) {
    const mapped = SCOPE_BY_HLJS.get(key);
    if (mapped !== undefined) return mapped;
  }
  return inherited;
}
