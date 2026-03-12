import React from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const COLORS = [
  '#ffffff',
  '#f28b82',
  '#fbbc04',
  '#fff475',
  '#ccff90',
  '#a8f0c6',
  '#cbf0f8',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
  '#e6c9a8',
  '#e8eaed',
];

interface Props {
  currentColor: string;
  onSelect: (color: string) => void;
}

export default function ColorPicker({ currentColor, onSelect }: Props) {
  return (
    <ScrollView
      horizontal
      style={styles.container}
      contentContainerStyle={styles.content}
      showsHorizontalScrollIndicator={false}
    >
      {COLORS.map((color) => (
        <TouchableOpacity
          key={color}
          style={[styles.circle, { backgroundColor: color }]}
          onPress={() => onSelect(color)}
          accessibilityRole="button"
          accessibilityLabel={`Select color ${color}`}
          accessibilityState={{ selected: currentColor === color }}
        >
          {currentColor === color && (
            <Ionicons name="checkmark" size={18} color={color === '#ffffff' ? '#333' : '#333'} />
          )}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  content: { padding: 12, gap: 8, flexDirection: 'row' },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
