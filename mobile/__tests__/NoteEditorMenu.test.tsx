import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import NoteEditorMenu from '../src/components/NoteEditorMenu';

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    SafeAreaInsetsContext: createContext(insets),
  };
});

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: {
      text: '#111',
      error: '#dc2626',
      borderLight: '#eee',
      overlay: 'rgba(0,0,0,0.4)',
      sheetBackground: '#fff',
      handleColor: '#ccc',
    },
  }),
}));

describe('NoteEditorMenu', () => {
  const noop = () => {};

  it('renders the editable-note actions and hides gated ones when their callbacks are absent', () => {
    const { getByTestId, queryByTestId } = render(
      <NoteEditorMenu
        visible
        onClose={noop}
        onSend={noop}
        onDuplicate={noop}
        onMoveToTrash={noop}
        // onShare / onManageLabels intentionally omitted (offline/unowned draft)
      />,
    );

    expect(getByTestId('editor-menu-send')).toBeTruthy();
    expect(getByTestId('editor-menu-duplicate')).toBeTruthy();
    expect(getByTestId('editor-menu-trash')).toBeTruthy();
    expect(queryByTestId('editor-menu-share')).toBeNull();
    expect(queryByTestId('editor-menu-label')).toBeNull();
    // Trash-only actions never render for an editable note.
    expect(queryByTestId('editor-menu-restore')).toBeNull();
    expect(queryByTestId('editor-menu-delete-permanently')).toBeNull();
  });

  it('shows Share and Labels when their callbacks are provided', () => {
    const { getByTestId } = render(
      <NoteEditorMenu
        visible
        onClose={noop}
        onSend={noop}
        onShare={noop}
        onDuplicate={noop}
        onManageLabels={noop}
        onMoveToTrash={noop}
      />,
    );

    expect(getByTestId('editor-menu-share')).toBeTruthy();
    expect(getByTestId('editor-menu-label')).toBeTruthy();
  });

  it('renders only Restore and Delete-forever for a trashed note', () => {
    const { getByTestId, queryByTestId } = render(
      <NoteEditorMenu
        visible
        onClose={noop}
        trashed
        onSend={noop}
        onDuplicate={noop}
        onMoveToTrash={noop}
        onRestore={noop}
        onDeletePermanently={noop}
      />,
    );

    expect(getByTestId('editor-menu-restore')).toBeTruthy();
    expect(getByTestId('editor-menu-delete-permanently')).toBeTruthy();
    // Editable-note actions are suppressed even though their callbacks exist.
    expect(queryByTestId('editor-menu-send')).toBeNull();
    expect(queryByTestId('editor-menu-duplicate')).toBeNull();
    expect(queryByTestId('editor-menu-trash')).toBeNull();
  });

  it('closes the sheet before running an action', () => {
    const onClose = jest.fn();
    const onDuplicate = jest.fn();
    const { getByTestId } = render(
      <NoteEditorMenu visible onClose={onClose} onSend={noop} onDuplicate={onDuplicate} onMoveToTrash={noop} />,
    );

    fireEvent.press(getByTestId('editor-menu-duplicate'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });
});
