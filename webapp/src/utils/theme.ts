import { getSettings } from './auth';
import { ThemePreference } from '@/types';

export type { ThemePreference };

export const getThemePreference = (): ThemePreference => {
  const settings = getSettings();
  if (!settings) return 'system';
  return settings.theme;
};

export const applyTheme = (pref: ThemePreference): void => {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = pref === 'dark' || (pref === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', useDark);
};
