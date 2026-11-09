import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSQLiteContext } from 'expo-sqlite';
import type { PublicLink } from '@jot/shared';
import { jot } from '../api/jot';
import { assertSwitchWriteAllowed } from '../api/client';
import { isNotePendingCreate, setLocalNotePublicLink } from '../db/noteQueries';
import { LocalizedError } from '../i18n/utils';
import { noteLocalQueryKey } from './queryKeys';

/**
 * Create, re-time and revoke a note's public link. These are online-only
 * one-shot requests (#1135): they never go through the sync queue, so the
 * caller only offers them while a write may reach the server, and a failure is
 * reported rather than retried. On success the cached note takes the server's
 * answer, so the share screen (which reads it) shows the new state.
 */
export function usePublicLinkActions(noteId: string) {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  // The server has already applied the change, so a failed cache write must
  // not read as a failed request; the next fetch of the note corrects it.
  const applyLocally = useCallback(async (link: PublicLink | null) => {
    try {
      await setLocalNotePublicLink(db, noteId, link);
    } catch {
      // No error detail: the bound values include the link's token, which
      // diagnostics logs must never carry.
      console.warn(`Failed to cache the public link of note id=${noteId}`);
    }
    await queryClient.invalidateQueries({ queryKey: noteLocalQueryKey(noteId) });
  }, [db, noteId, queryClient]);

  /** Creates a link, or moves only the expiry of the active one (same URL). */
  const setLink = useCallback(async (expiresAt: string | null) => {
    assertSwitchWriteAllowed();
    // The server doesn't know a note whose queued create hasn't drained yet.
    if (await isNotePendingCreate(db, noteId)) {
      throw new LocalizedError('publicLink.notSynced', 'Note not synced yet');
    }
    await applyLocally(await jot.notes.setPublicLink(noteId, { expires_at: expiresAt }));
  }, [applyLocally, db, noteId]);

  /** Revokes the link for everyone who has it. */
  const revoke = useCallback(async () => {
    assertSwitchWriteAllowed();
    await jot.notes.deletePublicLink(noteId);
    await applyLocally(null);
  }, [applyLocally, noteId]);

  return { setLink, revoke };
}
