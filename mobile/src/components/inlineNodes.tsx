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
 * Whether this surface renders links, and in what colour.
 *
 * A union rather than an optional flag so that a surface which does not follow
 * links cannot be asked for a link colour it would never use. Note cards are
 * that surface: the whole card is one control that opens the note, so a tappable
 * link inside it competes with that. A link there renders as its label — no
 * underline, no link colour, nothing to tap — because something that looks
 * tappable and is not is worse than plain text. See
 * docs/specs/markdown-rendering.md §1.1.
 */
export type InlineRenderOptions = { links: false } | { links?: true; linkColor: string };

/**
 * Renders nodes as the children of a <Text>.
 *
 * Returns an array rather than an element: the caller owns the enclosing <Text>,
 * because that is where the body style and any `numberOfLines` belong.
 */
export function renderInlineNodes(
  nodes: InlineNode[],
  options: InlineRenderOptions,
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
            {renderInlineNodes(node.children, options, `${key}.`)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={inlineStyles.em}>
            {renderInlineNodes(node.children, options, `${key}.`)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={inlineStyles.del}>
            {renderInlineNodes(node.children, options, `${key}.`)}
          </Text>
        );
      case 'link': {
        const children = renderInlineNodes(node.children, options, `${key}.`);
        // The bare label is what a link degrades to on a surface that does not
        // follow links — the same shape `normalizeInlineTokens` already gives a
        // link whose scheme Jot refuses.
        if (options.links === false) return <Text key={key}>{children}</Text>;
        // No scheme check here: `normalizeInlineTokens` has already turned every
        // link Jot will not follow into its own label, so a link node's href is
        // allowed by construction (docs/specs/markdown-rendering.md §2).
        return (
          <Text
            key={key}
            style={[inlineStyles.link, { color: options.linkColor }]}
            onPress={() => void openUrl(node.href)}
            suppressHighlighting
          >
            {children}
          </Text>
        );
      }
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
