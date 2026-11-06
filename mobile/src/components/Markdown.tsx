import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { CODE_ITALIC_SCOPES, highlightCode, type BlockNode, type CodeRun } from '@jot/shared';
import { blockMarkdownNodes } from '../utils/markdown';
import { getCodeHighlighter } from '../utils/codeHighlighter';
import {
  fullMarkdownStyles,
  headingStyle,
  markdownTheme,
  type MarkdownTextStyles,
  type MarkdownTheme,
} from '../utils/markdownStyles';
import { renderInlineNodes } from './inlineNodes';

// Text-note content at full size, for the editor's read mode. The feature set is
// specified in docs/specs/markdown-rendering.md and the parsing lives in
// utils/markdown.ts; this file is only layout.
//
// Every block that needs a box of its own — a code block's panel, the blockquote
// bar, a list's marker column — is a <View>, and the text inside it is a <Text>.
// A View nested *inside* a Text breaks wrapping on React Native, so the two
// levels never interleave: a block owns Views, and everything below the block
// level (inlineNodes.tsx) is Text all the way down. MarkdownPreview.tsx makes
// the opposite trade for the note card, where a single clamped Text is the point.

interface RenderContext {
  theme: MarkdownTheme;
  textStyles: MarkdownTextStyles;
  /** Body colour at this depth — a blockquote renders its contents muted. */
  color: string;
  /** Present only when checkboxes are tappable (the note is editable). */
  onToggleTask?: ((offset: number) => void) | undefined;
}

/**
 * A highlighted block's tokens, as Text nested in the block's own Text — so the
 * whole block still wraps and selects as one, and plain runs stay bare strings
 * that inherit the block's colour.
 */
function renderCodeRuns(runs: CodeRun[], theme: MarkdownTheme): React.ReactNode[] {
  return runs.map(({ text, scope }, index) =>
    scope === null ? text : (
      <Text
        key={index}
        style={[
          { color: theme.code.scopes[scope] },
          CODE_ITALIC_SCOPES.has(scope) && styles.codeItalic,
        ]}
      >
        {text}
      </Text>
    ),
  );
}

function renderBlocks(nodes: BlockNode[], ctx: RenderContext, keyPrefix = ''): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;

    switch (node.type) {
      case 'paragraph':
        return (
          <Text key={key} style={[ctx.textStyles.body, { color: ctx.color }]}>
            {renderInlineNodes(node.children, { linkColor: ctx.theme.link, onToggleTask: ctx.onToggleTask }, `${key}.`)}
          </Text>
        );

      case 'heading':
        // React Native's header role carries no level, so this says "a heading
        // is here" and nothing about depth — less than the webapp's <h1>-<h6>,
        // but the difference between a heading and a bold paragraph is the part
        // assistive technology can actually navigate by.
        return (
          <Text
            key={key}
            accessibilityRole="header"
            style={[headingStyle(ctx.textStyles, node.depth), { color: ctx.color }]}
          >
            {renderInlineNodes(node.children, { linkColor: ctx.theme.link, onToggleTask: ctx.onToggleTask }, `${key}.`)}
          </Text>
        );

      case 'code': {
        // A language Jot does not highlight, or none, renders the same block
        // plain (docs/specs/markdown-rendering.md §2.3).
        const runs = highlightCode(getCodeHighlighter(), node.text, node.lang);
        return (
          <View
            key={key}
            style={[styles.code, { backgroundColor: ctx.theme.code.panel, borderColor: ctx.theme.code.border }]}
          >
            {/* The palette's text, not ctx.color: a blockquote's muted colour
                does not hold 4.5:1 on the panel. */}
            <Text style={[ctx.textStyles.body, styles.codeText, { color: ctx.theme.code.text }]}>
              {runs ? renderCodeRuns(runs, ctx.theme) : node.text}
            </Text>
          </View>
        );
      }

      case 'blockquote':
        return (
          <View key={key} style={[styles.blockquote, { borderLeftColor: ctx.theme.rule }]}>
            {renderBlocks(node.children, { ...ctx, color: ctx.theme.muted }, `${key}.`)}
          </View>
        );

      case 'list':
        return (
          <View key={key} style={styles.list}>
            {node.items.map((item, itemIndex) => (
              <View key={`${key}.${itemIndex}`} style={styles.listItem}>
                <Text style={[ctx.textStyles.body, styles.listMarker, { color: ctx.color }]}>
                  {node.ordered ? `${node.start + itemIndex}.` : '•'}
                </Text>
                <View style={styles.listContent}>
                  {renderBlocks(item, ctx, `${key}.${itemIndex}.`)}
                </View>
              </View>
            ))}
          </View>
        );

      case 'hr':
        return <View key={key} style={[styles.hr, { backgroundColor: ctx.theme.rule }]} />;
    }
  });
}

interface MarkdownProps {
  content: string;
  /** True when the note carries a colour, so the body reads dark-on-swatch. */
  onColoredNote?: boolean;
  /**
   * Called with a task marker's source offset when its checkbox is tapped. When
   * omitted (a trashed note) checkboxes stay ☐ / ☑ text, and no offsets are
   * computed (docs/specs/markdown-rendering.md §2.4).
   */
  onToggleTask?: ((offset: number) => void) | undefined;
}

function Markdown({ content, onColoredNote = false, onToggleTask }: MarkdownProps) {
  const { colors, isDark } = useTheme();
  const tappable = onToggleTask !== undefined;
  const nodes = useMemo(() => blockMarkdownNodes(content, tappable), [content, tappable]);
  const theme = useMemo(
    () => markdownTheme(colors, isDark, onColoredNote),
    [colors, isDark, onColoredNote],
  );

  return (
    <View style={styles.blocks}>
      {renderBlocks(nodes, { theme, textStyles: fullMarkdownStyles, color: theme.text, onToggleTask })}
    </View>
  );
}

const styles = StyleSheet.create({
  // One gap rather than per-block margins: blocks nest (a list item holds
  // paragraphs, a blockquote holds anything), and margins would compound at
  // every level.
  blocks: { gap: 8 },
  code: {
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  codeItalic: { fontStyle: 'italic' },
  blockquote: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    gap: 8,
  },
  // Items sit closer together than blocks do — a list is one thing, not several.
  list: { gap: 2 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  listMarker: {
    width: 18,
  },
  // Nested lists indent for free: they render inside this column.
  listContent: {
    flex: 1,
    gap: 8,
  },
  hr: {
    height: 1,
    marginVertical: 2,
  },
});

export default memo(Markdown);
