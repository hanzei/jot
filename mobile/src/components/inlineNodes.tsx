import React from 'react';
import { Text, StyleSheet, Platform } from 'react-native';
import { type InlineNode } from '@jot/shared';
import { openUrl } from '../utils/openUrl';

// Renders the inline half of Jot's Markdown — shared by list-item text
// (InlineMarkdown.tsx) and by both text-note renderers (Markdown.tsx,
// MarkdownPreview.tsx), which differ only in how they lay blocks out.
//
// Everything here is a <Text>, never a <View>. Nesting a View inside a Text
// breaks text wrapping on React Native, so keeping the inline level free of them
// is what lets a caller drop these nodes into either a block layout or a single
// clamped <Text>.

/**
 * Renders nodes as the children of a <Text>.
 *
 * Returns an array rather than an element: the caller owns the enclosing <Text>,
 * because that is where the body style and any `numberOfLines` belong.
 */
export function renderInlineNodes(
  nodes: InlineNode[],
  linkColor: string,
  keyPrefix = '',
): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;

    switch (node.type) {
      case 'text':
        return <Text key={key}>{node.value}</Text>;
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'code':
        return (
          <Text key={key} style={inlineStyles.code}>
            {node.value}
          </Text>
        );
      case 'strong':
        return (
          <Text key={key} style={inlineStyles.strong}>
            {renderInlineNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={inlineStyles.em}>
            {renderInlineNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={inlineStyles.del}>
            {renderInlineNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'link':
        // No scheme check here: `normalizeInlineTokens` has already turned every
        // link Jot will not follow into its own label, so a link node's href is
        // allowed by construction (docs/specs/markdown-rendering.md §2).
        return (
          <Text
            key={key}
            style={[inlineStyles.link, { color: linkColor }]}
            onPress={() => void openUrl(node.href)}
            suppressHighlighting
          >
            {renderInlineNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
    }
  });
}

export const inlineStyles = StyleSheet.create({
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  code: {
    // No background tint: a Text cannot carry padding on Android without
    // clipping its own descenders, and a tint with no padding reads as a
    // highlight rather than as code. The monospace face carries it instead.
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
