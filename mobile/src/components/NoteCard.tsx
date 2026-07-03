import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { VALIDATION, type Note, type NoteItem, type User } from '@jot/shared';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../store/AuthContext';
import { useFailedNoteIds } from '../store/OfflineContext';
import { useUsers } from '../store/UsersContext';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import { noteImageThumbnailUrl } from '../api/images';
import UserAvatar from './UserAvatar';
import CachedNoteImage from './CachedNoteImage';
import { isWhiteHexColor } from '../utils/colorContrast';
import { stripMarkdownForPreview } from '../utils/markdownStyles';
import LinkText from './LinkText';

const CARD_RADIUS = 12;

interface NoteCardProps {
  note: Note;
  onPress: () => void;
  onLongPress?: () => void;
  onMenuPress?: () => void;
  onLabelPress?: (labelId: string, labelName: string) => void;
}

const MAX_PREVIEW_ITEMS = 10;
const MAX_AVATAR_DISPLAY = 3;

interface AvatarData {
  key: string;
  userId: string;
  username: string;
  hasProfileIcon?: boolean;
  iconVersion?: string;
}

function buildNoteAvatars(
  note: Note,
  currentUserId: string | undefined,
  usersById: Map<string, User>,
): AvatarData[] {
  const isOwner = note.user_id === currentUserId;
  const avatars: AvatarData[] = [];

  if (!isOwner) {
    const owner = usersById.get(note.user_id);
    avatars.push({
      key: 'owner',
      userId: note.user_id,
      username: owner?.username || '?',
      hasProfileIcon: owner?.has_profile_icon,
      iconVersion: owner?.updated_at,
    });
  }

  note.shared_with
    ?.filter(s => s.shared_with_user_id !== currentUserId)
    .forEach(s => {
      const u = usersById.get(s.shared_with_user_id);
      avatars.push({
        key: s.id,
        userId: s.shared_with_user_id,
        username: s.username || '?',
        hasProfileIcon: s.has_profile_icon ?? u?.has_profile_icon,
        iconVersion: u?.updated_at ?? s.updated_at,
      });
    });

  return avatars;
}

