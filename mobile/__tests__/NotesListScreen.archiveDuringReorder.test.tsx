/**
 * Reproduces a reported bug: dragging a note to a later manual position and
 * then immediately archiving it makes the note visually jump back to the
 * front of the dashboard before it disappears.
 *
 * This test uses the REAL NotesListScreen, useOfflineNotes, useNotes and
 * noteQueries implementations (backed by the real in-memory SQLite test DB —
 * see mobile/CLAUDE.md's "Database Tests" section) so it exercises the actual
 * production code paths rather than asserting against mocked return values.
 * Only the network layer, DraggableMasonry (to avoid simulating a real pan
 * gesture), and presentational/context hooks are mocked.
 */
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NotesListScreen from '../src/screens/NotesListScreen';
import { useUpdateNote } from '../src/hooks/useNotes';
import { saveNotes } from '../src/db/noteQueries';
import { lightColors } from '../src/theme/colors';
import type { Note } from '@jot/shared';
import { getDefaultTestDb } from './helpers/testDb';

jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn().mockReturnValue({ navigate: jest.fn(), dispatch: jest.fn() }),
  DrawerActions: { toggleDrawer: () => ({ type: 'DRAWER_TOGGLE' }) },
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return { __esModule: true, useSafeAreaInsets: () => insets, SafeAreaInsetsContext: createContext(insets) };
});

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

jest.mock('../src/store/UsersContext', () => ({
  useUsers: jest.fn().mockReturnValue({ refreshUsers: jest.fn() }),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn().mockReturnValue({
    user: { id: 'user-1', username: 'mobile-user' },
    settings: { user_id: 'user-1', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '2024-01-01T00:00:00Z' },
    setSettings: jest.fn(),
    isLocalMode: false,
  }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({ updateMe: jest.fn() }));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn().mockReturnValue({ isConnected: true }),
}));

jest.mock('../src/api/client', () => ({
  isServerSwitchInProgress: jest.fn(() => false),
  getActiveServerId: jest.fn(() => 'test-server-id'),
  assertSwitchWriteAllowed: jest.fn(),
}));

// Auto-mocked network layer: getNotes() is left permanently pending so
// useOfflineNotes's background sync never touches the seeded local rows.
jest.mock('../src/api/notes');

jest.mock('../src/components/NoteCard', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return function MockNoteCard({ note }: { note: Note }) {
    return (
      <ReactNative.View testID={`note-card-${note.id}`}>
        <ReactNative.Text>{note.id}</ReactNative.Text>
      </ReactNative.View>
    );
  };
});

// Stand-in for the real gesture-driven masonry: exposes a button per section
// that moves the section's first card to the end, mimicking "drag the top
// note down to a later position" without needing a real pan gesture.
jest.mock('../src/screens/notesList/DraggableMasonry', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return function MockDraggableMasonry({
    sections,
    onSectionReorder,
    renderCard,
  }: {
    sections: { key: string; data: Note[] }[];
    onSectionReorder: (key: string, newData: Note[]) => void;
    renderCard: (note: Note) => React.ReactNode;
  }) {
    return (
      <ReactNative.View testID="mock-draggable-masonry">
        {sections.map((section) => (
          <ReactNative.View key={section.key} testID={`section-${section.key}`}>
            {section.data.map((note) => (
              <ReactNative.View key={note.id}>{renderCard(note)}</ReactNative.View>
            ))}
            <ReactNative.TouchableOpacity
              testID={`reorder-trigger-${section.key}`}
              onPress={() => {
                const [first, ...rest] = section.data;
                if (!first) return;
                onSectionReorder(section.key, [...rest, first]);
              }}
            >
              <ReactNative.Text>drag first to end</ReactNative.Text>
            </ReactNative.TouchableOpacity>
          </ReactNative.View>
        ))}
      </ReactNative.View>
    );
  };
});

const mockTheme = jest.requireMock('../src/theme/ThemeContext').useTheme as jest.Mock;
const notesApi = jest.requireMock('../src/api/notes') as {
  getNotes: jest.Mock;
  reorderNotes: jest.Mock;
  updateNote: jest.Mock;
};

