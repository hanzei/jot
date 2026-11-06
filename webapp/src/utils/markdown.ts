import { Lexer } from 'marked';
import DOMPurify from 'dompurify';
import {
  normalizeBlockTokens,
  normalizeInlineTokens,
  flattenInlineNodes,
  inlineRendersAsSource,
  BLOCK_LEXER_OPTIONS,
  INLINE_LEXER_OPTIONS,
  highlightCode,
  type BlockNode,
  type CodeRun,
  type InlineNode,
} from '@jot/shared';
import { getCodeHighlighter } from './codeHighlighter';

// Jot's Markdown feature set is specified in docs/specs/markdown-rendering.md.
//
// This file is only the HTML half. Both clients lex with `marked` and normalize
// through shared/src/blockMarkdown.ts and shared/src/inlineMarkdown.ts, so what
// is a heading, what autolinks, and what an unsupported construct degrades to
// are decided there, once, for both. What is left here is turning the resulting
// nodes into markup — mobile turns the same nodes into React Native components.
//
// So a change to *behaviour* belongs in shared/; a change here is a change to
// how this client draws it.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The effective spec for raw HTML: anything parsed but not listed here has its
// tag stripped and its text kept.
const ALLOWED_TAGS = [
  // h4-h6 stay real heading elements and are styled as bold body text
  // (.markdown-content in index.css), which is also how mobile renders them.
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del',
  'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'hr',
  'a',
  // Highlighted code tokens, carrying their scope as `data-code`. DOMPurify
  // keeps `data-*` attributes by default, and unlike `class` one cannot borrow
  // the app's own utility styles.
  'span',
];
// `start` is only meaningful on <ol>, and without it an ordered list beginning
// at 3 renders as 1 here while mobile numbers it correctly — a divergence this
// allowlist was quietly causing.
const ALLOWED_ATTR = ['href', 'target', 'rel', 'start'];

// Interactive task checkboxes (`renderInteractiveMarkdown`). Only the renderer emits an
// <input>: raw HTML in a note has already been degraded to text by the shared
// normalizer, so none can come from the note itself.
const TASK_TAGS = [...ALLOWED_TAGS, 'input'];
const TASK_ATTR = [...ALLOWED_ATTR, 'type', 'checked', 'aria-label'];

/**
 * Dropping `a` from the allowlist is the whole implementation of the
 * links-as-text rule: DOMPurify strips a tag it does not allow and keeps the
 * text inside it, which is exactly the outcome
 * docs/specs/markdown-rendering.md §3 specifies — the label survives, the target
 * does not, and nothing is left looking clickable.
 */
const NO_LINK_TAGS = ALLOWED_TAGS.filter((tag) => tag !== 'a');


export interface MarkdownRenderOptions {
  /**
   * Whether links render as links. Note cards pass `false`: the whole card is
   * one control that opens the note, so an anchor inside it competes with that —
   * on the webapp a click would follow the link *and* open the note, since both
   * handlers fire. See docs/specs/markdown-rendering.md §1.1.
   */
  links?: boolean;
  /**
   * Whether a fenced block naming a known language is syntax highlighted. Note
   * cards pass `false`, as mobile's card does: a card is six clamped lines, and
   * the dashboard would pay for highlighting every note on it.
   * See docs/specs/markdown-rendering.md §2.3.
   */
  highlight?: boolean;
}

/** Render-time state for one block render: its options, and what it emitted. */
interface BlockRenderContext {
  highlight: boolean;
  /** Whether located task markers render as checkboxes (`renderInteractiveMarkdown`). */
  tasks: boolean;
  /** How many checkboxes were emitted. */
  taskCount: number;
}

/**
 * Renders the blocks of one list item.
 *
 * A *tight* list — every item a single line, which is nearly all of them —
 * renders its paragraphs bare, so `- item` gives `<li>item</li>` rather than
 * `<li><p>item</p></li>` and picks up no paragraph margin. A loose list keeps
 * the `<p>`, because there its items really do hold several blocks. That is
 * CommonMark's distinction, carried on the list node so this does not have to
 * guess it back from the shape of the item.
 */