function NoteAvatars({ note }: { note: Note }) {
  const { user } = useAuth();
  const { usersById } = useUsers();
  const { colors } = useTheme();

  const avatars = buildNoteAvatars(note, user?.id, usersById);
  if (avatars.length === 0) return null;

  const visible = avatars.slice(0, MAX_AVATAR_DISPLAY);
  const overflow = avatars.length - MAX_AVATAR_DISPLAY;

  return (
    <View style={styles.avatarRow}>
      {visible.map((avatar, index) => (
        <View key={avatar.key} style={index === 0 ? styles.avatarFirst : styles.avatarWrapper}>
          <UserAvatar
            userId={avatar.userId}
            username={avatar.username}
            hasProfileIcon={avatar.hasProfileIcon}
            iconVersion={avatar.iconVersion}
            size="small"
          />
        </View>
      ))}
      {overflow > 0 && (
        <View style={[styles.overflowBadge, { backgroundColor: colors.border }]}>
          <Text style={[styles.overflowText, { color: colors.textSecondary }]}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

function ListPreview({ items, hasColor }: { items: NoteItem[]; hasColor?: boolean }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
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
    <View style={styles.listPreview}>
      {uncompleted.map((item) => {
        const indentLevel = item.parent_id ? 1 : 0;
        return (
          <View
            key={item.id}
            style={[styles.listRow, { marginLeft: indentLevel * VALIDATION.INDENT_PX_PER_LEVEL }]}
            testID={`note-card-list-row-${item.id}`}
          >
            <Ionicons name="square-outline" size={14} color={hasColor ? '#555' : colors.textSecondary} />
            <LinkText text={item.text} style={[styles.listText, { color: hasColor ? '#1a1a1a' : colors.text }]} />
          </View>
        );
      })}
      {completedCount > 0 && (
        <Text style={[styles.completedCount, { color: hasColor ? '#555' : colors.textSecondary }]}>
          {t('note.moreCompletedItems', { count: completedCount })}
        </Text>
      )}
    </View>
  );
}

function NoteCard({ note, onPress, onLongPress, onMenuPress, onLabelPress }: NoteCardProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const failedNoteIds = useFailedNoteIds();
  const didNotSync = failedNoteIds.has(note.id);
  const hasColor = !!(note.color && !isWhiteHexColor(note.color));
  const baseUrl = useActiveServerBaseUrl();
  const coverImage = note.images?.[0];
  const extraImageCount = (note.images?.length ?? 0) - 1;
  const textPreview = useMemo(
    () => note.note_type === 'text' && note.content ? stripMarkdownForPreview(note.content) : null,
    [note],
  );

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
      {coverImage && (
        <View style={styles.cover} testID={`note-card-cover-${note.id}`}>
          <CachedNoteImage
            imageId={coverImage.id}
            variant="thumbnail"
            networkUrl={noteImageThumbnailUrl(baseUrl, coverImage.id)}
            style={styles.coverImage}
            resizeMode="cover"
            accessibilityLabel={coverImage.filename}
            accessibilityIgnoresInvertColors
          />
          {extraImageCount > 0 && (
            <View style={styles.coverBadge} accessibilityLabel={t('images.moreImagesBadge', { count: extraImageCount })}>
              <Text style={styles.coverBadgeText}>+{extraImageCount}</Text>
            </View>
          )}
        </View>
      )}

      {didNotSync && (
        <View
          style={[styles.failedBadge, { backgroundColor: hasColor ? 'rgba(0,0,0,0.08)' : colors.warning }]}
          testID={`note-failed-badge-${note.id}`}
          accessibilityLabel={t('syncFailures.badge')}
        >
          <Ionicons name="alert-circle" size={13} color={hasColor ? '#a14b00' : colors.warningText} />
          <Text style={[styles.failedBadgeText, { color: hasColor ? '#a14b00' : colors.warningText }]}>
            {t('syncFailures.badge')}
          </Text>
        </View>
      )}

      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderContent}>
          {note.note_type === 'list' && note.title ? (
            <Text style={[styles.title, { color: hasColor ? '#1a1a1a' : colors.text }]} numberOfLines={1}>
              {note.title}
            </Text>
          ) : null}
          {textPreview ? (
            <Text
              style={[styles.contentText, { color: hasColor ? '#1a1a1a' : colors.text }]}
              numberOfLines={3}
            >
              {textPreview}
            </Text>
          ) : null}
        </View>
        {onMenuPress && (
          <TouchableOpacity
            onPress={onMenuPress}
            style={styles.menuButton}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            testID={`note-menu-${note.id}`}
            accessibilityLabel={t('note.menuOptions')}
            accessibilityRole="button"
          >
            <Ionicons name="ellipsis-vertical" size={18} color={hasColor ? '#999' : colors.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      {note.note_type === 'list' && note.items && note.items.length > 0 ? (
        <ListPreview items={note.items} hasColor={hasColor} />
      ) : null}

      <View style={styles.footer}>
        {note.labels && note.labels.length > 0 ? (
          <View style={styles.labels}>
            {note.labels.map((label) => (
              onLabelPress ? (
                <TouchableOpacity
                  key={label.id}
                  style={[styles.labelChip, { backgroundColor: hasColor ? 'rgba(0,0,0,0.08)' : colors.borderLight }]}
                  onPress={() => onLabelPress(label.id, label.name)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={t('note.filterByLabel', { label: label.name })}
                >
                  <Text style={[styles.labelText, { color: hasColor ? '#666' : colors.textSecondary }]}>{label.name}</Text>
                </TouchableOpacity>
              ) : (
                <View key={label.id} style={[styles.labelChip, { backgroundColor: hasColor ? 'rgba(0,0,0,0.08)' : colors.borderLight }]}>
                  <Text style={[styles.labelText, { color: hasColor ? '#666' : colors.textSecondary }]}>{label.name}</Text>
                </View>
              )
            ))}
          </View>
        ) : null}

        {(note.is_shared || (note.shared_with && note.shared_with.length > 0)) ? (
          <NoteAvatars note={note} />
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: CARD_RADIUS,
    padding: 12,
    // The masonry layout (both the single-column list and the two-column grid)
    // owns the spacing between cards, so the card itself carries no margins.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  cover: {
    marginHorizontal: -12,
    marginTop: -12,
    marginBottom: 8,
    height: 160,
    borderTopLeftRadius: CARD_RADIUS,
    borderTopRightRadius: CARD_RADIUS,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb',
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  coverBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  failedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginBottom: 6,
  },
  failedBadgeText: {
    fontSize: 11,
    fontWeight: '600',
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
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  contentText: {
    fontSize: 13,
    lineHeight: 18,
  },
  listPreview: {
    marginTop: 4,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: 1,
  },
  listText: {
    fontSize: 13,
    flex: 1,
    flexShrink: 1,
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
    gap: 6,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  labelChip: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  labelText: {
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
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -4,
  },
  overflowText: {
    fontSize: 9,
    fontWeight: '600',
  },
});

export default React.memo(NoteCard);
