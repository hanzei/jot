import React from 'react';
import { Linking, Text } from 'react-native';
import { MarkdownIt } from 'react-native-markdown-display';
import { formatLiteralImage, isAllowedLinkHref } from '@jot/shared';

// Jot's Markdown feature set is specified in docs/specs/markdown-rendering.md
// and is shared with the webapp, which reaches it through marked + a DOMPurify
// allowlist. Anything changed here needs a matching change in
// webapp/src/utils/markdown.ts.
//
// react-native-markdown-display ships no types, so the markdown-it shapes we
// touch are declared structurally below.

interface MarkdownToken {
  type: string;
  content: string;
  children: MarkdownToken[] | null;
  attrGet(name: string): string | null;
}

interface MarkdownCoreState {
  tokens: MarkdownToken[];
  Token: new (type: string, tag: string, nesting: number) => MarkdownToken;
}

type CoreRule = (state: MarkdownCoreState) => void;

interface MarkdownParser {
  disable(rules: string | string[]): MarkdownParser;
  core: { ruler: { after(afterName: string, ruleName: string, rule: CoreRule): void } };
}

function textToken(state: MarkdownCoreState, content: string): MarkdownToken {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

/**
 * Replace image tokens with their literal source.
 *
 * markdown-it's `.disable('image')` looks like the obvious move and is a trap:
 * it produces `!` followed by a *live link* (`[alt](https://x/y.png)` →
 * `!<a href="https://x/y.png">alt</a>`), and an invisible clickable link when
 * the alt text is empty. Rewriting the token is what actually yields text.
 *
 * Done at parser level rather than as a render rule because
 * react-native-markdown-display marks every image token `block: true`, which
 * would break the literal source out of its paragraph onto its own line —
 * the webapp keeps it inline.
 */
const literalImages: CoreRule = (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    for (let i = 0; i < token.children.length; i++) {
      const child = token.children[i];
      if (child.type !== 'image') continue;
      // `content` is the raw alt text; src and title are attributes.
      token.children[i] = textToken(
        state,
        formatLiteralImage(child.content, child.attrGet('src') ?? '', child.attrGet('title')),
      );
    }
  }
};

/**
 * Render `- [ ]` / `- [x]` list markers as ☐ / ☑.
 *
 * markdown-it has no task-list support, so the marker survives as literal text
 * at the head of the item's first inline token and only has to be swapped out.
 * Matching on that position is what keeps checkbox syntax inside a fenced code
 * block — or in an ordinary paragraph — untouched, as it is on the webapp.
 */
const unicodeTaskMarkers: CoreRule = (state) => {
  for (let i = 2; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type !== 'inline' || !token.children?.length) continue;
    if (state.tokens[i - 1].type !== 'paragraph_open') continue;
    if (state.tokens[i - 2].type !== 'list_item_open') continue;

    const first = token.children[0];
    if (first.type !== 'text') continue;
    first.content = first.content.replace(/^\[([ xX])\](\s|$)/, (_match, mark: string, tail: string) =>
      mark === ' ' ? `☐${tail}` : `☑${tail}`,
    );
  }
};

export function createMarkdownParser(): MarkdownParser {
  const md = MarkdownIt({
    // Bare URLs become links, matching marked's gfm autolinking.
    linkify: true,
    // No smart typography: `--` stays `--` and "quotes" stay straight, because
    // marked has no equivalent. This is on by default in
    // react-native-markdown-display, so it has to be turned off explicitly.
    typographer: false,
    // Raw HTML is never rendered; the tags survive as literal text. The webapp
    // matches by escaping raw HTML in its renderer — leaving that to the
    // DOMPurify allowlist would strip the tag and keep only the words.
    html: false,
    // Single newlines still break, via react-native-markdown-display's
    // softbreak render rule, which emits "\n" regardless of this option. The
    // webapp gets there through marked's `breaks: true` — same output,
    // different mechanism, so switching this to `true` would look like a
    // harmless alignment and silently change nothing until that rule changes.
    breaks: false,
  }) as unknown as MarkdownParser;

  // Unlike images above, the parser-level disable *is* right for tables: it
  // leaves the pipe rows as plain paragraph text, which is exactly the target
  // behaviour. The asymmetry between the two is deliberate.
  md.disable('table');

  md.core.ruler.after('linkify', 'jot_literal_images', literalImages);
  md.core.ruler.after('jot_literal_images', 'jot_task_markers', unicodeTaskMarkers);

  return md;
}

/**
 * Shared parser instance. markdown-it holds no per-parse state, and
 * react-native-markdown-display memoizes on the identity of this prop, so one
 * module-level instance avoids rebuilding the parser on every render.
 */
export const markdownParser = createMarkdownParser();

interface AstNode {
  key: string;
  type: string;
  content: string;
  attributes: Record<string, string | undefined>;
}

type NodeStyles = Record<string, object>;

export const markdownRules = {
  /**
   * Links outside the allowed schemes render as their label, with no press
   * handler — the same thing the webapp does. `onLinkPress` alone would leave a
   * link-styled, tappable-looking element that does nothing.
   */
  link: (
    node: AstNode,
    children: React.ReactNode,
    _parent: AstNode[],
    styles: NodeStyles,
    onLinkPress?: (url: string) => boolean,
  ) => {
    const href = node.attributes.href ?? '';
    if (!isAllowedLinkHref(href)) {
      return <Text key={node.key}>{children}</Text>;
    }
    // Same contract as the library's own openUrl helper — an onLinkPress that
    // returns false blocks the navigation — but called directly, because the
    // untyped export infers a one-argument signature.
    const press = () => {
      if (onLinkPress && !onLinkPress(href)) return;
      void Linking.openURL(href);
    };
    return (
      <Text key={node.key} style={styles.link} onPress={press}>
        {children}
      </Text>
    );
  },
};

/**
 * `onLinkPress` guard for <Markdown>. Belt and braces with the `link` rule
 * above: it also covers `blocklink`, which the default rules open with no
 * filtering at all, so a collaborator's note could otherwise drive
 * `Linking.openURL` into an arbitrary app deep link.
 */
export const allowLinkPress = (url: string): boolean => isAllowedLinkHref(url);
