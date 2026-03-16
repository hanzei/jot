import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme/ThemeContext';

export const COLOR_PALETTE = [
  '#ffffff', '#f28b82', '#fbbc04', '#fff475', '#ccff90',
  '#a7ffeb', '#cbf0f8', '#aecbfa', '#d7aefb', '#fdcfe8',
  '#e6c9a8', '#e8eaed',
];

interface ColorPickerProps {
  visible: boolean;
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}

export default function ColorPicker({ visible, currentColor, onSelect, onClose }: ColorPickerProps) {
  const { colors } = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <SafeAreaView style={[styles.sheet, { backgroundColor: colors.sheetBackground }]}>
          <Pressable>
            <View style={[styles.handle, { backgroundColor: colors.handleColor }]} />
            <Text style={[styles.title, { color: colors.text }]}>Note color</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.palette}
            >
              {COLOR_PALETTE.map((color) => (
                <TouchableOpacity
                  key={color}
                  style={[
                    styles.colorCircle,
                    { backgroundColor: color },
                    color === '#ffffff' && { borderWidth: 1, borderColor: colors.border },
                  ]}
                  onPress={() => {
                    onSelect(color);
                    onClose();
                  }}
                  testID={`color-swatch-${color.replace('#', '')}`}
                  accessibilityLabel={`Select color ${color}`}
                >
                  {currentColor === color && (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      color={color === '#ffffff' ? '#999' : '#333'}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
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
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
  },
  palette: {
    paddingBottom: 8,
    gap: 12,
  },
  colorCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
