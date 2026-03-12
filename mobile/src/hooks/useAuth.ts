import { useCallback } from 'react';
import { login as loginApi, logout as logoutApi, register as registerApi, registerDevice, unregisterDevice } from '../api/auth';
import { setToken, clearAuth, useAuthStore } from '../store/authStore';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const useAuth = () => {
  const { user, settings, isLoading } = useAuthStore();

  const login = useCallback(async (username: string, password: string) => {
    const response = await loginApi(username, password);
    useAuthStore.getState().setUser(response.user, response.settings);

    // Register FCM device token after login
    try {
      if (Platform.OS === 'android') {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status === 'granted') {
          const tokenData = await Notifications.getDevicePushTokenAsync();
          await registerDevice(tokenData.data, 'android');
        }
      }
    } catch (_e) {
      // Notification registration is best-effort
    }
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const response = await registerApi(username, password);
    useAuthStore.getState().setUser(response.user, response.settings);
  }, []);

  const logout = useCallback(async () => {
    try {
      const tokenData = await Notifications.getDevicePushTokenAsync();
      await unregisterDevice(tokenData.data);
    } catch (_e) {
      // Best-effort
    }
    await logoutApi();
    await clearAuth();
  }, []);

  return { user, settings, isLoading, login, register, logout };
};
