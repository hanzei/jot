import React, { memo, useMemo } from 'react';
import { Text, StyleSheet, Platform, type StyleProp, type TextStyle } from 'react-native';
import { type InlineNode } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';
import { inlineMarkdownNodes } from '../utils/inlineMarkdown';
import { openUrl } from '../utils/openUrl';

interface InlineMarkdownProps {
  /** Raw list-item text. Rendered as the inline Markdown subset. */
  text: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Renders list-item text as inline Markdown, matching the webapp's
 * renderInlineMarkdown output construct for construct.
 *
 * Everything here is a <Text>, never a <View>, which is what makes an inline
 * renderer tractable on React Native: nesting a View inside a Text breaks text
 * wrapping, and working around that is the bulk of what a *block* renderer has
 * to deal with (#822). An inline-only subset never has the problem.
 */
function renderNodes(nodes: InlineNode[], linkColor: string, keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;

    switch (node.type) {
      case 'text':
        return <Text key={key}>{node.value}</Text>;
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'code':
        return (
          <Text key={key} style={styles.code}>
            {node.value}
          </Text>
        );
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {renderNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {renderNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={styles.del}>
            {renderNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
      case 'link':
        return (
          <Text
            key={key}
            style={[styles.link, { color: linkColor }]}
            onPress={() => void openUrl(node.href)}
            suppressHighlighting
          >
            {renderNodes(node.children, linkColor, `${key}.`)}
          </Text>
        );
    }
  });
}

function InlineMarkdown({ text, style, testID }: InlineMarkdownProps) {
  const { colors } = useTheme();
  const nodes = useMemo(() => inlineMarkdownNodes(text), [text]);

  return (
    <Text style={style} testID={testID}>
      {renderNodes(nodes, colors.primary, '')}
    </Text>
  );
}

const styles = StyleSheet.create({
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

export default memo(InlineMarkdown);
