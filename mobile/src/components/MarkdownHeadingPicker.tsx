import React from 'react';
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import type { HeadingLevel } from '../utils/markdownFormatting';

interface MarkdownHeadingPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (level: HeadingLevel) => void;
}

const HEADING_OPTIONS = [
  { level: 1 as const, label: 'Heading 1' },
  { level: 2 as const, label: 'Heading 2' },
  { level: 3 as const, label: 'Heading 3' },
  { level: 4 as const, label: 'Heading 4' },
];

export default function MarkdownHeadingPicker({
  visible,
  onClose,
  onSelect,
}: MarkdownHeadingPickerProps) {
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <SafeAreaView style={[styles.sheet, { backgroundColor: colors.sheetBackground }]}>
          <Pressable onPress={() => {}}>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            <Text style={[styles.title, { color: colors.text }]}>Heading level</Text>
            {HEADING_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.level}
                style={[styles.option, { borderBottomColor: colors.borderLight }]}
                onPress={() => {
                  onSelect(option.level);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={option.label}
              >
                <Text style={[styles.optionPrefix, { color: colors.primary }]}>
                  {'#'.repeat(option.level)}
                </Text>
                <Text style={[styles.optionLabel, { color: colors.text }]}>{option.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  handle: {
    alignSelf: 'center',
    borderRadius: 2.5,
    height: 5,
    marginBottom: 16,
    width: 40,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  option: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 14,
  },
  optionPrefix: {
    fontSize: 16,
    fontWeight: '700',
    width: 34,
  },
  optionLabel: {
    fontSize: 15,
  },
});
