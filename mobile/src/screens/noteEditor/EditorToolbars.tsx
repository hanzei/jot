import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Bold, Heading, Italic, List, ListTodo, Strikethrough } from 'lucide-react-native';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';

interface MarkdownToolbarProps {
  onBold: () => void;
  onItalic: () => void;
  onStrikethrough: () => void;
  onHeading: () => void;
  onBullet: () => void;
  onCheckbox: () => void;
  backgroundColor: string;
  hasNoteColor: boolean;
}

const HIT_SLOP = { top: 8, right: 4, bottom: 8, left: 4 };
const ICON_SIZE = 20;

/**
 * Markdown formatting buttons. Rendered inline on Android and inside an
 * InputAccessoryView on iOS — both wrap this same content, so the buttons stay
 * identical across platforms.
 *
 * Icons rather than letter glyphs: it matches the action bar below, and it
 * keeps the buttons free of text that would otherwise need translating in
 * eight locales. The accessibility labels carry the meaning.
 *
 * backgroundColor/hasNoteColor mirror the action bar below it (noteBackground
 * and the transparent-border-on-colored-notes rule) so the two bars read as
 * one continuous surface instead of a mismatched seam.
 *
 * Every button is focusable={false}: on Android a focusable view takes input
 * focus from the content input when tapped, which hides the keyboard, and the
 * editor treats a hidden keyboard as "done editing" — so a single press on
 * Bold would tear down the very input it was meant to edit. TalkBack is
 * unaffected; accessibility focus is separate from input focus.
 */
export function MarkdownToolbarContent({ onBold, onItalic, onStrikethrough, onHeading, onBullet, onCheckbox, backgroundColor, hasNoteColor }: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.formattingToolbar, { backgroundColor, borderTopColor: hasNoteColor ? 'transparent' : colors.border }]}>
      <TouchableOpacity
        onPress={onBold}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatBold')}
        testID="format-bold-btn"
      >
        <Bold size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onItalic}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatItalic')}
        testID="format-italic-btn"
      >
        <Italic size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onStrikethrough}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatStrikethrough')}
        testID="format-strikethrough-btn"
      >
        <Strikethrough size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
      <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
      {/* Cycles ## -> ### -> none, so the icon deliberately names no level. */}
      <TouchableOpacity
        onPress={onHeading}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatHeading')}
        testID="format-heading-btn"
      >
        <Heading size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onBullet}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatBulletList')}
        testID="format-bullet-btn"
      >
        <List size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onCheckbox}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatChecklist')}
        testID="format-checkbox-btn"
      >
        <ListTodo size={ICON_SIZE} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}
