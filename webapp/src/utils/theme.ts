import { getSettings } from './auth';

export type ThemePreference = 'system' | 'light' | 'dark';

export const getThemePreference = (): ThemePreference => {
  const settings = getSettings();
  if (!settings) return 'system';
  const theme = settings.theme;
  if (theme === 'system' || theme === 'light' || theme === 'dark') {
    return theme;
  }
  return 'system';
};

export const applyTheme = (pref: ThemePreference): void => {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = pref === 'dark' || (pref === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', useDark);
};
