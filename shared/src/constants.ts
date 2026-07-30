export const PASSWORD_MIN_LENGTH = 10;
export const SUPPORTED_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | SupportedLanguage;

// Usernames are lower case only. That is what makes them case-insensitively
// unique: the server refuses to store upper case rather than folding on
// comparison, so "Ben" and "ben" can never be two accounts. Keep in sync with
// validateUsername in server/internal/handlers/validation.go.
export const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

// Usernames may not start or end with an underscore or hyphen.
export const USERNAME_EDGE_PATTERN = /^[_-]|[_-]$/;

export const VALIDATION = {
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 10000,
  ITEM_TEXT_MAX_LENGTH: 500,
  ITEM_MAX_COUNT: 500,
  AUTO_SAVE_TIMEOUT_MS: 1000,
  INDENT_PX_PER_LEVEL: 24,
  USERNAME_MIN_LENGTH: 2,
  USERNAME_MAX_LENGTH: 30,
  PASSWORD_MIN_LENGTH,
  PAT_NAME_MAX_LENGTH: 100,
  PAT_MAX_COUNT: 50,
  SEARCH_QUERY_MAX_LENGTH: 500,
} as const;

// Note image upload limits. Keep in sync with the server-side mirror in
// server/internal/config/config.go (UPLOAD_MAX_BYTES) and
// server/internal/handlers/note_images.go (IMAGE_MAX_PER_NOTE / allowed types).
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_MAX_PER_NOTE = 10;
// No image/svg+xml: SVG can carry script and would be a stored-XSS vector
// when rendered inline (see docs/specs/file-attachments.md §7).
export const IMAGE_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const ROLES = {
  USER: 'user',
  ADMIN: 'admin',
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

export const DEFAULT_NOTE_COLOR = '#ffffff';
