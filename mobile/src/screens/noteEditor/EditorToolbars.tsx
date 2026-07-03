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
}

/**
 * Markdown formatting buttons (bold/italic/heading/bullet). Rendered inline on
 * Android and inside an InputAccessoryView on iOS — both wrap this same content,
 * so the buttons stay identical across platforms.
 */
export function MarkdownToolbarContent({ onBold, onItalic, onHeading, onBullet }: MarkdownToolbarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceVariant, borderTopColor: colors.border }]}>
      <TouchableOpacity onPress={onBold} style={styles.fmtBtn} accessibilityLabel={t('note.formatBold')}>
        <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onItalic} style={styles.fmtBtn} accessibilityLabel={t('note.formatItalic')}>
        <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
      </TouchableOpacity>
      <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
      <TouchableOpacity onPress={onHeading} style={styles.fmtBtn} accessibilityLabel={t('note.formatHeading')}>
        <Text style={[styles.fmtBtnText, { color: colors.text }]}>H₂</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onBullet} style={styles.fmtBtn} accessibilityLabel={t('note.formatBulletList')}>
        <Text style={[styles.fmtBtnText, { color: colors.text }]}>• list</Text>
      </TouchableOpacity>
    </View>
  );
}

