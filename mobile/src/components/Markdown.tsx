import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { blockMarkdownNodes, type BlockNode } from '../utils/markdown';
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
// Every block that needs a box of its own — a code block's tint, the blockquote
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
}

function renderBlocks(nodes: BlockNode[], ctx: RenderContext, keyPrefix = ''): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;

    switch (node.type) {
      case 'paragraph':
        return (
          <Text key={key} style={[ctx.textStyles.body, { color: ctx.color }]}>
            {renderInlineNodes(node.children, { linkColor: ctx.theme.link }, `${key}.`)}
          </Text>
        );

      case 'heading':
        return (
          <Text key={key} style={[headingStyle(ctx.textStyles, node.depth), { color: ctx.color }]}>
            {renderInlineNodes(node.children, { linkColor: ctx.theme.link }, `${key}.`)}
          </Text>
        );

      case 'code':
        return (
          <View key={key} style={[styles.code, { backgroundColor: ctx.theme.tint }]}>
            <Text style={[ctx.textStyles.body, styles.codeText, { color: ctx.color }]}>
              {node.text}
            </Text>
          </View>
        );

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
}

function Markdown({ content, onColoredNote = false }: MarkdownProps) {
  const { colors, isDark } = useTheme();
  const nodes = useMemo(() => blockMarkdownNodes(content), [content]);
  const theme = useMemo(
    () => markdownTheme(colors, isDark, onColoredNote),
    [colors, isDark, onColoredNote],
  );

  return (
    <View style={styles.blocks}>
      {renderBlocks(nodes, { theme, textStyles: fullMarkdownStyles, color: theme.text })}
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
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
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
