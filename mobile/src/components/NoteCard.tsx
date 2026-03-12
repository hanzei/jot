import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Note, NoteItem } from '../types';

interface NoteCardProps {
  note: Note;
  onPress: () => void;
  onLongPress?: () => void;
  onMenuPress?: () => void;
}

const MAX_PREVIEW_ITEMS = 4;

function TodoPreview({ items }: { items: NoteItem[] }) {
  const uncompleted: NoteItem[] = [];
  let completedCount = 0;
  for (const item of items) {
    if (item.completed) {
      completedCount++;
    } else if (uncompleted.length < MAX_PREVIEW_ITEMS) {
      uncompleted.push(item);
    }
  }

  return (
    <View style={styles.todoPreview}>
      {uncompleted.map((item) => (
        <View key={item.id} style={styles.todoRow}>
          <Ionicons name="square-outline" size={14} color="#999" />
          <Text style={styles.todoText} numberOfLines={1}>
            {item.text}
          </Text>
        </View>
      ))}
      {completedCount > 0 && (
        <Text style={styles.completedCount}>+{completedCount} checked</Text>
      )}
    </View>
  );
}

function NoteCard({ note, onPress, onLongPress, onMenuPress }: NoteCardProps) {
  const hasColor = note.color && note.color !== '#ffffff';
  const borderColor = hasColor ? note.color : '#e5e7eb';

  return (
    <TouchableOpacity
      style={[styles.card, { borderLeftColor: borderColor, borderLeftWidth: hasColor ? 4 : 1 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
      testID={`note-card-${note.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderContent}>
          {note.title ? (
            <Text style={styles.title} numberOfLines={1}>
              {note.title}
            </Text>
          ) : null}
        </View>
        {onMenuPress && (
          <TouchableOpacity
            onPress={onMenuPress}
            style={styles.menuButton}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID={`note-menu-${note.id}`}
            accessibilityLabel="Note menu"
          >
            <Ionicons name="ellipsis-vertical" size={18} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      {note.note_type === 'text' && note.content ? (
        <Text style={styles.content} numberOfLines={3}>
          {note.content}
        </Text>
      ) : null}

      {note.note_type === 'todo' && note.items && note.items.length > 0 ? (
        <TodoPreview items={note.items} />
      ) : null}

      <View style={styles.footer}>
        {note.labels && note.labels.length > 0 ? (
          <View style={styles.labels}>
            {note.labels.map((label) => (
              <View key={label.id} style={styles.labelChip}>
                <Text style={styles.labelText}>{label.name}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {note.is_shared || (note.shared_with && note.shared_with.length > 0) ? (
          <Ionicons name="people-outline" size={14} color="#999" style={styles.shareIcon} />
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cardHeaderContent: {
    flex: 1,
  },
  menuButton: {
    padding: 4,
    marginTop: -4,
    marginRight: -4,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  content: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  todoPreview: {
    marginTop: 4,
  },
  todoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 1,
  },
  todoText: {
    fontSize: 13,
    color: '#666',
    flex: 1,
  },
  completedCount: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    flexWrap: 'wrap',
    gap: 4,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    flex: 1,
  },
  labelChip: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  labelText: {
    fontSize: 11,
    color: '#666',
  },
  shareIcon: {
    marginLeft: 4,
  },
});

export default React.memo(NoteCard);
