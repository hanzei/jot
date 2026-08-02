import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { styles } from './styles';

interface MarkdownToolbarProps {
  onBold: () => void;
  onItalic: () => void;
  onHeading: () => void;
  onBullet: () => void;
  onCheckbox: () => void;
}

const HIT_SLOP = { top: 8, right: 4, bottom: 8, left: 4 };

/**
 * Markdown formatting buttons. Rendered inline on Android and inside an
 * InputAccessoryView on iOS — both wrap this same content, so the buttons stay
 * identical across platforms.
 *
 * Labels are glyphs rather than words so nothing here needs translating; the
 * accessibility labels carry the meaning.
 */
export function MarkdownToolbarContent({ onBold, onItalic, onHeading, onBullet, onCheckbox }: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceVariant, borderTopColor: colors.border }]}>
      <TouchableOpacity
        onPress={onBold}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatBold')}
        testID="format-bold-btn"
      >
        <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onItalic}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatItalic')}
        testID="format-italic-btn"
      >
        <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
      </TouchableOpacity>
      <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
      {/* Cycles ## -> ### -> none, so the label deliberately names no level. */}
      <TouchableOpacity
        onPress={onHeading}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatHeading')}
        testID="format-heading-btn"
      >
        <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>H</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onBullet}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatBulletList')}
        testID="format-bullet-btn"
      >
        <Text style={[styles.fmtBtnText, { color: colors.text }]}>•</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onCheckbox}
        style={styles.fmtBtn}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('note.formatChecklist')}
        testID="format-checkbox-btn"
      >
        <Text style={[styles.fmtBtnText, { color: colors.text }]}>☐</Text>
      </TouchableOpacity>
    </View>
  );
}
