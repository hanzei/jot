import { renderHook, waitFor } from '@testing-library/react-native';
import { useServerConfig } from '../src/hooks/useServerConfig';
import { DEFAULT_SERVER_CONFIG, fetchServerConfig } from '../src/api/config';
import { getActiveServerId, getStoredServerUrl } from '../src/api/client';
import { getServerStorageValue, setServerStorageValue } from '../src/store/serverAccounts';

jest.mock('../src/api/config', () => ({
  DEFAULT_SERVER_CONFIG: { registration_enabled: true, password_min_length: 10, upload_max_bytes: 26214400 },
  fetchServerConfig: jest.fn(),
}));
jest.mock('../src/api/client', () => ({
  getActiveServerId: jest.fn(),
  getStoredServerUrl: jest.fn(),
}));
jest.mock('../src/store/serverAccounts', () => ({
  getServerStorageValue: jest.fn(),
  setServerStorageValue: jest.fn(),
}));

const mockFetchServerConfig = fetchServerConfig as jest.MockedFunction<typeof fetchServerConfig>;
const mockGetActiveServerId = getActiveServerId as jest.MockedFunction<typeof getActiveServerId>;
const mockGetStoredServerUrl = getStoredServerUrl as jest.MockedFunction<typeof getStoredServerUrl>;
const mockGetServerStorageValue = getServerStorageValue as jest.MockedFunction<typeof getServerStorageValue>;
const mockSetServerStorageValue = setServerStorageValue as jest.MockedFunction<typeof setServerStorageValue>;

describe('useServerConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStoredServerUrl.mockResolvedValue('https://example.com');
    mockGetActiveServerId.mockReturnValue('server-1');
    mockGetServerStorageValue.mockResolvedValue(null);
    mockSetServerStorageValue.mockResolvedValue(undefined);
  });

  it('applies a cached value before the network call resolves', async () => {
    const cached = { registration_enabled: true, password_min_length: 6, upload_max_bytes: 1024 };
    mockGetServerStorageValue.mockResolvedValue(JSON.stringify(cached));
    mockFetchServerConfig.mockReturnValue(new Promise(() => {})); // never resolves in this test

    const { result } = await renderHook(() => useServerConfig());

    await waitFor(() => expect(result.current).toEqual(cached));
  });

  it('updates with the fresh value once fetched, and caches it for the active server', async () => {
    const fresh = { registration_enabled: false, password_min_length: 12, upload_max_bytes: 2048 };
    mockFetchServerConfig.mockResolvedValue(fresh);

    const { result } = await renderHook(() => useServerConfig());

    await waitFor(() => expect(result.current).toEqual(fresh));
    expect(mockSetServerStorageValue).toHaveBeenCalledWith('server-1', 'server_config', JSON.stringify(fresh));
  });

  it('does not fetch when there is no active server yet', async () => {
    mockGetActiveServerId.mockReturnValue(null);

    await renderHook(() => useServerConfig());

    await waitFor(() => expect(mockGetStoredServerUrl).toHaveBeenCalled());
    expect(mockFetchServerConfig).not.toHaveBeenCalled();
  });

  it('keeps the cached/default value when the fetch fails (offline auth screen)', async () => {
    mockFetchServerConfig.mockRejectedValue(new Error('network error'));

    const { result } = await renderHook(() => useServerConfig());

    await waitFor(() => expect(mockFetchServerConfig).toHaveBeenCalled());
    expect(result.current).toEqual(DEFAULT_SERVER_CONFIG);
  });

  it('ignores a malformed cache entry and keeps the default', async () => {
    mockGetServerStorageValue.mockResolvedValue('not-json');
    mockFetchServerConfig.mockReturnValue(new Promise(() => {}));

    const { result } = await renderHook(() => useServerConfig());

    await waitFor(() => expect(mockGetServerStorageValue).toHaveBeenCalled());
    expect(result.current).toEqual(DEFAULT_SERVER_CONFIG);
  });
});