function makeNote(id: string, position: number): Note {
  return {
    id,
    user_id: 'user-1',
    note_type: 'text',
    content: id,
    version: 1,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position,
    is_shared: false,
    labels: [],
    shared_with: [],
    deleted_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Renders alongside NotesListScreen, sharing its QueryClient, standing in for
// the archive action that in the real app lives in NoteEditorScreen (a
// different screen reached via navigation, so it can't be triggered directly
// from a NotesListScreen-only render).
function ArchiveTrigger({ noteId }: { noteId: string }) {
  const { mutateAsync } = useUpdateNote();
  return (
    <TouchableOpacity
      testID="archive-trigger"
      onPress={() => {
        void mutateAsync({ id: noteId, data: { archived: true } });
      }}
    >
      <Text>archive</Text>
    </TouchableOpacity>
  );
}

function orderedCardIds(): string[] {
  return screen.getAllByTestId(/^note-card-/).map((el) => (el.props.testID as string).replace('note-card-', ''));
}

// Regression test for #815: archiving a note while its own manual
// drag-reorder was still in flight used to revert the note to its pre-drag
// position for one render before it was correctly removed. Fixed by giving
// useReorderNotes its own onMutate (applyOptimisticReorder in useNotes.ts) so
// the notes-list cache reflects the new order immediately instead of only
// after the reorder's async round-trip.
describe('NotesListScreen: archive during an in-flight manual reorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTheme.mockReturnValue({ colors: lightColors });
    // Never resolves: keeps useOfflineNotes's background sync from ever
    // running saveServerNotesScope against the seeded local rows.
    notesApi.getNotes.mockImplementation(() => new Promise(() => {}));
  });

  it('does not revert the dragged note to the front while its reorder is still in flight', async () => {
    const db = getDefaultTestDb();
    await saveNotes(db, [
      makeNote('note-A', 0),
      makeNote('note-B', 1),
      makeNote('note-C', 2),
      makeNote('note-D', 3),
      makeNote('note-E', 4),
      makeNote('note-F', 5),
    ]);

    const reorderDeferred = deferred<void>();
    notesApi.reorderNotes.mockImplementation(() => reorderDeferred.promise);
    const updateDeferred = deferred<Note>();
    notesApi.updateNote.mockImplementation(() => updateDeferred.promise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <NotesListScreen variant="notes" />
        <ArchiveTrigger noteId="note-A" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('reorder-trigger-notes')).toBeTruthy());
    expect(orderedCardIds()).toEqual(['note-A', 'note-B', 'note-C', 'note-D', 'note-E', 'note-F']);

    // Drag note-A from the front to the end (position 5 of 6).
    await fireEvent.press(screen.getByTestId('reorder-trigger-notes'));
    expect(orderedCardIds()).toEqual(['note-B', 'note-C', 'note-D', 'note-E', 'note-F', 'note-A']);
    await waitFor(() => expect(notesApi.reorderNotes).toHaveBeenCalledTimes(1));

    // While that reorder is still in flight (network promise unresolved),
    // archive note-A — mirroring tapping Archive in the single-note editor
    // right after the drag.
    await act(async () => {
      await fireEvent.press(screen.getByTestId('archive-trigger'));
      // Flush microtasks so useMutation's onMutate (the synchronous optimistic
      // cache patch) has a chance to run and propagate to subscribers.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The regression signature would be note-A reverting to the front (its
    // pre-drag position) instead of staying at the end where the
    // still-unconfirmed drag put it. Both mutations' network calls are still
    // pending here (deferred), so this snapshot is only the effect of the two
    // onMutate handlers — nothing else has had a chance to run yet.
    const midRaceOrder = orderedCardIds();

    // Let everything settle: both mutations' network calls finally resolve,
    // and their invalidateQueries refetches complete.
    await act(async () => {
      reorderDeferred.resolve();
      updateDeferred.resolve({ ...makeNote('note-A', 0), archived: true });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(orderedCardIds()).not.toContain('note-A');
    });
    expect(orderedCardIds()).toEqual(['note-B', 'note-C', 'note-D', 'note-E', 'note-F']);

    // The actual assertion under test: note-A must never have been shown back
    // at the front while it was still (correctly) sitting at the end.
    expect(midRaceOrder).toEqual(['note-B', 'note-C', 'note-D', 'note-E', 'note-F', 'note-A']);
  }, 30000);
});