function renderListItem(blocks: BlockNode[], loose: boolean, ctx: BlockRenderContext): string {
  return blocks
    .map((block) =>
      !loose && block.type === 'paragraph'
        ? renderInlineNodes(block.children, ctx)
        : renderBlockNode(block, ctx),
    )
    .join('');
}

function renderCodeRuns(runs: CodeRun[]): string {
  return runs
    .map(({ text, scope }) =>
      scope === null ? escapeHtml(text) : `<span data-code="${scope}">${escapeHtml(text)}</span>`,
    )
    .join('');
}

function renderBlockNode(node: BlockNode, ctx: BlockRenderContext): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${renderInlineNodes(node.children, ctx)}</p>\n`;

    case 'heading':
      // h4-h6 stay real headings and are styled down in CSS, keeping the
      // document outline for assistive technology.
      return `<h${node.depth}>${renderInlineNodes(node.children, ctx)}</h${node.depth}>\n`;

    case 'code': {
      // No <br> substitution: newlines are significant inside <pre>. No
      // language class either — the tokens carry their own, and an unknown
      // language renders plain (docs/specs §2.3).
      const runs = ctx.highlight ? highlightCode(getCodeHighlighter(), node.text, node.lang) : null;
      return `<pre><code>${runs ? renderCodeRuns(runs) : escapeHtml(node.text)}</code></pre>\n`;
    }

    case 'blockquote':
      return `<blockquote>\n${renderBlockNodes(node.children, ctx)}</blockquote>\n`;

    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      const items = node.items
        .map((item) => `<li>${renderListItem(item, node.loose, ctx)}</li>\n`)
        .join('');
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }

    case 'hr':
      return '<hr>\n';
  }
}

function renderBlockNodes(nodes: BlockNode[], ctx: BlockRenderContext): string {
  return nodes.map((node) => renderBlockNode(node, ctx)).join('');
}

export function renderMarkdown(
  content: string,
  { links = true, highlight = true }: MarkdownRenderOptions = {},
): string {
  if (!content.trim()) return '';
  const nodes = normalizeBlockTokens(Lexer.lex(content, BLOCK_LEXER_OPTIONS));
  return DOMPurify.sanitize(renderBlockNodes(nodes, { highlight, tasks: false, taskCount: 0 }), {
    ALLOWED_TAGS: links ? ALLOWED_TAGS : NO_LINK_TAGS,
    ALLOWED_ATTR,
  });
}

export interface InteractiveMarkdownRender {
  html: string;
  /** Whether `html` holds any task checkbox. */
  hasTasks: boolean;
}

/**
 * Renders text-note content for the open note's preview, where task-list
 * markers are real checkboxes (docs/specs §2.4). Each carries
 * `data-task-offset`, its marker's offset for `toggleTaskMarkerAt`; a marker
 * that cannot be located safely stays ☐ / ☑ text. Note cards use
 * `renderMarkdown`, which never emits a checkbox.
 */
export function renderInteractiveMarkdown(content: string): InteractiveMarkdownRender {
  if (!content.trim()) return { html: '', hasTasks: false };
  const nodes = normalizeBlockTokens(Lexer.lex(content, BLOCK_LEXER_OPTIONS), { taskSource: content });
  const ctx: BlockRenderContext = { highlight: true, tasks: true, taskCount: 0 };
  const html = DOMPurify.sanitize(renderBlockNodes(nodes, ctx), {
    ALLOWED_TAGS: TASK_TAGS,
    ALLOWED_ATTR: TASK_ATTR,
  });
  return { html, hasTasks: ctx.taskCount > 0 };
}

// List-item text renders an inline-only subset — see shared/src/inlineMarkdown.ts
// for what it is and why, and docs/specs/markdown-rendering.md §2.1 for the spec.
// The allowlist is narrower than ALLOWED_TAGS by construction: no block element
// can be produced, so none is permitted through.
const INLINE_ALLOWED_TAGS = ['strong', 'em', 'del', 'code', 'a', 'br'];
const INLINE_NO_LINK_TAGS = INLINE_ALLOWED_TAGS.filter((tag) => tag !== 'a');

function renderInlineNodes(nodes: InlineNode[], ctx?: BlockRenderContext): string {
  let html = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.task && node.task.offset !== null && ctx?.tasks) {
          const { checked, offset, label } = node.task;
          ctx.taskCount++;
          html += `<input type="checkbox" data-task-offset="${offset}"${checked ? ' checked' : ''} aria-label="${escapeHtml(label)}"> `;
          break;
        }
        // A newline that survived into a text node is a line break the reader
        // should see — HTML would collapse it to a space. Only literal source
        // (a table, an HTML block) still carries one; everywhere else `breaks:
        // true` has already turned newlines into `br` nodes.
        html += escapeHtml(node.value).replace(/\n/g, '<br>');
        break;
      case 'code':
        html += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'br':
        html += '<br>';
        break;
      case 'strong':
        html += `<strong>${renderInlineNodes(node.children, ctx)}</strong>`;
        break;
      case 'em':
        html += `<em>${renderInlineNodes(node.children, ctx)}</em>`;
        break;
      case 'del':
        html += `<del>${renderInlineNodes(node.children, ctx)}</del>`;
        break;
      case 'link': {
        // normalizeInlineTokens has already dropped links Jot will not follow
        // and encoded the target (`encodeLinkHref`), which also encodes a quote
        // that would close the attribute; DOMPurify is the net behind that.
        html += `<a href="${node.href}" target="_blank" rel="noopener noreferrer">${renderInlineNodes(node.children, ctx)}</a>`;
        break;
      }
    }
  }

  return html;
}

