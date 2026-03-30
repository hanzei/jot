import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../src/screens/SettingsScreen';
import { useAuth } from '../src/store/AuthContext';
import { listSessions } from '../src/api/settings';
import { importKeepFile, getNotes } from '../src/api/notes';
import * as DocumentPicker from 'expo-document-picker';
import i18n from '../src/i18n';
import { saveNotes } from '../src/db/noteQueries';

const mockInvalidateQueries = jest.fn();
const SETTINGS_IMPORT_TEST_TIMEOUT_MS = 15_000;

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  updateMe: jest.fn(),
  changePassword: jest.fn(),
  uploadProfileIcon: jest.fn(),
  deleteProfileIcon: jest.fn(),
  getAboutInfo: jest.fn(),
  listSessions: jest.fn(),
  revokeSession: jest.fn(),
}));

jest.mock('../src/api/notes', () => ({
  importKeepFile: jest.fn(),
  getNotes: jest.fn(),
}));

jest.mock('../src/db/noteQueries', () => ({
  saveNotes: jest.fn(),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}));

jest.mock('../src/hooks/queryKeys', () => ({
  notesLocalQueryScopeKey: jest.fn(() => ['notes-local', 'test-scope']),
  notesQueryScopeKey: jest.fn(() => ['notes', 'test-scope']),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockListSessions = listSessions as jest.MockedFunction<typeof listSessions>;
const mockImportKeepFile = importKeepFile as jest.MockedFunction<typeof importKeepFile>;
const mockGetNotes = getNotes as jest.MockedFunction<typeof getNotes>;
const mockGetDocumentAsync = DocumentPicker.getDocumentAsync as jest.MockedFunction<typeof DocumentPicker.getDocumentAsync>;
const mockSaveNotes = saveNotes as jest.MockedFunction<typeof saveNotes>;

const user = {
  id: 'user-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const settings = {
  user_id: 'user-1',
  language: 'en',
  theme: 'system' as const,
  note_sort: 'manual' as const,
  updated_at: '2026-01-02T00:00:00Z',
};

describe('SettingsScreen import section', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockInvalidateQueries.mockClear();
    mockListSessions.mockResolvedValue([]);
    mockGetNotes.mockResolvedValue([]);
    mockSaveNotes.mockResolvedValue(undefined);
    await i18n.changeLanguage('en');
    mockUseAuth.mockImplementation(
      () =>
        ({
          isAuthenticated: true,
          isLoading: false,
          user,
          settings,
          setUser: jest.fn(),
          setSettings: jest.fn(),
          login: jest.fn(),
          register: jest.fn(),
          logout: jest.fn(),
          revalidateSession: jest.fn(),
        }) as unknown as ReturnType<typeof useAuth>,
    );
  });

  it('imports a selected keep export and renders summary', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.zip', name: 'export.zip', mimeType: 'application/zip' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportKeepFile.mockResolvedValue({ imported: 2, skipped: 1 });

    const { getByTestId, getByText } = render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText('export.zip')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(mockImportKeepFile).toHaveBeenCalledWith({
        uri: 'file:///tmp/export.zip',
        name: 'export.zip',
        mimeType: 'application/zip',
      });
    });
    await waitFor(() => {
      expect(mockGetNotes).toHaveBeenCalled();
      expect(mockSaveNotes).toHaveBeenCalled();
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['notes-local', 'test-scope'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['notes', 'test-scope'] });
    await waitFor(() => {
      expect(getByText(/Imported 2 notes/i)).toBeTruthy();
    });
    expect(getByText(/\(1 skipped\)/i)).toBeTruthy();
  }, SETTINGS_IMPORT_TEST_TIMEOUT_MS);

  it('rejects unsupported files with a validation error', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/notes.txt', name: 'notes.txt', mimeType: 'text/plain' }],
    } as DocumentPicker.DocumentPickerResult);

    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText(/Invalid file type/i)).toBeTruthy();
    });
    expect(queryByText('notes.txt')).toBeNull();
    expect(mockImportKeepFile).not.toHaveBeenCalled();
  });

  it('shows API error when import fails', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportKeepFile.mockRejectedValue({ response: { data: 'invalid JSON file' } });

    const { getByTestId, getByText } = render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/invalid JSON file/i)).toBeTruthy();
    });
  });

  it('shows fallback error when API error has no response data', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportKeepFile.mockRejectedValue(new Error('network error'));

    const { getByTestId, getByText } = render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    fireEvent.press(getByTestId('settings-import-select-file'));
    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });

    fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/Import failed/i)).toBeTruthy();
    });
  });

  it('shows partial-import error rows when server returns per-note errors', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportKeepFile.mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: ['failed to import "bad note": invalid json'],
    });

    const { getByTestId, getByText } = render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    fireEvent.press(getByTestId('settings-import-select-file'));
    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });
    fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/1 failed/i)).toBeTruthy();
      expect(getByText(/failed to import "bad note": invalid json/i)).toBeTruthy();
    });
  });
});
