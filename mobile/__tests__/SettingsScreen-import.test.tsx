import { fireEvent, render, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../src/screens/SettingsScreen';
import { useAuth } from '../src/store/AuthContext';
import { importFile } from '../src/api/notes';
import * as DocumentPicker from 'expo-document-picker';
import i18n from '../src/i18n';
import { saveLabels, saveNotes } from '../src/db/noteQueries';
import { apiErrorBody } from './helpers/apiError';
import { jot } from '../src/api/jot';

const mockInvalidateQueries = jest.fn();
const SETTINGS_IMPORT_TEST_TIMEOUT_MS = 15_000;

jest.mock('../src/api/jot', () => ({
  jot: {
    notes: {
      getAll: jest.fn(),
    },
    labels: {
      getAll: jest.fn(),
    },
    users: {
      updateMe: jest.fn(),
      changePassword: jest.fn(),
      deleteProfileIcon: jest.fn(),
    },
    about: {
      get: jest.fn(),
    },
    sessions: {
      list: jest.fn(),
      revoke: jest.fn(),
    },
    pats: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      revoke: jest.fn(),
    },
  },
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  uploadProfileIcon: jest.fn(),
}));

jest.mock('../src/api/notes', () => ({
  importFile: jest.fn(),
}));


jest.mock('../src/db/noteQueries', () => ({
  saveNotes: jest.fn(),
  saveLabels: jest.fn(),
  getFailedNoteIds: jest.fn().mockResolvedValue(new Set()),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    useSafeAreaInsets: () => insets,
    SafeAreaInsetsContext: createContext(insets),
  };
});

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
  noteLocalQueryScopeKey: jest.fn(() => ['note-local', 'test-scope']),
  labelsQueryKey: jest.fn(() => ['labels', 'test-scope']),
  labelCountsQueryKey: jest.fn(() => ['label-counts', 'test-scope']),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(() => ({ registration_enabled: true, password_min_length: 10, upload_max_bytes: 26214400 })),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockListSessions = jot.sessions.list as jest.MockedFunction<typeof jot.sessions.list>;
