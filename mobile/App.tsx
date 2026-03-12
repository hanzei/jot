import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { AppNavigator } from './src/navigation';
import { useAuthStore } from './src/store/authStore';
import { getMe } from './src/api/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function AppContent() {
  const { setUser, setLoading } = useAuthStore();

  useEffect(() => {
    // Attempt to restore session on startup
    getMe()
      .then((response) => {
        setUser(response.user, response.settings);
      })
      .catch(() => {
        setUser(null, null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [setUser, setLoading]);

  return <AppNavigator />;
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
