import { apiClient } from './client';
import type { AuthResponse } from '../types';

export const login = async (username: string, password: string): Promise<AuthResponse> => {
  const response = await apiClient.post<AuthResponse>('/login', { username, password });
  return response.data;
};

export const register = async (
  username: string,
  password: string
): Promise<AuthResponse> => {
  const response = await apiClient.post<AuthResponse>('/register', { username, password });
  return response.data;
};

export const logout = async (): Promise<void> => {
  await apiClient.post('/logout');
};

export const getMe = async (): Promise<AuthResponse> => {
  const response = await apiClient.get<AuthResponse>('/me');
  return response.data;
};

export const registerDevice = async (token: string, platform = 'android'): Promise<void> => {
  await apiClient.post('/devices', { token, platform });
};

export const unregisterDevice = async (token: string): Promise<void> => {
  await apiClient.delete(`/devices/${encodeURIComponent(token)}`);
};
