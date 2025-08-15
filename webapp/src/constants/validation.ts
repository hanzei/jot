// Validation constants for testing and application use
export const VALIDATION_LIMITS = {
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 10000,
  ITEM_TEXT_MAX_LENGTH: 500,
  AUTO_SAVE_TIMEOUT: 1000,
} as const

// Test-specific constants
export const TEST_CONSTANTS = {
  LONG_TITLE: 'a'.repeat(VALIDATION_LIMITS.TITLE_MAX_LENGTH + 1),
  LONG_CONTENT: 'a'.repeat(VALIDATION_LIMITS.CONTENT_MAX_LENGTH + 1),
  LONG_ITEM_TEXT: 'a'.repeat(VALIDATION_LIMITS.ITEM_TEXT_MAX_LENGTH + 1),
  VERY_LONG_STRING: 'x'.repeat(10000),
  XSS_ATTEMPT: '<script>alert("xss")</script>',
  MALICIOUS_HTML: '<img src=x onerror=alert("xss")>',
  SPECIAL_CHARACTERS: '<>&"\'`',
} as const