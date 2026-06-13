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
  NoteEditor: { noteId: string | null };
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
