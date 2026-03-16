import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme, StatusBar, ColorSchemeName } from 'react-native';
import { ThemeColors, lightColors, darkColors } from './colors';
import { ThemePreference } from '../types';
import { useAuth } from '../store/AuthContext';

interface ThemeState {
  colors: ThemeColors;
  isDark: boolean;
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
  const { settings } = useAuth();

  const themePreference: ThemePreference = settings?.theme ?? 'system';
  const resolved = resolveColorScheme(themePreference, systemScheme);
  const isDark = resolved === 'dark';
  const colors = isDark ? darkColors : lightColors;

  const value = useMemo<ThemeState>(
    () => ({ colors, isDark }),
    [colors, isDark],
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
