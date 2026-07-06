import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { ArrowLeft, CircleAlert, CircleCheck } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useSQLiteContext } from 'expo-sqlite';
import type { Note } from '@jot/shared';
import { useSyncFailures, syncFailureCauseKey } from '../hooks/useSyncFailures';
import type { DeadLetteredOperation } from '../db/syncQueue';
import { getLocalNote } from '../db/noteQueries';
import { useTheme } from '../theme/ThemeContext';
import { useConfirm } from '../hooks/useConfirm';

/** A short, human-friendly label for the note a failed change belongs to. */
function noteSnippet(note: Note | null | undefined, t: (k: string) => string): string {
  if (!note) return t('syncFailures.unknownNote');
  if (note.note_type === 'list') {
    if (note.title.trim()) return note.title.trim();
    const firstItem = note.items?.find((i) => i.text.trim());
    if (firstItem) return firstItem.text.trim();
    return t('syncFailures.untitledNote');
  }
  const content = note.content.trim();
  return content || t('syncFailures.untitledNote');
}

export default function SyncFailuresScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const db = useSQLiteContext();
  const { confirm } = useConfirm();

  const { deadLetters, isLoading, isError, refetch, keepMyVersion, discard } = useSyncFailures();
  // Local content of each affected note, for the "which note" context.
  const [notesById, setNotesById] = useState<Record<string, Note | null>>({});
  // Id of the dead-letter currently being resolved, to disable its actions.
  const [processingId, setProcessingId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ids = Array.from(
      new Set(deadLetters.map((dl) => dl.note_id).filter((id): id is string => !!id)),
    );
    void (async () => {
      const entries = await Promise.all(
        ids.map(async (id) => [id, await getLocalNote(db, id).catch(() => null)] as const),
      );
      if (!cancelled) {
        setNotesById(Object.fromEntries(entries));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, deadLetters]);

  const handleKeep = useCallback(
    async (dl: DeadLetteredOperation) => {
      setProcessingId(dl.id);
      try {
        await keepMyVersion(dl);
      } catch {
        Alert.alert(t('common.error'), t('syncFailures.keepFailed'));
      } finally {
        setProcessingId(null);
      }
    },
    [keepMyVersion, t],
  );

  const handleDiscard = useCallback(
    async (dl: DeadLetteredOperation) => {
      const confirmed = await confirm({
        title: t('syncFailures.discardTitle'),
        message: t('syncFailures.discardConfirm'),
        confirmLabel: t('syncFailures.discard'),
        destructive: true,
      });
      if (!confirmed) return;
      setProcessingId(dl.id);
      try {
        await discard(dl);
      } catch {
        Alert.alert(t('common.error'), t('syncFailures.discardFailed'));
      } finally {
        setProcessingId(null);
      }
    },
    [confirm, discard, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: DeadLetteredOperation }) => {
      // "Keep my version" forks the preserved note content, so it needs a single
      // affected note that still exists locally. Multi-note ops (note_id null) or
      // an already-removed note offer Discard only.
      const note = item.note_id ? notesById[item.note_id] : null;
      const canKeep = !!item.note_id && !!note;
      const isProcessing = processingId === item.id;

      return (
        <View
          style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.cardBorder }]}
          testID={`sync-failure-${item.id}`}
        >
          <Text style={[styles.noteTitle, { color: colors.text }]} numberOfLines={1}>
            {noteSnippet(note, t)}
          </Text>
          <Text style={[styles.cause, { color: colors.textSecondary }]}>
            {t(syncFailureCauseKey(item))}
          </Text>

          <View style={styles.actions}>
            {canKeep && (
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.primary }, isProcessing && styles.actionDisabled]}
                onPress={() => handleKeep(item)}
                disabled={isProcessing}
                testID={`sync-failure-keep-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={t('syncFailures.keep')}
              >
                {isProcessing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.keepText}>{t('syncFailures.keep')}</Text>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionButton, styles.discardButton, { borderColor: colors.error }, isProcessing && styles.actionDisabled]}
              onPress={() => handleDiscard(item)}
              disabled={isProcessing}
              testID={`sync-failure-discard-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('syncFailures.discard')}
            >
              <Text style={[styles.discardText, { color: colors.error }]}>{t('syncFailures.discard')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [colors, handleDiscard, handleKeep, notesById, processingId, t],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          testID="sync-failures-back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('syncFailures.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={colors.primary} style={styles.spinner} />
      ) : isError ? (
        <View style={styles.empty} testID="sync-failures-error">
          <CircleAlert size={64} color={colors.handleColor} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('syncFailures.loadError')}</Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: colors.primary }]}
            onPress={() => { void refetch(); }}
            testID="sync-failures-retry"
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
          >
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : deadLetters.length === 0 ? (
        <View style={styles.empty} testID="sync-failures-empty">
          <CircleCheck size={64} color={colors.handleColor} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('syncFailures.emptyTitle')}</Text>
          <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>{t('syncFailures.emptySubtext')}</Text>
        </View>
      ) : (
        <FlatList
          data={deadLetters}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ListHeaderComponent={
            <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('syncFailures.intro')}</Text>
          }
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          testID="sync-failures-list"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  listContent: {
    paddingHorizontal: 16,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  noteTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  cause: {
    fontSize: 13,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  actionButton: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discardButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  keepText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  discardText: {
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
