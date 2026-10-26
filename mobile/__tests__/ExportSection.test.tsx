import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import ExportSection from '../src/screens/settings/ExportSection';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import { downloadExportBundle, EXPORT_BUNDLE_RETENTION_MS, EXPORT_STALL_TIMEOUT_MS } from '../src/api/export';
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

/**
 * Make the next download hang, writing a partial file, until its signal aborts.
 * Returns the options the download was called with once it has started.
 */
function mockHangingDownload(): { options: () => { signal: AbortSignal; onProgress: () => void } | undefined } {
  let captured: { signal: AbortSignal; onProgress: () => void } | undefined;
  mockDownload.mockImplementationOnce((_url: string, destination: { uri: string }, options: {
    signal: AbortSignal;
    onProgress: () => void;
  }) => {
    captured = options;
    globalThis.mockFileSystem.files.set(destination.uri, 'partial');
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    });
  });
  return { options: () => captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.mockFileSystem.reset();
});

describe('ExportSection', () => {
  beforeEach(() => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    markServerReachable();
    mockIsAvailableAsync.mockResolvedValue(true);
    mockShareAsync.mockResolvedValue(undefined);
  });

  it('downloads the bundle with the session cookie and shares it, keeping it for the receiving app', async () => {
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
    // Kept: the picked app may still be reading it; the next export clears it.
    expect(exportFiles()).toEqual([sharedUri]);
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

  it('cancels the download without an error or share when the section unmounts', async () => {
    const download = mockHangingDownload();

    const { getByTestId, unmount } = await render(<ExportSection />);
    const pressed = fireEvent.press(getByTestId('settings-export-submit'));
    await waitFor(() => expect(download.options()).toBeDefined());

    await unmount();
    await act(async () => {
      await pressed;
    });

    expect(download.options()!.signal.aborted).toBe(true);
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(exportFiles()).toEqual([]);
  });

  it('is disabled while the server is unreachable and re-enables once it is reachable', async () => {
    markServerUnreachable();

    const { getByTestId, queryByTestId } = await render(<ExportSection />);
    expect(getByTestId('settings-export-offline')).toBeTruthy();
    expect(getByTestId('settings-export-submit').props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => {
      markServerReachable();
    });

    expect(queryByTestId('settings-export-offline')).toBeNull();
    expect(getByTestId('settings-export-submit').props.accessibilityState).toMatchObject({ disabled: false });
  });

});

describe('downloadExportBundle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears expired and unrecognized bundles but keeps a recently shared one', async () => {
    const now = Date.now();
    const name = (ageMs: number) =>
      `${EXPORT_DIR}/jot-export-${new Date(now - ageMs).toISOString().replace(/[:.]/g, '-')}.zip`;
    const recent = name(EXPORT_BUNDLE_RETENTION_MS - 60_000);
    globalThis.mockFileSystem.dirs.add(EXPORT_DIR);
    globalThis.mockFileSystem.files.set(recent, 'shared a minute before expiry');
    globalThis.mockFileSystem.files.set(name(EXPORT_BUNDLE_RETENTION_MS + 60_000), 'expired');
    globalThis.mockFileSystem.files.set(`${EXPORT_DIR}/something-else.zip`, 'unrecognized');

    const uri = await downloadExportBundle();

    expect(exportFiles().sort()).toEqual([recent, uri].sort());
  });

  it('aborts a download that stalls, but not one that keeps making progress', async () => {
    jest.useFakeTimers();
    const download = mockHangingDownload();

    const pending = downloadExportBundle();
    const settled = pending.catch((err: unknown) => err);
    await waitFor(() => expect(download.options()).toBeDefined());
    const { signal, onProgress } = download.options()!;

    // Progress keeps resetting the stall timer.
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(EXPORT_STALL_TIMEOUT_MS - 1000);
      onProgress();
    }
    expect(signal.aborted).toBe(false);

    jest.advanceTimersByTime(EXPORT_STALL_TIMEOUT_MS);
    expect(signal.aborted).toBe(true);
    expect(await settled).toEqual(new Error('AbortError'));
    expect(exportFiles()).toEqual([]);
  });
});
