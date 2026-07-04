import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';
import * as QuickActions from 'expo-quick-actions';
import type { NavigationContainerRef } from '@react-navigation/native';
import { useQuickActionRouting } from '../src/hooks/useQuickActionRouting';
import type { RootStackParamList } from '../src/navigation/RootNavigator';
import { setPendingQuickAction } from '../src/store/quickAction';

const mockedSetItems = QuickActions.setItems as jest.Mock;
const mockedAddListener = QuickActions.addListener as jest.Mock;

type ActionListener = (action: { id?: string; params?: Record<string, unknown> | null }) => void;

function makeNavigationRef(): NavigationContainerRef<RootStackParamList> {
  return {
    isReady: () => true,
    navigate: jest.fn(),
  } as unknown as NavigationContainerRef<RootStackParamList>;
}

function Harness({
  navigationRef,
  isAuthenticated,
  isNavReady = true,
}: {
  navigationRef: NavigationContainerRef<RootStackParamList>;
  isAuthenticated: boolean;
  isNavReady?: boolean;
}) {
  useQuickActionRouting({ navigationRef, isNavReady, isAuthenticated });
  return <Text>harness</Text>;
}

describe('useQuickActionRouting', () => {
  let capturedListener: ActionListener | null = null;

  beforeEach(() => {
    setPendingQuickAction(null);
    mockedSetItems.mockClear();
    capturedListener = null;
    mockedAddListener.mockImplementation((listener: ActionListener) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => setPendingQuickAction(null));

  it('registers the quick-action items on mount', async () => {
    const navigationRef = makeNavigationRef();
    render(<Harness navigationRef={navigationRef} isAuthenticated />);
    await waitFor(() => expect(mockedSetItems).toHaveBeenCalled());
    const items = mockedSetItems.mock.calls[0][0];
    expect(items).toHaveLength(2);
  });

  it('opens the editor on the requested note type when authenticated', async () => {
    const navigationRef = makeNavigationRef();
    render(<Harness navigationRef={navigationRef} isAuthenticated />);

    await act(async () => {
      capturedListener?.({ id: 'new_list' });
    });

    await waitFor(() =>
      expect(navigationRef.navigate).toHaveBeenCalledWith('NoteEditor', {
        noteId: null,
        initialNoteType: 'list',
      }),
    );
  });

  it('waits for login before replaying, then opens the editor', async () => {
    const navigationRef = makeNavigationRef();
    const { rerender } = render(
      <Harness navigationRef={navigationRef} isAuthenticated={false} />,
    );

    await act(async () => {
      capturedListener?.({ id: 'new_note' });
    });
    expect(navigationRef.navigate).not.toHaveBeenCalled();

    rerender(<Harness navigationRef={navigationRef} isAuthenticated />);

    await waitFor(() =>
      expect(navigationRef.navigate).toHaveBeenCalledWith('NoteEditor', {
        noteId: null,
        initialNoteType: 'text',
      }),
    );
  });

  it('ignores actions that are not ours', async () => {
    const navigationRef = makeNavigationRef();
    render(<Harness navigationRef={navigationRef} isAuthenticated />);

    await act(async () => {
      capturedListener?.({ id: 'some_other_action' });
    });

    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });
});
