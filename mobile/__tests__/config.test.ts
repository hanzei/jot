import axios from 'axios';
import { probeServerConfig, serverRequiresHttpsSession } from '../src/api/config';

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
    mockAxiosGet.mockImplementation(async (_url: string, opts: { headers: Record<string, string> }) => ({
      data: config,
      headers: { 'x-request-id': opts.headers['X-Request-Id'] },
    }));

    const result = await probeServerConfig('https://Example.com');

    expect(result).toEqual(config);
    expect(mockAxiosGet).toHaveBeenCalledWith('https://example.com/api/v1/config', {
      timeout: 5000,
      headers: { 'X-Request-Id': expect.any(String) },
    });
  });

  it('returns null for a 200 that does not echo the request ID, such as a captive portal page (#1266)', async () => {
    mockAxiosGet.mockResolvedValue({ data: '<html>Sign in to Wi-Fi</html>', headers: {} });

    const result = await probeServerConfig('https://example.com');

    expect(result).toBeNull();
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

describe('serverRequiresHttpsSession (#1337)', () => {
  function serveConfig(config: Record<string, unknown>) {
    mockAxiosGet.mockImplementation(async (_url: string, opts: { headers: Record<string, string> }) => ({
      data: config,
      headers: { 'x-request-id': opts.headers['X-Request-Id'] },
    }));
  }

  beforeEach(() => {
    mockAxiosGet.mockReset();
  });

  it('is true for a plain-HTTP server whose cookie is Secure', async () => {
    serveConfig({ cookie_secure: true });
    await expect(serverRequiresHttpsSession('http://jot.lan:8080')).resolves.toBe(true);
  });

  it('is false for a plain-HTTP server with JOT_COOKIE_SECURE=false', async () => {
    serveConfig({ cookie_secure: false });
    await expect(serverRequiresHttpsSession('http://jot.lan:8080')).resolves.toBe(false);
  });

  it('is false for an older server that does not report cookie_secure', async () => {
    serveConfig({ registration_enabled: true });
    await expect(serverRequiresHttpsSession('http://jot.lan:8080')).resolves.toBe(false);
  });

  it('is false when the config cannot be read', async () => {
    mockAxiosGet.mockRejectedValue(new Error('Network Error'));
    await expect(serverRequiresHttpsSession('http://jot.lan:8080')).resolves.toBe(false);
  });

  it('does not ask an https:// or loopback server', async () => {
    serveConfig({ cookie_secure: true });
    await expect(serverRequiresHttpsSession('https://jot.example.com')).resolves.toBe(false);
    await expect(serverRequiresHttpsSession('http://localhost:8080')).resolves.toBe(false);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
