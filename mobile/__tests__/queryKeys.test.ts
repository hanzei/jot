import { setServerUrl } from '../src/api/client';
import {
  labelCountsQueryKey,
  labelsQueryKey,
  noteLocalQueryKey,
  noteQueryKey,
  noteSharesQueryKey,
  notesLocalQueryKey,
  notesQueryKey,
} from '../src/hooks/queryKeys';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('expo-secure-store', () => {
  const memory = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => memory.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      memory.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      memory.delete(key);
    }),
  };
});

describe('query key scoping', () => {
  beforeEach(async () => {
    await setServerUrl('https://scope-a.example.com');
  });

  it('scopes note and notes keys by active server', async () => {
    const firstNotesKey = notesQueryKey({ archived: true });
    const firstLocalNotesKey = notesLocalQueryKey({ archived: true });
    const firstNoteKey = noteQueryKey('note-1');
    const firstLocalNoteKey = noteLocalQueryKey('note-1');
    const firstLabelsKey = labelsQueryKey();
    const firstLabelCountsKey = labelCountsQueryKey();
    const firstSharesKey = noteSharesQueryKey('note-1');

    await setServerUrl('https://scope-b.example.com');

    const secondNotesKey = notesQueryKey({ archived: true });
    const secondNoteKey = noteQueryKey('note-1');
    const secondLocalNoteKey = noteLocalQueryKey('note-1');
    const secondLabelsKey = labelsQueryKey();
    const secondLabelCountsKey = labelCountsQueryKey();
    const secondSharesKey = noteSharesQueryKey('note-1');
    const secondLocalNotesKey = notesLocalQueryKey({ archived: true });

    expect(firstNotesKey[0]).toBe('notes');
    expect(firstNoteKey[0]).toBe('note');
    expect(firstLocalNoteKey[0]).toBe('note-local');
    expect(firstLabelsKey[0]).toBe('labels');
    expect(firstLabelCountsKey[0]).toBe('label-counts');
    expect(firstSharesKey[0]).toBe('noteShares');

    expect(firstNotesKey[1]).not.toEqual(secondNotesKey[1]);
    expect(firstNoteKey[1]).not.toEqual(secondNoteKey[1]);
    expect(firstLocalNoteKey[1]).not.toEqual(secondLocalNoteKey[1]);
    expect(firstLabelsKey[1]).not.toEqual(secondLabelsKey[1]);
    expect(firstLabelCountsKey[1]).not.toEqual(secondLabelCountsKey[1]);
    expect(firstSharesKey[1]).not.toEqual(secondSharesKey[1]);
    expect(firstLocalNotesKey[1]).not.toEqual(secondLocalNotesKey[1]);
    expect(secondLocalNotesKey[0]).toBe('notes-local');
  });
});
