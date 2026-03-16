import { ColorSchemeName } from 'react-native';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceVariant: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderLight: string;
  primary: string;
  primaryLight: string;
  error: string;
  errorLight: string;
  warning: string;
  warningBorder: string;
  warningText: string;
  icon: string;
  iconMuted: string;
  inputBackground: string;
  inputBorder: string;
  placeholder: string;
  overlay: string;
  sheetBackground: string;
  handleColor: string;
  cardBackground: string;
  cardBorder: string;
  divider: string;
  searchBackground: string;
  searchBorder: string;
  draggingBackground: string;
}

export const lightColors: ThemeColors = {
  background: '#f9fafb',
  surface: '#fff',
  surfaceVariant: '#fafafa',
  text: '#1a1a1a',
  textSecondary: '#666',
  textMuted: '#999',
  border: '#e5e7eb',
  borderLight: '#f3f4f6',
  primary: '#2563eb',
  primaryLight: '#eff6ff',
  error: '#ef4444',
  errorLight: '#fef2f2',
  warning: '#fef3c7',
  warningBorder: '#fde68a',
  warningText: '#92400e',
  icon: '#444',
  iconMuted: '#999',
  inputBackground: '#fafafa',
  inputBorder: '#ddd',
  placeholder: '#999',
  overlay: 'rgba(0,0,0,0.4)',
  sheetBackground: '#fff',
  handleColor: '#d1d5db',
  cardBackground: '#fff',
  cardBorder: '#e5e7eb',
  divider: '#f3f4f6',
  searchBackground: '#fff',
  searchBorder: '#e5e7eb',
  draggingBackground: '#f0f4ff',
};

export const darkColors: ThemeColors = {
  background: '#111827',
  surface: '#1f2937',
  surfaceVariant: '#1f2937',
  text: '#f9fafb',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  border: '#374151',
  borderLight: '#1f2937',
  primary: '#3b82f6',
  primaryLight: '#1e3a5f',
  error: '#f87171',
  errorLight: '#451a1a',
  warning: '#422006',
  warningBorder: '#78350f',
  warningText: '#fbbf24',
  icon: '#9ca3af',
  iconMuted: '#6b7280',
  inputBackground: '#1f2937',
  inputBorder: '#374151',
  placeholder: '#6b7280',
  overlay: 'rgba(0,0,0,0.6)',
  sheetBackground: '#1f2937',
  handleColor: '#4b5563',
  cardBackground: '#1f2937',
  cardBorder: '#374151',
  divider: '#374151',
  searchBackground: '#1f2937',
  searchBorder: '#374151',
  draggingBackground: '#1e3a5f',
};

export function getColors(scheme: ColorSchemeName): ThemeColors {
  return scheme === 'dark' ? darkColors : lightColors;
}
