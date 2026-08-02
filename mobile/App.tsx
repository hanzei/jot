import { initLogger } from './src/utils/logger';
initLogger();

import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  Theme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SQLiteProvider } from 'expo-sqlite';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './src/store/AuthContext';
import MobileI18nProvider from './src/i18n/MobileI18nProvider';
import { UsersProvider } from './src/store/UsersContext';
import { OfflineProvider } from './src/store/OfflineContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import RootNavigator, { type RootStackParamList } from './src/navigation/RootNavigator';
import { ToastProvider } from './src/components/Toast';
import { ConfirmProvider } from './src/components/ConfirmDialog';
import {
  getActiveServerId,
  initializeServerContext,
  subscribeToClientActiveServerChanges,
} from './src/api/client';
import { getDatabaseNameForServer, initializeServerDatabase } from './src/db/serverDatabase';
import { useDbInitError } from './src/hooks/useDbInitError';
import { ShareIntentProvider } from 'expo-share-intent';
import { useShareIntentNavigation } from './src/hooks/useShareIntentNavigation';
import { useQuickActionRouting } from './src/hooks/useQuickActionRouting';
import { useDeepLinkRouting } from './src/hooks/useDeepLinkRouting';
import './src/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

function NavigationWrapper() {
  const { colors, isDark } = useTheme();
  const { isAuthenticated, revalidateSession } = useAuth();
  const navigationRef = React.useMemo(() => createNavigationContainerRef<RootStackParamList>(), []);
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

  const { linking } = useDeepLinkRouting({
    navigationRef,
    isNavReady,
    isAuthenticated,
    revalidateSession,
  });

  useShareIntentNavigation({
    navigationRef,
    isNavReady,
    isAuthenticated,
    revalidateSession,
  });

  useQuickActionRouting({
    navigationRef,
    isNavReady,
    isAuthenticated,
  });

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme} linking={linking} onReady={() => setIsNavReady(true)}>
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [activeServerId, setActiveServerId] = React.useState<string | null>(null);
  const [isServerContextReady, setIsServerContextReady] = React.useState(false);
  const [serverContextInitError, setServerContextInitError] = React.useState<string | null>(null);
  const [serverContextInitAttempt, setServerContextInitAttempt] = React.useState(0);
  const [dbInitAttempt, setDbInitAttempt] = React.useState(0);

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
  const handleDatabaseInit = React.useCallback(
    async (db: Parameters<typeof initializeServerDatabase>[0]) =>
      initializeServerDatabase(db, activeServerId),
    [activeServerId],
  );
  // Identifies one SQLiteProvider instance: a server switch (new databaseName)
  // or a retry (bumped attempt) mounts a fresh one. An error belongs to the
  // instance that raised it, so switching servers or retrying drops it during
  // render rather than in an effect a frame later.
  const dbInstance = `sqlite-${databaseName}-${dbInitAttempt}`;
  const { hasError: hasDbInitError, reportError: reportDbInitError } = useDbInitError(dbInstance);

  const handleDatabaseError = React.useCallback((error: Error) => {
    console.warn('Database initialization failed:', error);
    reportDbInitError(error);
  }, [reportDbInitError]);

  if (!isServerContextReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
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
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (hasDbInitError) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <View style={{ alignItems: 'center', paddingHorizontal: 24 }}>
              <Text style={{ textAlign: 'center', marginBottom: 12 }}>
                {t('common.dbOpenError')}
              </Text>
              <TouchableOpacity
                onPress={() => setDbInitAttempt((prev) => prev + 1)}
                style={{ paddingHorizontal: 14, paddingVertical: 10 }}
              >
                <Text>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ShareIntentProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <SQLiteProvider
                key={dbInstance}
                databaseName={databaseName}
                onInit={handleDatabaseInit}
                onError={handleDatabaseError}
              >
                <MobileI18nProvider>
                  <ThemeProvider>
                    <OfflineProvider>
                      <UsersProvider>
                        <ToastProvider>
                          <ConfirmProvider>
                            <NavigationWrapper />
                          </ConfirmProvider>
                        </ToastProvider>
                      </UsersProvider>
                    </OfflineProvider>
                  </ThemeProvider>
                </MobileI18nProvider>
              </SQLiteProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ShareIntentProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
