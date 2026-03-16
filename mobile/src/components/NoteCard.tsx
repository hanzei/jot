import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Note, NoteItem, NoteShare } from '../types';
import { useTheme } from '../theme/ThemeContext';
import UserAvatar from './UserAvatar';

interface NoteCardProps {
  note: Note;
  onPress: () => void;
  onLongPress?: () => void;
  onMenuPress?: () => void;
}

const MAX_PREVIEW_ITEMS = 10;
const MAX_AVATAR_DISPLAY = 3;

function ShareAvatars({ shares }: { shares: NoteShare[] }) {
  const visible = shares.slice(0, MAX_AVATAR_DISPLAY);
  const overflow = shares.length - MAX_AVATAR_DISPLAY;
  return (
    <View style={styles.avatarRow}>
      {visible.map((share, index) => (
        <View key={share.id} style={index === 0 ? styles.avatarFirst : styles.avatarWrapper}>
          <UserAvatar
            userId={share.shared_with_user_id}
            username={share.username ?? share.shared_with_user_id}
            hasProfileIcon={share.has_profile_icon}
            size="small"
          />
        </View>
      ))}
      {overflow > 0 && (
        <View style={styles.overflowBadge}>
          <Text style={styles.overflowText}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

function TodoPreview({ items, hasColor }: { items: NoteItem[]; hasColor?: boolean }) {
  const { colors } = useTheme();
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
          <Ionicons name="square-outline" size={14} color={hasColor ? '#999' : colors.iconMuted} />
          <Text style={[styles.todoText, { color: hasColor ? '#666' : colors.textSecondary }]} numberOfLines={1}>
            {item.text}
          </Text>
        </View>
      ))}
      {completedCount > 0 && (
        <Text style={[styles.completedCount, { color: hasColor ? '#999' : colors.textMuted }]}>+{completedCount} checked</Text>
      )}
    </View>
  );
}

function NoteCard({ note, onPress, onLongPress, onMenuPress }: NoteCardProps) {
  const { colors } = useTheme();
  const hasColor = note.color && note.color !== '#ffffff';

  return (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: colors.cardBackground, borderColor: colors.cardBorder },
        hasColor && { backgroundColor: note.color, borderColor: note.color },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
      testID={`note-card-${note.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderContent}>
          {note.title ? (
            <Text style={[styles.title, { color: hasColor ? '#1a1a1a' : colors.text }]} numberOfLines={1}>
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
            accessibilityRole="button"
          >
            <Ionicons name="ellipsis-vertical" size={18} color={hasColor ? '#999' : colors.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      {note.note_type === 'text' && note.content ? (
        <Text style={[styles.content, { color: hasColor ? '#666' : colors.textSecondary }]} numberOfLines={3}>
          {note.content}
        </Text>
      ) : null}

      {note.note_type === 'todo' && note.items && note.items.length > 0 ? (
        <TodoPreview items={note.items} hasColor={hasColor} />
      ) : null}

      <View style={styles.footer}>
        {note.labels && note.labels.length > 0 ? (
          <View style={styles.labels}>
            {note.labels.map((label) => (
              <View key={label.id} style={[styles.labelChip, { backgroundColor: hasColor ? 'rgba(0,0,0,0.08)' : colors.borderLight }]}>
                <Text style={[styles.labelText, { color: hasColor ? '#666' : colors.textSecondary }]}>{label.name}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {note.is_shared ? (
          <View style={styles.sharedWithYouRow}>
            <Ionicons name="people-outline" size={13} color={colors.primary} />
            <Text style={[styles.sharedWithYouText, { color: colors.primary }]}>Shared with you</Text>
          </View>
        ) : note.shared_with && note.shared_with.length > 0 ? (
          <ShareAvatars shares={note.shared_with} />
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
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
    marginBottom: 4,
  },
  content: {
    fontSize: 14,
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
    flex: 1,
  },
  completedCount: {
    fontSize: 12,
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
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  labelText: {
    fontSize: 11,
  },
  sharedWithYouRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sharedWithYouText: {
    fontSize: 11,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarFirst: {
    marginLeft: 0,
  },
  avatarWrapper: {
    marginLeft: -4,
  },
  overflowBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#e5e7eb',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -4,
  },
  overflowText: {
    fontSize: 9,
    color: '#666',
    fontWeight: '600',
  },
});

export default React.memo(NoteCard);
