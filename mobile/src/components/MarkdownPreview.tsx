import React, { memo, useMemo } from 'react';
import { Text, StyleSheet, Platform, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { type BlockNode } from '@jot/shared';
import { blockMarkdownNodes } from '../utils/markdown';
import {
  compactMarkdownStyles,
  headingStyle,
  markdownTheme,
  type MarkdownTheme,
} from '../utils/markdownStyles';
import { renderInlineNodes, type InlineRenderOptions } from './inlineNodes';

// Text-note content on a note card: the same blocks Markdown.tsx renders, laid
// out as **one <Text>** so that `numberOfLines` clamps them.
//
// That is the whole reason this is a separate renderer rather than a style
// variant. React Native has no line-clamp: `numberOfLines` applies to a single
// Text and cannot reach across a tree of Views, which is what a block layout is.
// The alternatives all measure something — a maxHeight computed from the line
// height (cuts mid-line, and wrong the moment the OS text size changes), or an
// onLayout pass that truncates after the fact (a second layout, on a card whose
// height the masonry grid has already cached). Collapsing the blocks into one
// Text instead makes the clamp native: correct ellipsis, one layout pass,
// nothing to measure.
//
// What it costs is the box: no code tint, no blockquote bar, no full-width rule,
// because those are Views. Blocks earn their affordances back as text instead —
// a bullet, a number, a muted colour, a short rule — which is enough at six
// lines and matches what the webapp's clamped card ends up showing anyway.

/** Matches the webapp card's `line-clamp-6` (webapp/src/components/NoteCard.tsx). */
export const PREVIEW_LINES = 6;

/**
 * Stands in for a horizontal rule, which needs a View to span the card.
 *
 * Deliberately not nothing: docs/specs/markdown-rendering.md §3 keeps the
 * "removed entirely" category empty, so a rule that vanished in the preview
 * would read as a card that lost content.
 */
const RULE_RUN = '────────';

/** Nothing on a card is a link — see `InlineRenderOptions` for why. */
const CARD_LINKS: InlineRenderOptions = { links: false };

interface PreviewContext {
  theme: MarkdownTheme;
  /** Body colour at this depth — a blockquote renders its contents muted. */
  color: string;
}

/** Interleaves a newline between blocks; the Text tree has no block spacing. */
function joinLines(parts: React.ReactNode[], keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(<Text key={`${keyPrefix}br${index}`}>{'\n'}</Text>);
    out.push(part);
  });
  return out;
}

function renderBlocks(
  nodes: BlockNode[],
  ctx: PreviewContext,
  indent: string,
  keyPrefix: string,
): React.ReactNode[] {
  const blocks = nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;

    switch (node.type) {
      case 'paragraph':
        return (
          <Text key={key} style={{ color: ctx.color }}>
            {renderInlineNodes(node.children, CARD_LINKS, `${key}.`)}
          </Text>
        );

      case 'heading':
        return (
          <Text key={key} style={[headingStyle(compactMarkdownStyles, node.depth), { color: ctx.color }]}>
            {renderInlineNodes(node.children, CARD_LINKS, `${key}.`)}
          </Text>
        );

      case 'code':
        return (
          <Text key={key} style={[styles.code, { color: ctx.color }]}>
            {node.text}
          </Text>
        );

      case 'blockquote':
        // The bar is a View, so the muted colour carries the quote on its own.
        return (
          <Text key={key}>
            {renderBlocks(node.children, { ...ctx, color: ctx.theme.muted }, indent, `${key}.`)}
          </Text>
        );

      case 'list':
        return (
          <Text key={key}>
            {joinLines(
              node.items.map((item, itemIndex) => (
                <Text key={`${key}.${itemIndex}`} style={{ color: ctx.color }}>
                  {`${indent}${node.ordered ? `${node.start + itemIndex}.` : '•'} `}
                  {/* Nested lists indent by prefix: a Text cannot hang-indent. */}
                  {renderBlocks(item, ctx, `${indent}  `, `${key}.${itemIndex}.`)}
                </Text>
              )),
              key,
            )}
          </Text>
        );

      case 'hr':
        return (
          <Text key={key} style={{ color: ctx.theme.rule }}>
            {RULE_RUN}
          </Text>
        );
    }
  });

  return joinLines(blocks, keyPrefix);
}

interface MarkdownPreviewProps {
  content: string;
  /** True when the note carries a colour, so the body reads dark-on-swatch. */
  onColoredNote?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

function MarkdownPreview({
  content,
  onColoredNote = false,
  numberOfLines = PREVIEW_LINES,
  style,
  testID,
}: MarkdownPreviewProps) {
  const { colors, isDark } = useTheme();
  const nodes = useMemo(() => blockMarkdownNodes(content), [content]);
  const theme = useMemo(
    () => markdownTheme(colors, isDark, onColoredNote),
    [colors, isDark, onColoredNote],
  );

  if (nodes.length === 0) return null;

  return (
    <Text
      style={[compactMarkdownStyles.body, { color: theme.text }, style]}
      numberOfLines={numberOfLines}
      testID={testID}
    >
      {renderBlocks(nodes, { theme, color: theme.text }, '', '')}
    </Text>
  );
}

const styles = StyleSheet.create({
  code: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});

export default memo(MarkdownPreview);
