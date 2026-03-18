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
import { NOTE_COLORS, LIGHT_NOTE_COLORS } from '@jot/shared';

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
              {NOTE_COLORS.map((color) => (
                <TouchableOpacity
                  key={color}
                  style={[
                    styles.colorCircle,
                    { backgroundColor: color },
                    LIGHT_NOTE_COLORS.has(color) && { borderWidth: 1, borderColor: colors.border },
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
                      color={LIGHT_NOTE_COLORS.has(color) ? '#666' : '#333'}
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
    width: 40,
    height: 5,
    borderRadius: 2.5,
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
    gap: 10,
  },
  colorCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
