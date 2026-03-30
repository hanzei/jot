import React from 'react';
import { ActivityIndicator, Alert, Linking, Text, TouchableOpacity, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  Theme,
  LinkingOptions,
  createNavigationContainerRef,
  getStateFromPath,
} from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SQLiteProvider } from 'expo-sqlite';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './src/store/AuthContext';
import MobileI18nProvider from './src/i18n/MobileI18nProvider';
import { UsersProvider } from './src/store/UsersContext';
import { OfflineProvider } from './src/store/OfflineContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import RootNavigator, { type RootStackParamList } from './src/navigation/RootNavigator';
import {
  getActiveServerId,
  getBaseUrl,
  getStoredServerUrl,
  isServerSwitchInProgress,
  initializeServerContext,
  switchActiveServer,
  subscribeToClientActiveServerChanges,
} from './src/api/client';
import { getDatabaseNameForServer, initializeServerDatabase } from './src/db/serverDatabase';
import { canonicalizeServerOrigin } from '@jot/shared';
import { addServer, listServers } from './src/store/serverAccounts';
import './src/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

const DEEP_LINK_PREFIXES = ['jot://'];

function isJotSchemeUrl(url: string): boolean {
  return /^jot:\/\//i.test(url);
}

function normalizeServerOrigin(url: string): string | null {
  return canonicalizeServerOrigin(url);
}

function parseDeepLink(url: string): { path: string; hasServerParam: boolean; serverOrigin: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.trim();
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const path = [host, pathname].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '');
    const serverParam = parsed.searchParams.get('server');
    return {
      path,
      hasServerParam: serverParam !== null,
      serverOrigin: serverParam ? normalizeServerOrigin(serverParam) : null,
    };
  } catch {
    const [withoutScheme, rawQuery = ''] = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').split('?');
    const serverParam = new URLSearchParams(rawQuery).get('server');
    return {
      path: withoutScheme.replace(/^\/+|\/+$/g, ''),
      hasServerParam: serverParam !== null,
      serverOrigin: serverParam ? normalizeServerOrigin(serverParam) : null,
    };
  }
}

function getDeepLinkPath(url: string): string {
  return parseDeepLink(url).path;
}

function isProtectedDeepLinkPath(path: string): boolean {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (normalizedPath.length === 0) {
    return true;
  }

  const firstSegment = normalizedPath.split('/')[0];
  return firstSegment === 'notes' || firstSegment === 'share' || firstSegment === 'settings';
}

function NavigationWrapper() {
  const { colors, isDark } = useTheme();
  const { isAuthenticated, revalidateSession } = useAuth();
  const { t } = useTranslation();
  const navigationRef = React.useMemo(() => createNavigationContainerRef<RootStackParamList>(), []);
  const pendingDeepLinkUrlRef = React.useRef<string | null>(null);
  const warnedDeepLinkUrlsRef = React.useRef<Set<string>>(new Set());
  const deepLinkServerPromptInFlightRef = React.useRef<Promise<boolean> | null>(null);
  const wasAuthenticatedRef = React.useRef(isAuthenticated);
  const [isNavReady, setIsNavReady] = React.useState(false);

  const navigationTheme: Theme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.primary,
    },
  };

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
    const promptPromise = new Promise<boolean>((resolve) => {
      Alert.alert(
        t('deepLink.unknownServerTitle'),
        t('deepLink.unknownServerMessage', { server: serverOrigin }),
        [
          { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('deepLink.addAndSwitchAction'), onPress: () => resolve(true) },
        ],
      );
    }).finally(() => {
      deepLinkServerPromptInFlightRef.current = null;
    });
    deepLinkServerPromptInFlightRef.current = promptPromise;
    return promptPromise;
  }, [t]);

  const ensureDeepLinkServerContext = React.useCallback(async (serverOrigin: string): Promise<boolean> => {
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
      return true;
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
    return true;
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
      const switched = await ensureDeepLinkServerContext(serverOrigin);
      if (!switched) {
        return 'ignore';
      }
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

  React.useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      pendingDeepLinkUrlRef.current = null;
      warnedDeepLinkUrlsRef.current.clear();
    }
    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

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

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme} linking={linking} onReady={() => setIsNavReady(true)}>
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  const [activeServerId, setActiveServerId] = React.useState<string | null>(null);
  const [isServerContextReady, setIsServerContextReady] = React.useState(false);
  const [serverContextInitError, setServerContextInitError] = React.useState<string | null>(null);
  const [serverContextInitAttempt, setServerContextInitAttempt] = React.useState(0);

  React.useEffect(() => {
    let isMounted = true;
    const unsubscribe = subscribeToClientActiveServerChanges((nextServerId) => {
      if (!isMounted) {
        return;
      }
      setActiveServerId(nextServerId);
      queryClient.clear();
    });

    void (async () => {
      try {
        await initializeServerContext();
        if (!isMounted) {
          return;
        }
        setActiveServerId(getActiveServerId());
        setIsServerContextReady(true);
        setServerContextInitError(null);
      } catch (error) {
        console.warn('Failed to initialize server context:', error);
        if (!isMounted) {
          return;
        }
        setServerContextInitError('server_context_init_failed');
      }
    })();

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [serverContextInitAttempt]);

  const databaseName = getDatabaseNameForServer(activeServerId);
  const handleDatabaseInit = async (db: Parameters<typeof initializeServerDatabase>[0]) =>
    initializeServerDatabase(db, activeServerId);

  if (!isServerContextReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {serverContextInitError ? (
            <View style={{ alignItems: 'center', paddingHorizontal: 24 }}>
              <Text style={{ textAlign: 'center', marginBottom: 12 }}>
                Failed to initialize server context.
              </Text>
              <TouchableOpacity
                onPress={() => setServerContextInitAttempt((prev) => prev + 1)}
                style={{ paddingHorizontal: 14, paddingVertical: 10 }}
              >
                <Text>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ActivityIndicator size="large" />
          )}
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SQLiteProvider
            key={`sqlite-${databaseName}`}
            databaseName={databaseName}
            onInit={handleDatabaseInit}
          >
            <MobileI18nProvider>
              <ThemeProvider>
                <UsersProvider>
                  <OfflineProvider>
                    <NavigationWrapper />
                  </OfflineProvider>
                </UsersProvider>
              </ThemeProvider>
            </MobileI18nProvider>
          </SQLiteProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