const mockImportFile = importFile as jest.MockedFunction<typeof importFile>;
const mockGetNotes = jot.notes.getAll as jest.MockedFunction<typeof jot.notes.getAll>;
const mockGetLabels = jot.labels.getAll as jest.MockedFunction<typeof jot.labels.getAll>;
const mockGetDocumentAsync = DocumentPicker.getDocumentAsync as jest.MockedFunction<typeof DocumentPicker.getDocumentAsync>;
const mockSaveNotes = saveNotes as jest.MockedFunction<typeof saveNotes>;
const mockSaveLabels = saveLabels as jest.MockedFunction<typeof saveLabels>;

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
    mockGetLabels.mockResolvedValue([]);
    mockSaveLabels.mockResolvedValue(undefined);
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
    mockImportFile.mockResolvedValue({ imported: 2, skipped: 1 });

    const { getByTestId, getByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    await fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText('export.zip')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(mockImportFile).toHaveBeenCalledWith({
        uri: 'file:///tmp/export.zip',
        name: 'export.zip',
        mimeType: 'application/zip',
      }, 'google_keep');
    });
    await waitFor(() => {
      expect(mockGetNotes).toHaveBeenCalled();
      expect(mockSaveNotes).toHaveBeenCalled();
    });
    // An import creates labels as well as notes, so the drawer's label list and
    // its per-label counts have to be re-pulled and refreshed alongside the notes.
    await waitFor(() => {
      expect(mockGetLabels).toHaveBeenCalled();
      expect(mockSaveLabels).toHaveBeenCalled();
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['notes-local', 'test-scope'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['note-local', 'test-scope'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['labels', 'test-scope'] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['label-counts', 'test-scope'] });
    await waitFor(() => {
      expect(getByText(/Imported 2 notes/i)).toBeTruthy();
    });
    expect(getByText(/\(1 skipped\)/i)).toBeTruthy();
  }, SETTINGS_IMPORT_TEST_TIMEOUT_MS);

  it('imports a Jot backup when the Jot format is chosen', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/jot-export.zip', name: 'jot-export.zip', mimeType: 'application/zip' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportFile.mockResolvedValue({ imported: 3, skipped: 0 });

    const { getByTestId, getByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    await fireEvent.press(getByTestId('settings-import-format-jot_json'));
    expect(getByTestId('settings-import-format-jot_json').props.accessibilityState).toMatchObject({ checked: true });
    expect(getByText('.zip files')).toBeTruthy();

    await fireEvent.press(getByTestId('settings-import-select-file'));
    expect(mockGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({
      type: ['application/zip', 'application/x-zip-compressed'],
    }));
    await waitFor(() => {
      expect(getByText('jot-export.zip')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(mockImportFile).toHaveBeenCalledWith({
        uri: 'file:///tmp/jot-export.zip',
        name: 'jot-export.zip',
        mimeType: 'application/zip',
      }, 'jot_json');
    });
    await waitFor(() => {
      expect(getByText(/Imported 3 notes/i)).toBeTruthy();
    });
  }, SETTINGS_IMPORT_TEST_TIMEOUT_MS);

  it('rejects a .json file for the Jot format', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);

    const { getByTestId, getByText, queryByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await fireEvent.press(getByTestId('settings-import-format-jot_json'));
    await fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText('Invalid file type. Please select a .zip file.')).toBeTruthy();
    });
    expect(queryByText('export.json')).toBeNull();
    expect(mockImportFile).not.toHaveBeenCalled();
  });

  it('clears the selected file when the format changes', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.zip', name: 'export.zip', mimeType: 'application/zip' }],
    } as DocumentPicker.DocumentPickerResult);

    const { getByTestId, getByText, queryByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await fireEvent.press(getByTestId('settings-import-select-file'));
    await waitFor(() => {
      expect(getByText('export.zip')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('settings-import-format-jot_json'));

    expect(queryByText('export.zip')).toBeNull();
    await fireEvent.press(getByTestId('settings-import-submit'));
    expect(mockImportFile).not.toHaveBeenCalled();
  });

  it('rejects unsupported files with a validation error', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/notes.txt', name: 'notes.txt', mimeType: 'text/plain' }],
    } as DocumentPicker.DocumentPickerResult);

    const { getByTestId, getByText, queryByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

    await fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText(/Invalid file type/i)).toBeTruthy();
    });
    expect(queryByText('notes.txt')).toBeNull();
    expect(mockImportFile).not.toHaveBeenCalled();
  });

  it('shows API error when import fails', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportFile.mockRejectedValue({ response: { status: 400, data: apiErrorBody('invalid_import_file', 'invalid JSON file') } });

    const { getByTestId, getByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await fireEvent.press(getByTestId('settings-import-select-file'));

    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/could not be read as an export of the selected type/i)).toBeTruthy();
    });
  });

  it('shows fallback error when API error has no response data', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportFile.mockRejectedValue(new Error('network error'));

    const { getByTestId, getByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await fireEvent.press(getByTestId('settings-import-select-file'));
    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });

    await fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/Import failed/i)).toBeTruthy();
    });
  });

  it('shows partial-import error rows when server returns per-note errors', async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/export.json', name: 'export.json', mimeType: 'application/json' }],
    } as DocumentPicker.DocumentPickerResult);
    mockImportFile.mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: ['failed to import "bad note": invalid json'],
    });

    const { getByTestId, getByText } = await render(<SettingsScreen />);

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await fireEvent.press(getByTestId('settings-import-select-file'));
    await waitFor(() => {
      expect(getByText('export.json')).toBeTruthy();
    });
    await fireEvent.press(getByTestId('settings-import-submit'));

    await waitFor(() => {
      expect(getByText(/1 failed/i)).toBeTruthy();
      expect(getByText(/failed to import "bad note": invalid json/i)).toBeTruthy();
    });
  });
});
