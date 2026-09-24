import * as WebBrowser from 'expo-web-browser';
import { getBaseUrl } from '../src/api/client';
import { computeCodeChallenge } from '../src/utils/pkce';
import {
  isOidcFlowPending,
  oidcCallbackErrorMessageKey,
  oidcExchangeErrorMessage,
  oidcLinkErrorMessage,
  oidcUnlinkErrorMessage,
  resetOidcFlowForTests,
  resolveOidcCallback,
  runOidcBrowserFlow,
} from '../src/store/oidcFlow';

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(),
}));

const mockOpenAuthSession = WebBrowser.openAuthSessionAsync as jest.Mock;
const mockGetBaseUrl = getBaseUrl as jest.Mock;

const SERVER = 'https://jot.example.com';

function startUrlParams(): URLSearchParams {
  const startUrl = mockOpenAuthSession.mock.calls.at(-1)?.[0] as string;
  return new URL(startUrl).searchParams;
}

describe('oidcFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOidcFlowForTests();
    mockGetBaseUrl.mockReturnValue(SERVER);
  });

  describe('runOidcBrowserFlow', () => {
    it.each(['login', 'link'] as const)('opens native/start for intent=%s with an S256 challenge of the returned verifier', async (intent) => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: 'jot://oidc-callback?code=abc123' });

      const outcome = await runOidcBrowserFlow(intent);

      const startUrl = mockOpenAuthSession.mock.calls[0]?.[0] as string;
      expect(startUrl.startsWith(`${SERVER}/api/v1/auth/oidc/native/start?`)).toBe(true);
      expect(mockOpenAuthSession.mock.calls[0]?.[1]).toBe('jot://oidc-callback');
      expect(startUrlParams().get('intent')).toBe(intent);
      expect(outcome.type).toBe('code');
      if (outcome.type !== 'code') return;
      expect(outcome.code).toBe('abc123');
      expect(outcome.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(startUrlParams().get('code_challenge')).toBe(await computeCodeChallenge(outcome.codeVerifier));
      // The verifier never travels in the start URL.
      expect(startUrl).not.toContain(outcome.codeVerifier);
      expect(isOidcFlowPending()).toBe(false);
    });

    it('decodes a percent-encoded code', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: 'jot://oidc-callback?code=a%2Fb%3Dc&x=1' });

      const outcome = await runOidcBrowserFlow('login');

      expect(outcome).toEqual(expect.objectContaining({ type: 'code', code: 'a/b=c' }));
    });

    it.each(['cancel', 'dismiss', 'opened', 'locked'])('treats a %s result as a quiet cancellation', async (type) => {
      mockOpenAuthSession.mockResolvedValueOnce({ type });

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'cancelled' });
      expect(isOidcFlowPending()).toBe(false);
    });

    it.each([
      ['access_denied', 'auth.ssoCancelled'],
      ['temporarily_unavailable', 'auth.ssoTryAgainLater'],
      ['idp_error', 'auth.ssoFailed'],
      ['invalid_request', 'auth.ssoFailed'],
      ['authentication_failed', 'auth.ssoFailed'],
      ['server_error', 'auth.ssoFailed'],
      ['something_new', 'auth.ssoFailed'],
    ])('maps ?error=%s to %s', async (error, messageKey) => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: `jot://oidc-callback?error=${error}` });

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'error', messageKey });
    });

    it('fails a callback that carries neither code nor error', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: 'jot://oidc-callback' });

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'error', messageKey: 'auth.ssoFailed' });
    });

    it('refuses to hand back a code when the active server changed mid-flow', async () => {
      mockOpenAuthSession.mockImplementationOnce(async () => {
        mockGetBaseUrl.mockReturnValue('https://other.example.com');
        return { type: 'success', url: 'jot://oidc-callback?code=abc123' };
      });

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'error', messageKey: 'auth.ssoServerChanged' });
    });

    it('turns a browser failure into a terminal error', async () => {
      mockOpenAuthSession.mockRejectedValueOnce(new Error('no browser'));

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'error', messageKey: 'auth.ssoFailed' });
      expect(isOidcFlowPending()).toBe(false);
    });

    it('does not start a second flow while one is pending', async () => {
      let finish: (value: unknown) => void = () => {};
      mockOpenAuthSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

      const first = runOidcBrowserFlow('login');
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(isOidcFlowPending()).toBe(true);

      await expect(runOidcBrowserFlow('login')).resolves.toEqual({ type: 'cancelled' });
      expect(mockOpenAuthSession).toHaveBeenCalledTimes(1);

      finish({ type: 'success', url: 'jot://oidc-callback?code=first' });
      await expect(first).resolves.toEqual(expect.objectContaining({ type: 'code', code: 'first' }));
    });
  });

  describe('resolveOidcCallback', () => {
    it('ignores a callback when no flow is pending (injected redirect)', () => {
      expect(resolveOidcCallback('jot://oidc-callback?code=injected')).toBeNull();
    });

    it('ignores a callback once the flow has completed', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: 'jot://oidc-callback?code=first' });
      await runOidcBrowserFlow('login');

      expect(resolveOidcCallback('jot://oidc-callback?code=replayed')).toBeNull();
    });

    it('ignores URLs that are not the callback', () => {
      expect(resolveOidcCallback('jot://notes/abc?code=x')).toBeNull();
    });
  });

  describe('error messages', () => {
    it('maps callback error codes', () => {
      expect(oidcCallbackErrorMessageKey('access_denied')).toBe('auth.ssoCancelled');
      expect(oidcCallbackErrorMessageKey('temporarily_unavailable')).toBe('auth.ssoTryAgainLater');
      expect(oidcCallbackErrorMessageKey('server_error')).toBe('auth.ssoFailed');
    });

    it('maps exchange failures', () => {
      expect(oidcExchangeErrorMessage(new Error('Network Error'))).toBe('auth.unableToConnect');
      expect(oidcExchangeErrorMessage({ response: { status: 400, data: 'invalid or expired code' } })).toBe('auth.ssoFailed');
      expect(oidcExchangeErrorMessage({ response: { status: 403, data: 'account disabled' } })).toBe('account disabled');
      expect(oidcExchangeErrorMessage({ response: { status: 500 } })).toBe('auth.ssoFailed');
    });

    it('maps link failures', () => {
      expect(oidcLinkErrorMessage({ response: { status: 409 } })).toBe('settings.ssoLinkConflict');
      expect(oidcLinkErrorMessage({ response: { status: 403 } })).toBe('settings.ssoLinkUnavailable');
      expect(oidcLinkErrorMessage({ response: { status: 400 } })).toBe('settings.ssoLinkFailed');
      expect(oidcLinkErrorMessage(new Error('timeout'))).toBe('auth.unableToConnect');
    });

    it('maps unlink failures, keeping the strand guard distinct', () => {
      expect(oidcUnlinkErrorMessage({ response: { status: 422, data: 'cannot unlink SSO' } })).toBe('settings.ssoUnlinkWouldStrand');
      expect(oidcUnlinkErrorMessage({ response: { status: 500, data: 'boom' } })).toBe('boom');
      expect(oidcUnlinkErrorMessage({ response: { status: 500 } })).toBe('settings.ssoDisconnectFailed');
    });
  });
});
