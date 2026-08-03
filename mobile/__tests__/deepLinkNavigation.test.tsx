import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';
import {
  NavigationContainer,
  createNavigationContainerRef,
  useRoute,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { getNoteScreenId } from '../src/navigation/RootNavigator';

// Reproduces NoteEditorScreen's behavior of seeding state from the initial
// params and not reacting to later param changes. If React Navigation reuses an
// existing screen instance (instead of pushing a fresh one), the cached note id
// stays stale.
function NoteEditorProbe() {
  const route = useRoute<{ key: string; name: string; params: { noteId: string | null } }>();
  const [noteId] = React.useState(route.params.noteId);
  return <Text testID="current-note">{noteId ?? 'none'}</Text>;
}

function HomeProbe() {
  return <Text testID="home">home</Text>;
}

type Params = {
  Home: undefined;
  NoteEditor: { noteId: string | null; openKey?: string };
};

function renderNavigator(withGetId: boolean) {
  const Stack = createNativeStackNavigator<Params>();
  const navigationRef = createNavigationContainerRef<Params>();
  const utils = render(
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeProbe} />
        <Stack.Screen
          name="NoteEditor"
          component={NoteEditorProbe}
          {...(withGetId ? { getId: getNoteScreenId } : {})}
        />
      </Stack.Navigator>
    </NavigationContainer>,
  );
  return { ...utils, navigationRef };
}

describe('getNoteScreenId', () => {
  it('returns the note id when present', () => {
    expect(getNoteScreenId({ params: { noteId: 'note-a' } })).toBe('note-a');
  });

  it('returns undefined for a null note id (new note / share intent)', () => {
    expect(getNoteScreenId({ params: { noteId: null } })).toBeUndefined();
  });

  it('returns undefined when params are missing', () => {
    expect(getNoteScreenId({})).toBeUndefined();
  });

  it('falls back to openKey for a null note id', () => {
    expect(getNoteScreenId({ params: { noteId: null, openKey: 'k1' } })).toBe('k1');
  });
});

describe('deep link navigation between notes', () => {
  it('opens the second note when a deep link arrives while another note is open', async () => {
    const { getByTestId, navigationRef } = renderNavigator(true);

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-a' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));

    // Second deep link while note-a's editor is still mounted.
    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-b' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-b'));
  });

  it('without getId the stale instance is reused (guards the fix is meaningful)', async () => {
    const { getByTestId, navigationRef } = renderNavigator(false);

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-a' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-b' });
    });
    // The existing instance is reused, so the cached note id stays on note-a.
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));
  });
});

// Reproduces the reported bug: open note A, background the app (its editor
// stays the focused route — no full remount), then trigger a "new note"
// action (app-icon quick action / share intent). Both arrive as
// `navigate('NoteEditor', { noteId: null, ... })` from a global effect, fired
// while note A's editor is still the current route.
describe('opening a new note while another note is the focused screen', () => {
  it('without openKey, the new-note navigation reuses the focused note editor (the bug)', async () => {
    const { getByTestId, navigationRef } = renderNavigator(true);

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-a' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));

    // Simulates a quick action/share intent arriving with no openKey while
    // note-a's editor is still focused: id resolves to undefined, so NAVIGATE
    // falls back to reusing the current route instead of opening a new note.
    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: null });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));
  });

  it('with a fresh openKey, the new-note navigation opens a genuinely new note', async () => {
    const { getByTestId, navigationRef } = renderNavigator(true);

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: 'note-a' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('note-a'));

    await act(async () => {
      navigationRef.navigate('NoteEditor', { noteId: null, openKey: 'quick-action-1' });
    });
    await waitFor(() => expect(getByTestId('current-note').props.children).toBe('none'));
  });
});
