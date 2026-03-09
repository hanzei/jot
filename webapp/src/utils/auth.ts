import { User } from '@/types';
import { ROLES } from '@/constants/roles';

export const getUser = (): User | null => {
  const userStr = localStorage.getItem('user');
  if (!userStr) return null;
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
};

export const setUser = (user: User): void => {
  localStorage.setItem('user', JSON.stringify(user));
};

export const removeUser = (): void => {
  localStorage.removeItem('user');
};

export const isAuthenticated = (): boolean => {
  return !!getUser();
};

export const isAdmin = (): boolean => {
  const user = getUser();
  return !!(user && user.role === ROLES.ADMIN);
};
