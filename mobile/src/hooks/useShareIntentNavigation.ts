import { useEffect, useSyncExternalStore } from 'react';
import { useShareIntentContext } from 'expo-share-intent';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getActiveServerId, switchActiveServer } from '../api/client';
import { extractSharedText } from '../utils/shareIntent';
import { getPendingShare, setPendingShare, subscribePendingShare } from '../store/shareIntent';

export function usePendingShare() {
  return useSyncExternalStore(subscribePendingShare, getPendingShare, getPendingShare);
}

interface UseShareIntentNavigationParams {
  navigationRef: NavigationContainerRef<RootStackParamList>;
  isNavReady: boolean;
  isAuthenticated: boolean;
  revalidateSession: () => Promise<unknown> | void;
}

// useShareIntentNavigation wires Android share intents ("select text in another
// app → share to Jot") into the note editor. An incoming intent is stashed in
// the module-level store, then replayed once the user is authenticated and the
// navigation tree is ready. A share can also be redirected to another server,
// in which case it is created on that server after switching to it.
export function useShareIntentNavigation({
  navigationRef,
  isNavReady,
  isAuthenticated,
  revalidateSession,
}: UseShareIntentNavigationParams): void {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const pending = usePendingShare();

  // Capture an incoming OS share intent into the module-level store so it
  // survives the NavigationContainer remount that a server switch triggers.
  useEffect(() => {
    if (!hasShareIntent) {
      return;
    }
    const text = extractSharedText(shareIntent);
    if (text) {
      // A fresh OS share always targets the active server by default; the user
      // can redirect it from the editor afterwards.
      setPendingShare({ text });
    }
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  // Process a pending share: switch servers first if it was redirected, then
  // open the editor pre-filled once authenticated and the nav tree is ready.
  useEffect(() => {
    if (!pending || !isNavReady || !navigationRef.isReady()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (pending.targetServerId && pending.targetServerId !== getActiveServerId()) {
        const switched = await switchActiveServer(pending.targetServerId);
        if (!switched) {
          // Could not reach the requested server; drop the redirect rather than
          // silently creating the note on the wrong server.
          setPendingShare(null);
          return;
        }
        await revalidateSession();
        // The switch remounts the navigation tree; this effect re-runs in the
        // new tree with the target server active (and after login if the
        // session on that server is no longer valid).
        return;
      }

      if (!isAuthenticated || cancelled) {
        // Wait for login; the share is replayed when isAuthenticated flips.
        return;
      }

      navigationRef.navigate('NoteEditor', { noteId: null, sharedText: pending.text });
      setPendingShare(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [pending, isAuthenticated, isNavReady, navigationRef, revalidateSession]);
}
