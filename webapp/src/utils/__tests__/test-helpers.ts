import { VALIDATION, type Note, type TextNote, type ListNote } from '@jot/shared'

const defaultBase = {
  id: '1',
  pinned: false,
  archived: false,
  color: '#ffffff',
  user_id: 'user1',
  is_shared: false,
  deleted_at: null,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  labels: [],
  position: 0,
}

export const createMockTextNote = (overrides: Partial<TextNote> = {}): TextNote => ({
  ...defaultBase,
  note_type: 'text',
  content: 'Test content',
  ...overrides,
})

export const createMockListNote = (overrides: Partial<ListNote> = {}): ListNote => ({
  ...defaultBase,
  note_type: 'list',
  title: 'Test Note',
  items: [],
  checked_items_collapsed: false,
  ...overrides,
})

export const createMockNote = (overrides: Partial<Note> = {}): Note => {
  const noteType = (overrides as Partial<Note>).note_type ?? 'text'
  if (noteType === 'list') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { note_type: _, ...rest } = overrides as Partial<ListNote>
    return createMockListNote(rest)
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { note_type: _, ...rest } = overrides as Partial<TextNote>
  return createMockTextNote(rest)
}

export const TEST_CONSTANTS = {
  LONG_TITLE: 'a'.repeat(VALIDATION.TITLE_MAX_LENGTH + 1),
  LONG_CONTENT: 'a'.repeat(VALIDATION.CONTENT_MAX_LENGTH + 1),
  LONG_ITEM_TEXT: 'a'.repeat(VALIDATION.ITEM_TEXT_MAX_LENGTH + 1),
  VERY_LONG_STRING: 'x'.repeat(10000),
  XSS_ATTEMPT: '<script>alert("xss")</script>',
  MALICIOUS_HTML: '<img src=x onerror=alert("xss")>',
  SPECIAL_CHARACTERS: '<>&"\'`',
} as const
