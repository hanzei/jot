import { useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import {
  renameLabelInLocalNotes,
  deleteLabelFromLocalNotes,
  addLabelToLocalNote,
  removeLabelFromLocalNote,
  getStoredLabels,
  upsertLabel,
  renameStoredLabel,
  deleteStoredLabel,
  getLocalLabelCounts,
  requireLocalNote,
  generateClientLabelId,
} from '../db/noteQueries';
import { enqueueWrite, saveServerLabels, type EnqueueParams } from '../db/syncQueue';
import { labelKey, noteKey } from '../db/queueKeys';
import { isClosedDatabaseError } from '../db/errors';
import { useNetworkStatus } from './useNetworkStatus';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import { subscribeToReconnectResync } from '../store/resyncEvents';
import { useAuth } from '../store/AuthContext';
import { isLocalModeActive } from '../store/localMode';
import { isServerSwitchInProgress } from '../api/client';
import { LocalizedError } from '../i18n/utils';
import { apiPaths, type AddLabelRequest, type Label, type LabelWithCount, type RenameLabelRequest } from '@jot/shared';
import {
  labelsQueryKey,
  noteLocalQueryKey,
  noteLocalQueryScopeKey,
  notesLocalQueryScopeKey,
} from './queryKeys';
import { jot } from '../api/jot';

function assertSwitchWriteAllowed(): void {
  if (isServerSwitchInProgress()) {
    throw new LocalizedError('common.serverSwitchInProgress', 'Server switch in progress; write blocked');
  }
}

function useBackgroundSyncQuery<T>(
  getQueryKey: () => unknown[],
  localFn: () => Promise<T>,
  serverFn: () => Promise<T>,
) {
  const queryClient = useQueryClient();
  const { isConnected } = useNetworkStatus();
  // Both readers here outlive the render that registered them: retrySync polls
  // this between backoff attempts, and the reconnect subscription is
  // registered once. A plain closure would pin them to the connectivity of one
  // past render.
  const isConnectedRef = useRef(isConnected);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isConnectedRef.current = isConnected;
  // Re-entrancy guard: skip a resync while one is already running so the online
  // effect and the SSE-reconnect subscription can't start duplicate refreshes
  // (Sync Loop Safety), mirroring useOfflineNotes.
  const isSyncingRef = useRef(false);

  const query = useQuery<T>({
    queryKey: getQueryKey(),
    queryFn: localFn,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const syncFromServer = useCallback(async (canceller: SyncCanceller) => {
    // Local mode has no server to read from; keep the local cache and skip the
    // background resync entirely (issue #514).
    if (isLocalModeActive()) return;
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    const key = getQueryKey();
    try {
      const data = await retrySync(serverFn, {
        isConnected: () => isConnectedRef.current,
        canceller,
      });
      if (!canceller.cancelled) queryClient.setQueryData(key, data);
    } catch (err) {
      // Cancelled or offline: expected; keep the local cache.
      if (err instanceof SyncAbortedError) return;
      // The SQLiteProvider was torn down mid-sync and the persist hit a closed
      // handle; a fresh provider instance drives the next sync (issue #971).
      if (isClosedDatabaseError(err)) return;
      // Retries exhausted (or a permanent error): local cache remains.
      console.warn('Background sync failed after retries:', err);
    } finally {
      isSyncingRef.current = false;
    }
  }, [queryClient, getQueryKey, serverFn]);

  useEffect(() => {
    if (!isConnected || isLocalModeActive()) return;
    const canceller = new SyncCanceller();
    syncFromServer(canceller);
    return () => { canceller.cancel(); };
  }, [isConnected, syncFromServer]);

  // Catch up on SSE reconnect: a label created/renamed/deleted on another device
  // while the stream was down (e.g. app backgrounded) never arrives as a live
  // event, and a bare foreground doesn't flip isConnected to re-run the effect
  // above, so re-pull the label list/counts here.
  useEffect(() => {
    return subscribeToReconnectResync(() => {
      if (!isConnectedRef.current || isLocalModeActive()) return;
      const canceller = new SyncCanceller();
      syncFromServer(canceller);
    });
  }, [syncFromServer]);

  return query;
}

export function useLabels() {
  const db = useSQLiteContext();
  // The list is canonical in the local `labels` store; background sync fetches the
  // server's labels and reconciles the store (pruning stale, upserting current)
  // before returning them (issue #691). Memoized so useBackgroundSyncQuery's effect
  // (which depends on the fns) doesn't re-run — and re-fetch — on every render.
  //
  // Each item carries `note_count`. Offline it is derived from the notes table
  // (getLocalLabelCounts); the server's count replaces it once the sync lands, since
  // the local cache may not hold every note.
  const localFn = useCallback(async (): Promise<LabelWithCount[]> => {
    const [labels, counts] = await Promise.all([getStoredLabels(db), getLocalLabelCounts(db)]);
    return labels.map((label) => ({ ...label, note_count: counts[label.id] ?? 0 }));
  }, [db]);
  // Returns the store as reconciled, not the raw server list: a label with a
  // queued create, rename or delete keeps its local state (saveServerLabels),
  // and the list shows what was saved.
  const serverFn = useCallback(async (): Promise<LabelWithCount[]> => {
    const labels = await jot.labels.getAll();
    await saveServerLabels(db, labels);
    const serverCounts = new Map(labels.map((label) => [label.id, label.note_count]));
    return (await localFn()).map((label) => ({ ...label, note_count: serverCounts.get(label.id) ?? label.note_count }));
  }, [db, localFn]);
  return useBackgroundSyncQuery(labelsQueryKey, localFn, serverFn);
}

/** Build a locally-created label, with the client id its queued create sends (#546). */
export function buildLocalLabel(name: string, userId: string): Label {
  const now = new Date().toISOString();
  return {
    id: generateClientLabelId(),
    user_id: userId,
    name,
    created_at: now,
    updated_at: now,
  };
}

/** The queued create for a locally-created label: its client id is the server id (#546). */
function createLabelOp(label: Label): EnqueueParams {
  return {
    operation: 'createLabel',
    endpoint: apiPaths.labels,
    method: 'POST',
    keys: [labelKey(label.id)],
    body: { id: label.id, name: label.name } satisfies AddLabelRequest,
  };
}

/**
 * Resolves a label name for a write that attaches it to a note: the
 * locally-known label with that name, or a newly-minted one, stored so the
 * drawer shows it, whose `create` op the caller queues ahead of its own so
 * any later op referencing it reconciles to the server id. Matches
 * case-insensitively to mirror the server's GetOrCreateLabel lookup. `name`
 * must already be trimmed. Runs inside the caller's outbox transaction.
 */
export async function resolveLocalLabel(
  db: SQLiteDatabase,
  name: string,
  userId: string,
): Promise<{ label: Label; create: EnqueueParams | null }> {
  const normalized = name.toLowerCase();
  const known = (await getStoredLabels(db)).find((l) => l.name.toLowerCase() === normalized);
  if (known) return { label: known, create: null };
  const label = buildLocalLabel(name, userId);
  await upsertLabel(db, label);
  return { label, create: createLabelOp(label) };
}

/** Invalidates every read a label write can change: the label list and the notes that carry labels. */
function invalidateLabelReads(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
  queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
  queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
}

// Every label write goes through the outbox (#1285): the local edit and its
// queue row commit together, and the drain sends it. A label created here
// carries a server-valid client id (#546), so a later rename, delete or
// attach queues behind its create (FIFO per `label:` key) and needs no remap.

export function useCreateLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ name }: { name: string }): Promise<Label> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new LocalizedError('labels.nameRequired', 'Label name must not be empty');
      // Get-or-create by name, as the server's POST /labels is: a name the
      // device already knows returns that label and queues nothing, rather
      // than listing a second label until the drain merges them. A new one is
      // stored so an empty label shows in the drawer regardless of note state
      // (#691); a replay of a create that already landed gets a 409, which the
      // drain resolves by name (#1278).
      const { label } = await enqueueWrite(db, {
        localApply: () => resolveLocalLabel(db, trimmed, user?.id ?? ''),
        op: ({ create }) => (create ? [create] : []),
      });
      return label;
    },
    onSuccess: () => invalidateLabelReads(queryClient),
  });
}

