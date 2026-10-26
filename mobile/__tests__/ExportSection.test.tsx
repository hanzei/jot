import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import ExportSection from '../src/screens/settings/ExportSection';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import { downloadExportBundle, EXPORT_STALL_TIMEOUT_MS } from '../src/api/export';
import { silenceConsole } from './helpers/consoleGuard';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  getStoredSession: jest.fn().mockResolvedValue('session-token'),
}));

const mockIsAvailableAsync = Sharing.isAvailableAsync as jest.MockedFunction<typeof Sharing.isAvailableAsync>;
const mockShareAsync = Sharing.shareAsync as jest.MockedFunction<typeof Sharing.shareAsync>;
const mockUseNetworkStatus = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;
const mockDownload = globalThis.mockFileSystem.downloadFileAsync as jest.Mock;

const EXPORT_DIR = 'file:///cache/exports';

function exportFiles(): string[] {
  return [...globalThis.mockFileSystem.files.keys()].filter((uri) => uri.startsWith(`${EXPORT_DIR}/`));
}

describe('ExportSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.mockFileSystem.reset();
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    markServerReachable();
    mockIsAvailableAsync.mockResolvedValue(true);
    mockShareAsync.mockResolvedValue(undefined);
  });

  it('downloads the bundle with the session cookie, shares it, then deletes it', async () => {
    let sharedUri = '';
    mockShareAsync.mockImplementation(async (uri) => {
      sharedUri = uri;
      // The file must still be there while the share sheet is open.
      expect(exportFiles()).toEqual([uri]);
    });

    const { getByTestId, queryByTestId } = await render(<ExportSection />);
    await fireEvent.press(getByTestId('settings-export-submit'));

    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    expect(mockDownload).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/notes/export',
      expect.objectContaining({ uri: sharedUri }),
      expect.objectContaining({ idempotent: true, headers: { Cookie: 'jot_session=session-token' } }),
    );
    expect(sharedUri).toMatch(/^file:\/\/\/cache\/exports\/jot-export-.*\.zip$/);
    expect(mockShareAsync).toHaveBeenCalledWith(sharedUri, expect.objectContaining({ mimeType: 'application/zip' }));
    await waitFor(() => expect(exportFiles()).toEqual([]));
    expect(queryByTestId('settings-export-error')).toBeNull();
  });

  it('shows a pending state while the download runs', async () => {
    let finish: () => void = () => {};
    mockDownload.mockImplementationOnce((_url: string, destination: { uri: string }) => new Promise((resolve) => {
      finish = () => {
        globalThis.mockFileSystem.files.set(destination.uri, '');
        resolve(destination);
      };
    }));

    const { getByTestId, getByText } = await render(<ExportSection />);
    // The press settles only once the handler does, so release the download
    // before awaiting it.
    const pressed = fireEvent.press(getByTestId('settings-export-submit'));

    await waitFor(() => expect(getByText('Exporting...')).toBeTruthy());
    expect(getByTestId('settings-export-submit').props.accessibilityState).toMatchObject({ disabled: true, busy: true });

    await act(async () => {
      finish();
      await pressed;
    });
    expect(getByText('Export notes')).toBeTruthy();
  });

  it('shows an error and leaves no partial file when the download fails', async () => {
    silenceConsole('warn', /Notes export download failed/);
    mockDownload.mockImplementationOnce((_url: string, destination: { uri: string }) => {
      globalThis.mockFileSystem.files.set(destination.uri, 'partial');
      return Promise.reject(new Error('HTTP 500'));
    });

    const { getByTestId, findByTestId } = await render(<ExportSection />);
    await fireEvent.press(getByTestId('settings-export-submit'));

    expect((await findByTestId('settings-export-error')).props.children).toBe('Export failed. Please try again.');
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(exportFiles()).toEqual([]);
  });

  it('deletes the bundle when the share sheet fails', async () => {
    silenceConsole('warn', /Notes export share failed/);
    mockShareAsync.mockRejectedValueOnce(new Error('no activity'));

    const { getByTestId, findByTestId } = await render(<ExportSection />);
    await fireEvent.press(getByTestId('settings-export-submit'));

    expect((await findByTestId('settings-export-error')).props.children)
      .toBe('Could not open the share sheet. Please try again.');
    expect(exportFiles()).toEqual([]);
  });

  it('does not download when sharing is unavailable', async () => {
    mockIsAvailableAsync.mockResolvedValueOnce(false);

    const { getByTestId, findByTestId } = await render(<ExportSection />);
    await fireEvent.press(getByTestId('settings-export-submit'));

    expect((await findByTestId('settings-export-error')).props.children)
      .toBe('Sharing files is not available on this device.');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('is disabled while the device is offline', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    const { getByTestId } = await render(<ExportSection />);

    expect(getByTestId('settings-export-offline')).toBeTruthy();
    expect(getByTestId('settings-export-submit').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(getByTestId('settings-export-submit'));
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('is disabled while the server is unreachable', async () => {
    markServerUnreachable();

    const { getByTestId } = await render(<ExportSection />);

    expect(getByTestId('settings-export-offline')).toBeTruthy();
    expect(getByTestId('settings-export-submit').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('downloadExportBundle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.mockFileSystem.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears bundles left behind by an earlier export', async () => {
    globalThis.mockFileSystem.dirs.add(EXPORT_DIR);
    globalThis.mockFileSystem.files.set(`${EXPORT_DIR}/jot-export-old.zip`, 'stale');

    const uri = await downloadExportBundle();

    expect(exportFiles()).toEqual([uri]);
  });

  it('aborts a download that stalls, but not one that keeps making progress', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    let onProgress: () => void = () => {};
    mockDownload.mockImplementationOnce((_url: string, _destination: unknown, options: {
      signal: AbortSignal;
      onProgress: () => void;
    }) => {
      signal = options.signal;
      onProgress = options.onProgress;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    });

    const pending = downloadExportBundle();
    const settled = pending.catch((err: unknown) => err);
    await waitFor(() => expect(signal).toBeDefined());

    // Progress keeps resetting the stall timer.
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(EXPORT_STALL_TIMEOUT_MS - 1000);
      onProgress();
    }
    expect(signal!.aborted).toBe(false);

    jest.advanceTimersByTime(EXPORT_STALL_TIMEOUT_MS);
    expect(signal!.aborted).toBe(true);
    expect(await settled).toEqual(new Error('AbortError'));
    expect(exportFiles()).toEqual([]);
  });
});
