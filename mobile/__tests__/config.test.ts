import axios from 'axios';
import { probeServerConfig } from '../src/api/config';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockAxiosGet = axios.get as jest.Mock;

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