/**
 * Renders one list-item's text as inline Markdown.
 *
 * Lexed as inline content rather than parsed as a document, which is what keeps
 * `# x`, `- [ ] x` and `---` literal without any suppression: an item is already
 * a list item, so block syntax inside one has nothing to describe.
 */
export function renderInlineMarkdown(
  text: string,
  { links = true }: MarkdownRenderOptions = {},
): string {
  if (!text.trim()) return '';
  const nodes = normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS));
  return sanitizeInline(renderInlineNodes(nodes), links);
}

function sanitizeInline(html: string, links: boolean): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: links ? INLINE_ALLOWED_TAGS : INLINE_NO_LINK_TAGS,
    ALLOWED_ATTR,
  });
}

export interface InlineItemRender {
  /** Sanitized HTML, identical to what `renderInlineMarkdown` produces. */
  html: string;
  /**
   * The nodes the HTML was built from, carrying source spans — the editable row
   * needs them to map a click on the rendered text back to a caret position.
   */
  nodes: InlineNode[];
  /**
   * Whether rendering changed anything. False for `buy milk`, true for
   * `buy **milk**`. The editable row only swaps in a rendered view when this is
   * true, so a list with no Markdown in it behaves exactly as it did before.
   */
  formatted: boolean;
}

/**
 * Renders one item's text *and* reports what the editable row needs to know
 * about it: whether a rendered view is worth showing, and where each rendered
 * character came from.
 *
 * Separate from `renderInlineMarkdown` because the display-only surfaces — note
 * cards, the collapsed-completed label — want the string and nothing else, and
 * lexing with source tracking on for them would be work with no reader.
 */
export function renderInlineItem(
  text: string,
  { links = true }: MarkdownRenderOptions = {},
): InlineItemRender {
  if (!text.trim()) return { html: '', nodes: [], formatted: false };
  const nodes = normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS), 0);
  return {
    html: sanitizeInline(renderInlineNodes(nodes), links),
    nodes,
    formatted: !inlineRendersAsSource(nodes, text),
  };
}

/**
 * The same item text as `renderInlineMarkdown` produces, with the formatting
 * dropped — for an `aria-label`, which must say what the eye sees rather than
 * spelling out the source markers.
 */
export function inlineMarkdownToText(text: string): string {
  if (!text.trim()) return text;
  return flattenInlineNodes(normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS)));
}