export function useAddLabelToNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ noteId, name }: { noteId: string; name: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new LocalizedError('labels.nameRequired', 'Label name must not be empty');
      // The server resolves the label by name; a label new to this device is
      // created first, in the same transaction.
      await enqueueWrite(db, {
        localApply: async () => {
          await requireLocalNote(db, noteId);
          const resolved = await resolveLocalLabel(db, trimmed, user?.id ?? '');
          await addLabelToLocalNote(db, noteId, resolved.label);
          return resolved;
        },
        op: ({ label, create }) => [
          ...(create ? [create] : []),
          {
            operation: 'addLabelToNote',
            endpoint: apiPaths.noteLabels(noteId),
            method: 'POST',
            keys: [noteKey(noteId), labelKey(label.id)],
            body: { name: trimmed } satisfies AddLabelRequest,
          },
        ],
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      // A new label name may have been created.
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
    },
  });
}

export function useRemoveLabelFromNote() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ noteId, labelId }: { noteId: string; labelId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: async () => {
          await requireLocalNote(db, noteId);
          await removeLabelFromLocalNote(db, noteId, labelId);
        },
        op: () => ({
          operation: 'removeLabelFromNote',
          endpoint: apiPaths.noteLabel(noteId, labelId),
          method: 'DELETE',
          keys: [noteKey(noteId), labelKey(labelId)],
        }),
      });
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
      queryClient.invalidateQueries({ queryKey: labelsQueryKey() });
    },
  });
}

