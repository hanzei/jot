import { Note } from '@/types'
import { VALIDATION_LIMITS } from '@/constants/validation'

export const createMockNote = (overrides: Partial<Note> = {}): Note => ({
  id: '1',
  title: 'Test Note',
  content: 'Test content',
  note_type: 'text',
  pinned: false,
  archived: false,
  color: '#ffffff',
  user_id: 'user1',
  is_shared: false,
  deleted_at: null,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  checked_items_collapsed: false,
  items: [],
  labels: [],
  position: 0,
  ...overrides,
})

export const TEST_CONSTANTS = {
  LONG_TITLE: 'a'.repeat(VALIDATION_LIMITS.TITLE_MAX_LENGTH + 1),
  LONG_CONTENT: 'a'.repeat(VALIDATION_LIMITS.CONTENT_MAX_LENGTH + 1),
  LONG_ITEM_TEXT: 'a'.repeat(VALIDATION_LIMITS.ITEM_TEXT_MAX_LENGTH + 1),
  VERY_LONG_STRING: 'x'.repeat(10000),
  XSS_ATTEMPT: '<script>alert("xss")</script>',
  MALICIOUS_HTML: '<img src=x onerror=alert("xss")>',
  SPECIAL_CHARACTERS: '<>&"\'`',
} as const
