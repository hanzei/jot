import { apiClient } from './client';
import type { UserInfo } from '../types';

export const searchUsers = async (search?: string): Promise<UserInfo[]> => {
  const response = await apiClient.get<UserInfo[]>('/users', {
    params: search ? { search } : undefined,
  });
  return response.data;
};