export function useRenameLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ labelId, name }: { labelId: string; name: string }): Promise<Label> => {
      assertSwitchWriteAllowed();
      const trimmed = name.trim();
      if (!trimmed) throw new LocalizedError('labels.nameRequired', 'Label name must not be empty');
      await enqueueWrite(db, {
        localApply: async () => {
          // The server rejects a name another label has (case-insensitively).
          // The rename is sent later, so catch that here, where the user can
          // still pick another name, rather than as a failed change.
          const folded = trimmed.toLowerCase();
          if ((await getStoredLabels(db)).some((l) => l.id !== labelId && l.name.toLowerCase() === folded)) {
            throw new LocalizedError('labels.nameTaken', 'A label with this name already exists');
          }
          await renameStoredLabel(db, labelId, trimmed);
          await renameLabelInLocalNotes(db, labelId, trimmed);
        },
        op: () => ({
          operation: 'renameLabel',
          endpoint: apiPaths.label(labelId),
          method: 'PATCH',
          keys: [labelKey(labelId)],
          body: { name: trimmed } satisfies RenameLabelRequest,
        }),
      });
      const now = new Date().toISOString();
      return { id: labelId, user_id: user?.id ?? '', name: trimmed, created_at: now, updated_at: now };
    },
    onSuccess: () => invalidateLabelReads(queryClient),
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  const db = useSQLiteContext();

  return useMutation({
    mutationFn: async ({ labelId }: { labelId: string }): Promise<void> => {
      assertSwitchWriteAllowed();
      await enqueueWrite(db, {
        localApply: async () => {
          await deleteStoredLabel(db, labelId);
          await deleteLabelFromLocalNotes(db, labelId);
        },
        op: () => ({
          operation: 'deleteLabel',
          endpoint: apiPaths.label(labelId),
          method: 'DELETE',
          keys: [labelKey(labelId)],
        }),
      });
    },
    onSuccess: () => invalidateLabelReads(queryClient),
  });
}
