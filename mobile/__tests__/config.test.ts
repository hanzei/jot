import axios from 'axios';
import { fetchServerConfig, probeServerConfig } from '../src/api/config';
import api from '../src/api/client';

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockApiGet = api.get as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;

describe('fetchServerConfig', () => {
  beforeEach(() => {
    mockApiGet.mockClear();
  });

  it('GETs /config through the shared (active-server) client', async () => {
    const config = { registration_enabled: true, password_min_length: 8, upload_max_bytes: 1000 };
    mockApiGet.mockResolvedValue({ data: config });

    await expect(fetchServerConfig()).resolves.toEqual(config);
    expect(mockApiGet).toHaveBeenCalledWith('/config');
  });

  it('propagates a network failure to the caller', async () => {
    mockApiGet.mockRejectedValue(new Error('Network Error'));

    await expect(fetchServerConfig()).rejects.toThrow('Network Error');
  });
});

describe('probeServerConfig', () => {
  beforeEach(() => {
    mockAxiosGet.mockClear();
  });

  it('fetches /api/v1/config directly against the given URL with a short timeout', async () => {
    const config = { registration_enabled: false, password_min_length: 6, upload_max_bytes: 500 };
    mockAxiosGet.mockResolvedValue({ data: config });

    const result = await probeServerConfig('https://Example.com');

    expect(result).toEqual(config);
    expect(mockAxiosGet).toHaveBeenCalledWith('https://example.com/api/v1/config', { timeout: 5000 });
  });

  it('returns null for an invalid URL without making a request', async () => {
    const result = await probeServerConfig('not a url');

    expect(result).toBeNull();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('returns null when the server is unreachable', async () => {
    mockAxiosGet.mockRejectedValue(new Error('Network Error'));

    const result = await probeServerConfig('https://example.com');

    expect(result).toBeNull();
  });
});
