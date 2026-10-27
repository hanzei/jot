import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { ArrowLeft, CircleAlert, CloudOff, History, Square, SquareCheck } from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import axios from 'axios';
import { userDisplayName, type NoteRevision, type NoteRevisionSummary } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/ThemeContext';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../store/AuthContext';
import { useUsers } from '../store/UsersContext';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import {
  UnsyncedNoteError,
  useHistoryAvailable,
  useNoteHistorySyncState,
  useNoteRevision,
  useNoteRevisions,
  useRestoreNoteRevision,
} from '../hooks/useNoteRevisions';
import { getCurrentLocale } from '../i18n/utils';
import Markdown from '../components/Markdown';
import InlineMarkdown from '../components/InlineMarkdown';

type HistoryRoute = RouteProp<RootStackParamList, 'NoteHistory'>;

function formatEditedAt(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleString(getCurrentLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Read-only history of a note, opened from the editor's overflow menu: the
 * revisions the server kept, a preview of one, and Restore. Online-only — the
 * revisions are fetched on demand and never stored locally — so it explains
 * itself instead of loading while the server is unusable.
 */
export default function NoteHistoryScreen() {
  const navigation = useNavigation();
  const { noteId } = useRoute<HistoryRoute>().params;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const { user: currentUser } = useAuth();
  const { usersById } = useUsers();

  const available = useHistoryAvailable();
  const { data: note } = useOfflineNote(noteId);
  const syncState = useNoteHistorySyncState(noteId);
  const notCreated = syncState.data === 'notCreated';
  const revisions = useNoteRevisions(noteId, available && syncState.data !== undefined && !notCreated);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useNoteRevision(noteId, selectedId, available);
  const restore = useRestoreNoteRevision();
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const authorName = useCallback((actorId: string | null): string | null => {
    if (!actorId) return null;
    if (actorId === currentUser?.id) return t('history.you');
    const user = usersById.get(actorId);
    return user ? userDisplayName(user) : t('history.unknownUser');
  }, [currentUser?.id, t, usersById]);

  const describe = useCallback((rev: NoteRevisionSummary): string => {
    const date = formatEditedAt(rev.edited_at);
    const name = authorName(rev.actor_id);
    return name ? t('history.editedBy', { date, name }) : date;
  }, [authorName, t]);

  const handleBack = useCallback(() => {
    if (selectedId) {
      setSelectedId(null);
      setRestoreError(null);
      return;
    }
    navigation.goBack();
  }, [navigation, selectedId]);

  // The hardware back button and the modal swipe-down step back from a
  // preview to the list too, like the header arrow. Leaving after a restore
  // happens with the preview still open, so that one is let through.
  const restorePending = restore.isPending;
  const restoreSucceeded = restore.isSuccess;
  useEffect(() => {
    if (!selectedId || restorePending || restoreSucceeded) return undefined;
    return navigation.addListener('beforeRemove', (e) => {
      e.preventDefault();
      setSelectedId(null);
      setRestoreError(null);
    });
  }, [navigation, restorePending, restoreSucceeded, selectedId]);

  const handleRestore = useCallback(async (rev: NoteRevision) => {
    let message = t('history.restoreConfirmMessage');
    if (note && note.note_type !== rev.note_type) {
      message += ' ' + (rev.note_type === 'list' ? t('history.restoreConfirmBecomesList') : t('history.restoreConfirmBecomesText'));
    }
    const confirmed = await confirm({
      title: t('history.restoreConfirmTitle'),
      message,
      confirmLabel: t('history.restore'),
    });
    if (!confirmed) return;

    setRestoreError(null);
    try {
      await restore.mutateAsync({ noteId, revisionId: rev.id });
      showToast(t('history.restored'), 'success');
      navigation.goBack();
    } catch (err) {
      if (err instanceof UnsyncedNoteError) {
        void syncState.refetch();
        setRestoreError('history.unsynced');
      } else if (axios.isAxiosError(err) && err.response?.status === 409) {
        // The note moved on since this screen read it: refresh the list so the
        // newest revision (the content that won) is there to look at.
        setRestoreError('history.restoreConflict');
        void revisions.refetch();
      } else {
        console.warn('Failed to restore note revision');
        setRestoreError('history.restoreFailed');
      }
    }
  }, [confirm, navigation, note, noteId, restore, revisions, showToast, syncState, t]);

  const renderRevision = useCallback(({ item }: { item: NoteRevisionSummary }) => {
    const label = describe(item);
    return (
      <TouchableOpacity
        style={[styles.row, { backgroundColor: colors.cardBackground, borderColor: colors.cardBorder }]}
        onPress={() => { setRestoreError(null); setSelectedId(item.id); }}
        testID={`history-revision-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('history.revisionLabel', { description: label })}
      >
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>{label}</Text>
        <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
          {item.note_type === 'list' ? t('note.typeList') : t('note.typeText')}
          {item.title ? ` · ${item.title}` : ''}
        </Text>
      </TouchableOpacity>
    );
  }, [colors, describe, t]);

  const centered = (icon: React.ReactNode, title: string, subtitle: string | null, testID: string, action?: React.ReactNode) => (
    <View style={styles.empty} testID={testID}>
      {icon}
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      {subtitle ? <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>{subtitle}</Text> : null}
      {action}
    </View>
  );

  const retryButton = (onPress: () => void, testID: string) => (
    <TouchableOpacity
      style={[styles.retryButton, { backgroundColor: colors.primary }]}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('common.retry')}
    >
      <Text style={styles.buttonText}>{t('common.retry')}</Text>
    </TouchableOpacity>
  );

  const preview = useMemo(() => {
    const rev = selected.data;
    if (!rev) return null;
    if (rev.note_type === 'text') {
      return rev.content
        ? <Markdown content={rev.content} />
        : <Text style={{ color: colors.textMuted }}>{t('history.emptyVersion')}</Text>;
    }
    return (
      <View>
        {rev.title ? <Text style={[styles.previewTitle, { color: colors.text }]}>{rev.title}</Text> : null}
        {rev.items.length === 0 && <Text style={{ color: colors.textMuted }}>{t('history.emptyVersion')}</Text>}
        {rev.items.map((item) => {
          const Icon = item.completed ? SquareCheck : Square;
          return (
            <View key={item.id} style={[styles.previewItem, item.parent_id ? styles.previewItemNested : null]}>
              <Icon size={18} color={colors.iconMuted} />
              <InlineMarkdown
                text={item.text}
                style={[
                  styles.previewItemText,
                  { color: item.completed ? colors.textMuted : colors.text },
                  item.completed && styles.completedText,
                ]}
              />
            </View>
          );
        })}
      </View>
    );
  }, [colors, selected.data, t]);

  let body: React.ReactNode;
  if (notCreated) {
    body = centered(<History size={64} color={colors.handleColor} />, t('history.notCreated'), null, 'history-not-created');
  } else if (!available && !(selectedId && selected.data)) {
    body = centered(<CloudOff size={64} color={colors.handleColor} />, t('history.offline'), null, 'history-offline');
  } else if (selectedId) {
    if (selected.isError) {
      body = centered(<CircleAlert size={64} color={colors.handleColor} />, t('history.loadError'), null, 'history-preview-error',
        retryButton(() => { void selected.refetch(); }, 'history-preview-retry'));
    } else if (!selected.data) {
      body = <ActivityIndicator size="large" color={colors.primary} style={styles.spinner} testID="history-preview-loading" />;
    } else {
      const rev = selected.data;
      const unsynced = syncState.data === 'unsynced';
      const restoring = restore.isPending;
      const disabled = restoring || !available || syncState.data !== 'synced';
      const hint = !available ? 'history.restoreOffline' : unsynced ? 'history.unsynced' : null;
      body = (
        <View style={styles.flex}>
          <ScrollView contentContainerStyle={styles.previewContent} testID="history-preview">
            <Text style={[styles.previewMeta, { color: colors.textSecondary }]}>{describe(rev)}</Text>
            {preview}
            {note?.images && note.images.length > 0 ? (
              <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('history.imagesNotIncluded')}</Text>
            ) : null}
          </ScrollView>
          <View style={[styles.footer, { borderTopColor: colors.borderLight, paddingBottom: insets.bottom + 12 }]}>
            {hint && (
              <Text style={[styles.footnote, { color: colors.textMuted }]} testID="history-restore-hint">{t(hint)}</Text>
            )}
            {restoreError && (
              <Text style={[styles.footnote, { color: colors.error }]} testID="history-restore-error">{t(restoreError)}</Text>
            )}
            <TouchableOpacity
              style={[styles.restoreButton, { backgroundColor: colors.primary }, disabled && styles.disabled]}
              onPress={() => { void handleRestore(rev); }}
              disabled={disabled}
              testID="history-restore"
              accessibilityRole="button"
              accessibilityLabel={t('history.restore')}
              accessibilityState={{ disabled, busy: restoring }}
            >
              {restoring
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.buttonText}>{t('history.restore')}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      );
    }
  } else if (revisions.isError) {
    body = centered(<CircleAlert size={64} color={colors.handleColor} />, t('history.loadError'), null, 'history-error',
      retryButton(() => { void revisions.refetch(); }, 'history-retry'));
  } else if (!revisions.data) {
    body = <ActivityIndicator size="large" color={colors.primary} style={styles.spinner} testID="history-loading" />;
  } else if (revisions.data.length === 0) {
    body = centered(<History size={64} color={colors.handleColor} />, t('history.empty'), t('history.emptySubtext'), 'history-empty');
  } else {
    body = (
      <FlatList
        data={revisions.data}
        keyExtractor={(item) => item.id}
        renderItem={renderRevision}
        ListHeaderComponent={
          <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('history.intro')}</Text>
        }
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        testID="history-list"
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity
          onPress={handleBack}
          testID="history-back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('history.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 24,
  },
  spinner: {
    marginTop: 32,
  },
  intro: {
    fontSize: 13,
    lineHeight: 18,
    paddingTop: 16,
    paddingBottom: 4,
  },
  listContent: {
    paddingHorizontal: 16,
  },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 10,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 20,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  previewContent: {
    padding: 16,
    gap: 12,
  },
  previewMeta: {
    fontSize: 13,
  },
  previewTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  previewItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  previewItemNested: {
    marginLeft: 28,
  },
  previewItemText: {
    flex: 1,
    fontSize: 15,
  },
  completedText: {
    textDecorationLine: 'line-through',
  },
  footer: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  footnote: {
    fontSize: 13,
  },
  restoreButton: {
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.5,
  },
});
