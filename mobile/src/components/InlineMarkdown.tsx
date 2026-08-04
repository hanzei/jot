import React, { memo, useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { inlineMarkdownNodes } from '../utils/inlineMarkdown';
import { renderInlineNodes } from './inlineNodes';

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
 * The subset is inline-only (docs/specs/markdown-rendering.md §2.1), so this is
 * the whole renderer — the leaf rendering lives in inlineNodes.tsx, which the
 * text-note renderers share.
 */
function InlineMarkdown({ text, style, testID }: InlineMarkdownProps) {
  const { colors } = useTheme();
  const nodes = useMemo(() => inlineMarkdownNodes(text), [text]);

  return (
    <Text style={style} testID={testID}>
      {renderInlineNodes(nodes, colors.primary)}
    </Text>
  );
}

export default memo(InlineMarkdown);
