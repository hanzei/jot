import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
// Only the interceptors are tested here; the endpoints live in @jot/shared
// and are tested there.
const { mockResponseUse, mockRequestUse, mockLogoutSettled } = vi.hoisted(() => ({
  mockResponseUse: vi.fn(),
  mockRequestUse: vi.fn(),
  mockLogoutSettled: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      interceptors: { response: { use: mockResponseUse }, request: { use: mockRequestUse } },
    })),
  },
}));

vi.mock('../logout', () => ({ logoutSettled: mockLogoutSettled }));

// Import API module after mocking axios; importing it registers the interceptor.
import '../api';
import { getDiagnostics, resetDiagnosticsForTest } from '../diagnostics';

// Captured at import, before any test's vi.clearAllMocks() empties the calls.
const onRequest = mockRequestUse.mock.calls[0]![0] as (config: { url?: string }) => Promise<unknown>;

// Mock localStorage
const mockLocalStorage = {
  removeItem: vi.fn(),
};
Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});

// Mock location
const mockLocation = {
  href: '',
  pathname: '/',
  search: '',
  hash: '',
};
Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true,
});


describe('API Module', () => {
  // Capture the response error handler before any vi.clearAllMocks() runs.
  let errorHandler: (error: unknown) => Promise<never>;
  beforeAll(() => {
    errorHandler = mockResponseUse.mock.calls[0]![1] as (error: unknown) => Promise<never>;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockLocation.href = '';
    mockLocation.pathname = '/';
    mockLocation.search = '';
    mockLocation.hash = '';
  });

  describe('Response Interceptor', () => {

    it('records the failure for diagnostics', async () => {
      resetDiagnosticsForTest();
      const error500 = { config: { method: 'post', url: '/notes' }, response: { status: 500, headers: { 'x-request-id': 'req123' } } };
      await expect(errorHandler(error500)).rejects.toEqual(error500);

      expect(getDiagnostics().failedRequests).toEqual([
        expect.objectContaining({ method: 'POST', route: '/notes', status: 500, requestId: 'req123' }),
      ]);
    });

    it('clears user and redirects to login on 401 error', async () => {
      const error401 = { response: { status: 401 } };
      await expect(errorHandler(error401)).rejects.toEqual(error401);

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user');
      expect(mockLocation.href).toBe('/login');
    });

    it('remembers the current page when a 401 kicks the user out', async () => {
      mockLocation.pathname = '/notes/abc123';
      mockLocation.search = '?label=work';

      const error401 = { response: { status: 401 } };
      await expect(errorHandler(error401)).rejects.toEqual(error401);

      expect(mockLocation.href).toBe('/login?continue=%2Fnotes%2Fabc123%3Flabel%3Dwork');
    });

    it('does not redirect on 401 from GET /users/me', async () => {
      const error401 = { response: { status: 401 }, config: { url: '/users/me', method: 'get' } };
      await expect(errorHandler(error401)).rejects.toEqual(error401);

      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
      expect(mockLocation.href).not.toBe('/login');
    });

    it('still redirects on 401 from PATCH /users/me', async () => {
      const error401 = { response: { status: 401 }, config: { url: '/users/me', method: 'patch' } };
      await expect(errorHandler(error401)).rejects.toEqual(error401);

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('user');
      expect(mockLocation.href).toBe('/login');
    });

    it('does not redirect on 401 from a request that opts out', async () => {
      const error401 = { response: { status: 401 }, config: { url: '/about', skipAuthRedirect: true } };
      await expect(errorHandler(error401)).rejects.toEqual(error401);

      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
      expect(mockLocation.href).not.toBe('/login');
    });

    it('does not redirect for non-401 errors', async () => {
      const error500 = { response: { status: 500 } };
      await expect(errorHandler(error500)).rejects.toEqual(error500);

      expect(mockLocation.href).not.toBe('/login');
    });

    it('does not redirect for network errors without response', async () => {
      const networkError = new Error('Network error');
      await expect(errorHandler(networkError)).rejects.toEqual(networkError);

      expect(mockLocation.href).not.toBe('/login');
    });
  });
});

describe('request interceptor', () => {
  beforeEach(() => {
    mockLogoutSettled.mockReset();
  });

  it.each(['/login', '/register'])('waits for an in-flight logout before %s', async (url) => {
    let finish!: () => void;
    mockLogoutSettled.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

    let sent = false;
    const pending = onRequest({ url }).then(() => { sent = true; });
    await Promise.resolve();
    expect(sent).toBe(false);

    finish();
    await pending;
    expect(sent).toBe(true);
  });

  it('does not wait on other requests', async () => {
    await onRequest({ url: '/notes' });
    expect(mockLogoutSettled).not.toHaveBeenCalled();
  });
});
