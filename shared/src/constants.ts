export const PASSWORD_MIN_LENGTH = 4;
export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;

export const VALIDATION = {
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 10000,
  ITEM_TEXT_MAX_LENGTH: 500,
  AUTO_SAVE_TIMEOUT_MS: 1000,
  INDENT_PX_PER_LEVEL: 24,
  USERNAME_MIN_LENGTH: 2,
  USERNAME_MAX_LENGTH: 30,
  PASSWORD_MIN_LENGTH,
} as const;

export const ROLES = {
  USER: 'user',
  ADMIN: 'admin',
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

export const DEFAULT_NOTE_COLOR = '#ffffff';
