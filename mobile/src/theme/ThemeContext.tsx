import React, { createContext, useContext, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useColorScheme, StatusBar, ColorSchemeName } from 'react-native';
import { ThemeColors, lightColors, darkColors } from './colors';
import { ThemePreference, UpdateSettingsRequest } from '../types';
import { useAuth } from '../store/AuthContext';
import { updateSettings as apiUpdateSettings } from '../api/users';

interface ThemeState {
  colors: ThemeColors;
  isDark: boolean;
  themePreference: ThemePreference;
  updateTheme: (pref: ThemePreference) => Promise<void>;
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

function resolveColorScheme(
  preference: ThemePreference,
  systemScheme: ColorSchemeName,
): 'light' | 'dark' {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemScheme === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const { settings, setSettings: setAuthSettings } = useAuth();
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    settings?.theme ?? 'system',
  );
  const serverThemeRef = useRef<ThemePreference>(settings?.theme ?? 'system');

  useEffect(() => {
    if (settings?.theme) {
      setThemePreference(settings.theme);
      serverThemeRef.current = settings.theme;
    }
  }, [settings?.theme]);

  const resolved = resolveColorScheme(themePreference, systemScheme);
  const isDark = resolved === 'dark';
  const colors = isDark ? darkColors : lightColors;

  const updateTheme = useCallback(
    async (pref: ThemePreference) => {
      setThemePreference(pref);

      try {
        const body: UpdateSettingsRequest = {
          language: settings?.language ?? 'system',
          theme: pref,
        };
        const updated = await apiUpdateSettings(body);
        serverThemeRef.current = updated.theme;
        setAuthSettings(updated);
      } catch {
        setThemePreference(serverThemeRef.current);
      }
    },
    [settings, setAuthSettings],
  );

  const value = useMemo<ThemeState>(
    () => ({ colors, isDark, themePreference, updateTheme }),
    [colors, isDark, themePreference, updateTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
