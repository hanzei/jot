import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { User, UserSettings } from '../types';

const TOKEN_KEY = 'jot_session_token';
const USER_KEY = 'jot_user';

export const getToken = async (): Promise<string | null> => {
  return SecureStore.getItemAsync(TOKEN_KEY);
};

export const setToken = async (token: string): Promise<void> => {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
};

export const clearAuth = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
  useAuthStore.getState().setUser(null, null);
};

interface AuthState {
  user: User | null;
  settings: UserSettings | null;
  isLoading: boolean;
  setUser: (user: User | null, settings: UserSettings | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  settings: null,
  isLoading: true,
  setUser: (user, settings) => set({ user, settings }),
  setLoading: (isLoading) => set({ isLoading }),
}));
