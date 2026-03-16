import React from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme, Theme } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SQLiteProvider } from 'expo-sqlite';
import { AuthProvider } from './src/store/AuthContext';
import { UsersProvider } from './src/store/UsersContext';
import { OfflineProvider } from './src/store/OfflineContext';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import RootNavigator from './src/navigation/RootNavigator';
import { migrateDatabase } from './src/db/schema';

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

  return (
    <NavigationContainer theme={navigationTheme}>
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
            <ThemeProvider>
              <UsersProvider>
                <OfflineProvider>
                  <NavigationWrapper />
                </OfflineProvider>
              </UsersProvider>
            </ThemeProvider>
          </AuthProvider>
        </SQLiteProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
