import React from 'react';
import { Alert, Linking } from 'react-native';
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
import { getBaseUrl, getStoredServerUrl, restoreServerUrl } from './src/api/client';
import { migrateDatabase } from './src/db/schema';
import { canonicalizeServerOrigin } from '@jot/shared';
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
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const navigationRef = React.useMemo(() => createNavigationContainerRef<RootStackParamList>(), []);
  const pendingDeepLinkUrlRef = React.useRef<string | null>(null);
  const warnedDeepLinkUrlsRef = React.useRef<Set<string>>(new Set());
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
    restoreServerUrl(storedUrl);
    return normalizeServerOrigin(storedUrl);
  }, []);

  const evaluateIncomingDeepLink = React.useCallback(async (url: string): Promise<'allow' | 'stash' | 'ignore'> => {
    const { path, hasServerParam, serverOrigin } = parseDeepLink(url);
    const configuredServerOrigin = await resolveStoredServerOrigin();
    const serverLabel = configuredServerOrigin ?? normalizeServerOrigin(getBaseUrl()) ?? getBaseUrl();

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

    if (serverOrigin && configuredServerOrigin && serverOrigin !== configuredServerOrigin) {
      if (!warnedDeepLinkUrlsRef.current.has(url)) {
        warnedDeepLinkUrlsRef.current.add(url);
        Alert.alert(
          t('deepLink.wrongServerTitle'),
          t('deepLink.wrongServerMessage', {
            targetServer: serverOrigin,
            currentServer: configuredServerOrigin,
          }),
        );
      }
      return 'ignore';
    }

    if (!isAuthenticated && isProtectedDeepLinkPath(path)) {
      pendingDeepLinkUrlRef.current = url;
      return 'stash';
    }

    return 'allow';
  }, [isAuthenticated, resolveStoredServerOrigin, t]);

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

      const { hasServerParam, serverOrigin } = parseDeepLink(pendingUrl);
      const configuredServerOrigin = await resolveStoredServerOrigin();
      if (cancelled) {
        return;
      }
      if (hasServerParam && (!serverOrigin || (configuredServerOrigin && serverOrigin !== configuredServerOrigin))) {
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
  }, [isAuthenticated, isNavReady, linking.config, navigationRef, resolveStoredServerOrigin]);

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme} linking={linking} onReady={() => setIsNavReady(true)}>
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <SQLiteProvider databaseName="jot.db" onInit={migrateDatabase}>
          <AuthProvider>
            <MobileI18nProvider>
              <ThemeProvider>
                <UsersProvider>
                  <OfflineProvider>
                    <NavigationWrapper />
                  </OfflineProvider>
                </UsersProvider>
              </ThemeProvider>
            </MobileI18nProvider>
          </AuthProvider>
        </SQLiteProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
