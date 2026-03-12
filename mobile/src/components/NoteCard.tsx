import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Note } from '../types';

interface Props {
  note: Note;
  onPress: () => void;
  onLongPress: () => void;
}

export default function NoteCard({ note, onPress, onLongPress }: Props) {
  const previewText = note.note_type === 'todo'
    ? note.items?.slice(0, 3).map((i) => `${i.completed ? '✓' : '○'} ${i.text}`).join('\n')
    : note.content;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: note.color }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={note.title || 'Untitled note'}
      delayLongPress={400}
    >
      {note.pinned && (
        <Ionicons name="pin" size={14} color="#666" style={styles.pinIcon} />
      )}
      {note.title ? (
        <Text style={styles.title} numberOfLines={2} allowFontScaling>
          {note.title}
        </Text>
      ) : null}
      {previewText ? (
        <Text style={styles.preview} numberOfLines={5} allowFontScaling>
          {previewText}
        </Text>
      ) : null}
      {note.labels && note.labels.length > 0 && (
        <View style={styles.labels}>
          {note.labels.slice(0, 3).map((label) => (
            <View key={label.id} style={styles.labelChip}>
              <Text style={styles.labelText} allowFontScaling>{label.name}</Text>
            </View>
          ))}
        </View>
      )}
      {note.is_shared && (
        <View style={styles.sharedIndicator}>
          <Ionicons name="people-outline" size={14} color="#666" />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 12,
    margin: 6,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  pinIcon: { position: 'absolute', top: 8, right: 8 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4, color: '#202124' },
  preview: { fontSize: 14, color: '#5f6368', lineHeight: 20 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 4 },
  labelChip: {
    backgroundColor: 'rgba(0,0,0,0.08)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  labelText: { fontSize: 12, color: '#5f6368' },
  sharedIndicator: { marginTop: 8, alignSelf: 'flex-end' },
});
