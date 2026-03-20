import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import Markdown, { MarkdownIt, type ASTNode, type RenderRules } from 'react-native-markdown-display';
import { useTheme } from '../theme/ThemeContext';

interface NoteMarkdownProps {
  content: string;
  noteHasColor?: boolean;
  compact?: boolean;
  interactiveLinks?: boolean;
}

function getBaseTextColor(noteHasColor: boolean | undefined, isMuted: boolean, colors: ReturnType<typeof useTheme>['colors']) {
  if (noteHasColor) {
    return isMuted ? '#666' : '#1a1a1a';
  }

  return isMuted ? colors.textSecondary : colors.text;
}

export function prepareMarkdownForRender(content: string): string {
  return content
    .replace(/!\[([^\]]*)\]\((?:[^()]+|\([^()]*\))*\)/g, (_, alt: string) => alt || '')
    .replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[\s*(?:x|X)?\s*\]\s+/gm, '$1');
}

function createMarkdownStyles(options: {
  compact?: boolean;
  noteHasColor?: boolean;
  isDark: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { compact = false, noteHasColor, isDark, colors } = options;
  const textColor = getBaseTextColor(noteHasColor, false, colors);
  const mutedTextColor = getBaseTextColor(noteHasColor, true, colors);
  const codeBackground = noteHasColor
    ? 'rgba(0, 0, 0, 0.06)'
    : isDark
      ? 'rgba(255, 255, 255, 0.08)'
      : colors.surfaceVariant;
  const blockquoteBorder = noteHasColor ? 'rgba(0, 0, 0, 0.18)' : colors.border;
  const blockquoteBackground = noteHasColor
    ? 'rgba(255, 255, 255, 0.24)'
    : isDark
      ? 'rgba(255, 255, 255, 0.04)'
      : colors.surfaceVariant;
  const headingBaseSize = compact ? 14 : 24;
  const paragraphSpacing = compact ? 4 : 10;
  const listSpacing = compact ? 2 : 4;

  return StyleSheet.create({
    body: {
      color: textColor,
    },
    text: {
      color: textColor,
      fontSize: compact ? 14 : 16,
      lineHeight: compact ? 20 : 24,
    },
    paragraph: {
      marginTop: paragraphSpacing,
      marginBottom: paragraphSpacing,
      flexDirection: 'row',
      flexWrap: 'wrap',
      width: '100%',
    },
    heading1: {
      fontSize: compact ? 15 : headingBaseSize,
      lineHeight: compact ? 20 : 30,
      fontWeight: '700',
      marginTop: compact ? 4 : 12,
      marginBottom: compact ? 2 : 8,
    },
    heading2: {
      fontSize: compact ? 15 : headingBaseSize - 2,
      lineHeight: compact ? 20 : 28,
      fontWeight: '700',
      marginTop: compact ? 4 : 12,
      marginBottom: compact ? 2 : 8,
    },
    heading3: {
      fontSize: compact ? 14 : headingBaseSize - 4,
      lineHeight: compact ? 20 : 26,
      fontWeight: '700',
      marginTop: compact ? 4 : 10,
      marginBottom: compact ? 2 : 6,
    },
    heading4: {
      fontSize: compact ? 14 : headingBaseSize - 6,
      lineHeight: compact ? 20 : 24,
      fontWeight: '700',
      marginTop: compact ? 4 : 10,
      marginBottom: compact ? 2 : 6,
    },
    heading5: {
      fontSize: compact ? 14 : 16,
      lineHeight: compact ? 20 : 22,
      fontWeight: '700',
      marginTop: compact ? 4 : 10,
      marginBottom: compact ? 2 : 6,
    },
    heading6: {
      fontSize: compact ? 14 : 16,
      lineHeight: compact ? 20 : 22,
      fontWeight: '700',
      marginTop: compact ? 4 : 10,
      marginBottom: compact ? 2 : 6,
    },
    strong: {
      fontWeight: '700',
    },
    em: {
      fontStyle: 'italic',
    },
    s: {
      textDecorationLine: 'line-through',
    },
    bullet_list: {
      marginTop: listSpacing,
      marginBottom: listSpacing,
    },
    ordered_list: {
      marginTop: listSpacing,
      marginBottom: listSpacing,
    },
    list_item: {
      flexDirection: 'row',
      marginBottom: compact ? 2 : 4,
    },
    bullet_list_icon: {
      color: mutedTextColor,
      marginRight: 8,
      marginLeft: 0,
    },
    ordered_list_icon: {
      color: mutedTextColor,
      marginRight: 8,
      marginLeft: 0,
    },
    bullet_list_content: {
      flex: 1,
    },
    ordered_list_content: {
      flex: 1,
    },
    blockquote: {
      backgroundColor: blockquoteBackground,
      borderLeftColor: blockquoteBorder,
      borderLeftWidth: 3,
      borderRadius: 8,
      marginVertical: compact ? 4 : 8,
      paddingVertical: compact ? 6 : 8,
      paddingHorizontal: compact ? 10 : 12,
    },
    hr: {
      backgroundColor: noteHasColor ? 'rgba(0, 0, 0, 0.15)' : colors.border,
      height: StyleSheet.hairlineWidth,
      marginVertical: compact ? 8 : 12,
    },
    code_inline: {
      backgroundColor: codeBackground,
      borderWidth: 0,
      borderRadius: 6,
      color: textColor,
      fontSize: compact ? 13 : 14,
      lineHeight: compact ? 18 : 20,
      paddingHorizontal: 6,
      paddingVertical: 2,
      fontFamily: 'monospace',
    },
    code_block: {
      backgroundColor: codeBackground,
      borderWidth: 0,
      borderRadius: 8,
      color: textColor,
      fontSize: compact ? 13 : 14,
      lineHeight: compact ? 18 : 20,
      marginVertical: compact ? 4 : 8,
      overflow: 'hidden',
      padding: compact ? 10 : 12,
      fontFamily: 'monospace',
    },
    fence: {
      backgroundColor: codeBackground,
      borderWidth: 0,
      borderRadius: 8,
      color: textColor,
      fontSize: compact ? 13 : 14,
      lineHeight: compact ? 18 : 20,
      marginVertical: compact ? 4 : 8,
      overflow: 'hidden',
      padding: compact ? 10 : 12,
      fontFamily: 'monospace',
    },
    link: {
      color: colors.primary,
      textDecorationLine: 'underline',
    },
    imageAlt: {
      color: mutedTextColor,
      fontStyle: 'italic',
    },
    softbreak: {
      width: '100%',
      height: 0,
    },
  });
}

const markdownIt = MarkdownIt({ breaks: true });

function createRenderRules(): RenderRules {
  return {
    image: (node: ASTNode, _children, _parents, styles) => {
      const altText = node.attributes?.alt?.trim();
      if (!altText) {
        return null;
      }

      return (
        <Text key={node.key} style={styles.imageAlt}>
          {altText}
        </Text>
      );
    },
  };
}

const renderRules = createRenderRules();

export default function NoteMarkdown({
  content,
  noteHasColor,
  compact = false,
  interactiveLinks = false,
}: NoteMarkdownProps) {
  const { colors, isDark } = useTheme();
  const preparedContent = useMemo(() => prepareMarkdownForRender(content), [content]);
  const markdownStyles = useMemo(
    () => createMarkdownStyles({ compact, noteHasColor, isDark, colors }),
    [colors, compact, isDark, noteHasColor],
  );

  if (!preparedContent.trim()) {
    return null;
  }

  return (
    <Markdown
      markdownit={markdownIt}
      rules={renderRules}
      style={markdownStyles}
      onLinkPress={(url) => {
        if (!interactiveLinks) {
          return false;
        }

        Linking.openURL(url).catch(() => {});
        return false;
      }}
    >
      {preparedContent}
    </Markdown>
  );
}
