import { getSettings } from './auth';
import type { ThemePreference } from '@jot/shared';

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

/**
 * Applies the stored theme preference and keeps following the system theme
 * while the preference is 'system'. Returns the unsubscribe function, so it can
 * be an effect's whole body.
 */
export const followThemePreference = (): (() => void) => {
  applyTheme(getThemePreference());
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemThemeChange = () => applyTheme(getThemePreference());
  mediaQuery.addEventListener('change', handleSystemThemeChange);
  return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
};
