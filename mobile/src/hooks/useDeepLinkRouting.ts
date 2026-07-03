import React from 'react';
import { Alert, Linking } from 'react-native';
import {
  type LinkingOptions,
  type NavigationContainerRef,
  getStateFromPath,
} from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useConfirm } from './useConfirm';
import {
  getActiveServerId,
  getBaseUrl,
  getStoredServerUrl,
  isServerSwitchInProgress,
  switchActiveServer,
} from '../api/client';
import { addServer, listServers } from '../store/serverAccounts';
import { setPendingShare } from '../store/shareIntent';
import type { RootStackParamList } from '../navigation/RootNavigator';
import {
  DEEP_LINK_PREFIXES,
  getDeepLinkPath,
  isJotSchemeUrl,
  isProtectedDeepLinkPath,
  normalizeServerOrigin,
  parseDeepLink,
} from '../utils/deepLink';

interface UseDeepLinkRoutingParams {
  navigationRef: NavigationContainerRef<RootStackParamList>;
  isNavReady: boolean;
  isAuthenticated: boolean;
  revalidateSession: () => Promise<unknown> | void;
}

interface UseDeepLinkRoutingResult {
  linking: LinkingOptions<RootStackParamList>;
}

export function useDeepLinkRouting({
  navigationRef,
  isNavReady,
  isAuthenticated,
  revalidateSession,
}: UseDeepLinkRoutingParams): UseDeepLinkRoutingResult {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const pendingDeepLinkUrlRef = React.useRef<string | null>(null);
  const warnedDeepLinkUrlsRef = React.useRef<Set<string>>(new Set());
  const deepLinkServerPromptInFlightRef = React.useRef<Promise<boolean> | null>(null);
  const wasAuthenticatedRef = React.useRef(isAuthenticated);

  const resolveStoredServerOrigin = React.useCallback(async (): Promise<string | null> => {
    const storedUrl = await getStoredServerUrl();
    if (!storedUrl) {
      return null;
    }
    return normalizeServerOrigin(storedUrl);
  }, []);

  const promptToAddUnknownDeepLinkServer = React.useCallback((serverOrigin: string): Promise<boolean> => {
    if (deepLinkServerPromptInFlightRef.current) {
      return deepLinkServerPromptInFlightRef.current;
    }
    const promptPromise = confirm({
      title: t('deepLink.unknownServerTitle'),
      message: t('deepLink.unknownServerMessage', { server: serverOrigin }),
      confirmLabel: t('deepLink.addAndSwitchAction'),
    }).finally(() => {
      deepLinkServerPromptInFlightRef.current = null;
    });
    deepLinkServerPromptInFlightRef.current = promptPromise;
    return promptPromise;
  }, [confirm, t]);

  const ensureDeepLinkServerContext = React.useCallback(async (serverOrigin: string): Promise<'ready' | 'switched' | false> => {
    const knownServers = await listServers();
    let targetServerId = knownServers.find((entry) => entry.serverUrl === serverOrigin)?.serverId ?? null;

    if (!targetServerId) {
      const shouldAddServer = await promptToAddUnknownDeepLinkServer(serverOrigin);
      if (!shouldAddServer) {
        return false;
      }
      const addResult = await addServer(serverOrigin);
      if (!addResult.success && addResult.code !== 'DUPLICATE') {
        Alert.alert(t('common.error'), addResult.message || t('serverPicker.addFailed'));
        return false;
      }
      targetServerId = addResult.success ? addResult.serverId : addResult.existingServerId ?? null;
      if (!targetServerId) {
        Alert.alert(t('common.error'), t('serverPicker.addFailed'));
        return false;
      }
    }

    if (getActiveServerId() === targetServerId && !isServerSwitchInProgress()) {
      return 'ready';
    }
    if (isServerSwitchInProgress() && getActiveServerId() !== targetServerId) {
      return false;
    }

    const switched = await switchActiveServer(targetServerId);
    if (!switched) {
      Alert.alert(t('common.error'), t('serverPicker.switchFailed'));
      return false;
    }
    await revalidateSession();
    // Always stash after a switch: the server change causes SQLiteProvider to
    // remount with a new key, which remounts NavigationContainer and resets
    // isNavReady. The pending URL effect replays the link once the new
    // container is ready (and after login if the session on the new server
    // is not valid).
    return 'switched';
  }, [promptToAddUnknownDeepLinkServer, revalidateSession, t]);

  const evaluateIncomingDeepLink = React.useCallback(async (
    url: string,
    options?: { allowStash?: boolean },
  ): Promise<'allow' | 'stash' | 'ignore'> => {
    const { path, hasServerParam, serverOrigin } = parseDeepLink(url);
    const configuredServerOrigin = await resolveStoredServerOrigin();
    const serverLabel = configuredServerOrigin ?? normalizeServerOrigin(getBaseUrl()) ?? getBaseUrl();
    const allowStash = options?.allowStash ?? true;

    if (!hasServerParam && !warnedDeepLinkUrlsRef.current.has(url)) {
      warnedDeepLinkUrlsRef.current.add(url);
      Alert.alert(
        t('deepLink.missingServerTitle'),
        t('deepLink.missingServerMessage', { server: serverLabel }),
      );
    }

    if (hasServerParam && !serverOrigin) {
      if (!warnedDeepLinkUrlsRef.current.has(url)) {
        warnedDeepLinkUrlsRef.current.add(url);
        Alert.alert(
          t('deepLink.invalidServerTitle'),
          t('deepLink.invalidServerMessage'),
        );
      }
      return 'ignore';
    }

    if (serverOrigin) {
      const serverCtxResult = await ensureDeepLinkServerContext(serverOrigin);
      if (!serverCtxResult) {
        return 'ignore';
      }
      if (serverCtxResult === 'switched') {
        // A server switch was performed. The switch triggers a SQLiteProvider
        // remount which remounts NavigationContainer, invalidating the current
        // listener. Stash the URL so the pending-URL effect replays it once
        // the new container is ready (and after login if needed).
        if (allowStash && isProtectedDeepLinkPath(path)) {
          pendingDeepLinkUrlRef.current = url;
          return 'stash';
        }
        return 'ignore';
      }
      // 'ready': already on the correct server, fall through to normal auth check
    }

    if (allowStash && !isAuthenticated && isProtectedDeepLinkPath(path)) {
      pendingDeepLinkUrlRef.current = url;
      return 'stash';
    }

    return 'allow';
  }, [ensureDeepLinkServerContext, isAuthenticated, resolveStoredServerOrigin, t]);

  const linking = React.useMemo<LinkingOptions<RootStackParamList>>(
    () => ({
      prefixes: DEEP_LINK_PREFIXES,
      getInitialURL: async () => {
        const url = await Linking.getInitialURL();
        if (!url || !isJotSchemeUrl(url)) {
          return null;
        }

        const decision = await evaluateIncomingDeepLink(url);
        if (decision !== 'allow') {
          return null;
        }

        return url;
      },
      subscribe: (listener) => {
        const subscription = Linking.addEventListener('url', ({ url }) => {
          if (!isJotSchemeUrl(url)) {
            return;
          }

          void (async () => {
            const decision = await evaluateIncomingDeepLink(url);
            if (decision === 'allow') {
              listener(url);
            }
          })();
        });

        return () => {
          subscription.remove();
        };
      },
      config: {
        screens: {
          MainDrawer: '',
          NoteEditor: 'notes/:noteId',
          Share: 'share/:noteId',
          Settings: 'settings',
        },
      },
      getStateFromPath: (path, options) => {
        const normalizedPath = path.replace(/^\/+/, '');
        const isProtectedPath = isProtectedDeepLinkPath(normalizedPath);

        if (!isAuthenticated && isProtectedPath) {
          return undefined;
        }

        return getStateFromPath(path, options);
      },
    }),
    [evaluateIncomingDeepLink, isAuthenticated],
  );

  // Clear stashed state on logout so a subsequent login doesn't replay stale
  // links or shares from a previous session.
  React.useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      pendingDeepLinkUrlRef.current = null;
      warnedDeepLinkUrlsRef.current.clear();
      setPendingShare(null);
    }
    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  // Replay a stashed deep link once the user is authenticated and the
  // navigation container is ready.
  React.useEffect(() => {
    if (!isAuthenticated || !isNavReady || !navigationRef.isReady()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const pendingUrl = pendingDeepLinkUrlRef.current;
      if (!pendingUrl) {
        return;
      }

      const decision = await evaluateIncomingDeepLink(pendingUrl, { allowStash: false });
      if (cancelled) {
        return;
      }
      if (decision !== 'allow') {
        pendingDeepLinkUrlRef.current = null;
        return;
      }

      const pendingPath = getDeepLinkPath(pendingUrl);
      const pendingState = getStateFromPath(pendingPath, linking.config);
      pendingDeepLinkUrlRef.current = null;
      if (!pendingState) {
        return;
      }

      navigationRef.resetRoot(pendingState);
    })();

    return () => {
      cancelled = true;
    };
  }, [evaluateIncomingDeepLink, isAuthenticated, isNavReady, linking.config, navigationRef]);

  return { linking };
}
