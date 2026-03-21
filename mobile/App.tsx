import React from 'react';
import { Linking } from 'react-native';
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
import { AuthProvider, useAuth } from './src/store/AuthContext';
import MobileI18nProvider from './src/i18n/MobileI18nProvider';
import { UsersProvider } from './src/store/UsersContext';
import { OfflineProvider } from './src/store/OfflineContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import RootNavigator, { type RootStackParamList } from './src/navigation/RootNavigator';
import { migrateDatabase } from './src/db/schema';
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

function getDeepLinkPath(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.trim();
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '');
    return [host, pathname].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '');
  } catch {
    return url
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/^\/+|\/+$/g, '');
  }
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
  const navigationRef = React.useMemo(() => createNavigationContainerRef<RootStackParamList>(), []);
  const pendingDeepLinkUrlRef = React.useRef<string | null>(null);
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

  const linking = React.useMemo<LinkingOptions<RootStackParamList>>(
    () => ({
      prefixes: DEEP_LINK_PREFIXES,
      getInitialURL: async () => {
        const url = await Linking.getInitialURL();
        if (!url) {
          return null;
        }

        const path = getDeepLinkPath(url);
        if (!isAuthenticated && isProtectedDeepLinkPath(path)) {
          pendingDeepLinkUrlRef.current = url;
          return null;
        }

        return url;
      },
      subscribe: (listener) => {
        const subscription = Linking.addEventListener('url', ({ url }) => {
          const path = getDeepLinkPath(url);
          if (!isAuthenticated && isProtectedDeepLinkPath(path)) {
            pendingDeepLinkUrlRef.current = url;
            return;
          }

          listener(url);
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
    [isAuthenticated],
  );

  React.useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      pendingDeepLinkUrlRef.current = null;
    }
    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  React.useEffect(() => {
    if (!isAuthenticated || !isNavReady || !navigationRef.isReady()) {
      return;
    }

    const pendingUrl = pendingDeepLinkUrlRef.current;
    if (!pendingUrl) {
      return;
    }

    const pendingPath = getDeepLinkPath(pendingUrl);
    const pendingState = getStateFromPath(pendingPath, linking.config);
    if (!pendingState) {
      return;
    }

    navigationRef.resetRoot(pendingState);
    pendingDeepLinkUrlRef.current = null;
  }, [isAuthenticated, isNavReady, linking.config, navigationRef]);

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
