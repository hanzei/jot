import { Alert, Linking } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import type { NavigationContainerRef } from '@react-navigation/native';
import { useDeepLinkRouting } from '../src/hooks/useDeepLinkRouting';
import { setPendingDeepLink } from '../src/store/pendingDeepLink';
import type { RootStackParamList } from '../src/navigation/RootNavigator';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/api/client', () => ({
  getActiveServerId: jest.fn(() => 'server-1'),
  getBaseUrl: jest.fn(() => 'https://jot.example.com'),
  getStoredServerUrl: jest.fn().mockResolvedValue('https://jot.example.com'),
  isServerSwitchInProgress: jest.fn(() => false),
  switchActiveServer: jest.fn(),
}));

jest.mock('../src/store/serverAccounts', () => ({
  addServer: jest.fn(),
  listServers: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/store/pendingDeepLink', () => ({
  clearPendingDeepLink: jest.fn().mockResolvedValue(undefined),
  consumePendingDeepLink: jest.fn().mockResolvedValue(undefined),
  getPendingDeepLink: jest.fn().mockResolvedValue(null),
  setPendingDeepLink: jest.fn().mockResolvedValue(undefined),
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

function renderRouting(isAuthenticated: boolean) {
  const navigationRef = { isReady: () => false } as unknown as NavigationContainerRef<RootStackParamList>;
  return renderHook(() => useDeepLinkRouting({
    navigationRef,
    isNavReady: false,
    isAuthenticated,
    revalidateSession: jest.fn(),
  }));
}

describe('useDeepLinkRouting and the SSO callback', () => {
  let urlHandler: ((event: { url: string }) => void) | null;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    urlHandler = null;
    jest.spyOn(Linking, 'addEventListener').mockImplementation(((_type: string, handler: (event: { url: string }) => void) => {
      urlHandler = handler;
      return { remove: jest.fn() };
    }) as unknown as typeof Linking.addEventListener);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not treat a cold-start oidc-callback as the initial route', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('jot://oidc-callback?code=abc');
    const { result } = await renderRouting(false);

    await expect(result.current.linking.getInitialURL?.()).resolves.toBeNull();
    expect(setPendingDeepLink).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it.each([true, false])('never routes, stashes, or warns about an oidc-callback URL event (authenticated=%s)', async (isAuthenticated) => {
    const { result } = await renderRouting(isAuthenticated);
    const listener = jest.fn();
    const unsubscribe = result.current.linking.subscribe?.(listener);

    urlHandler?.({ url: 'jot://oidc-callback?code=abc' });
    urlHandler?.({ url: 'jot://oidc-callback?error=access_denied' });
    await flush();

    expect(listener).not.toHaveBeenCalled();
    expect(setPendingDeepLink).not.toHaveBeenCalled();
    // A normal link without ?server= would warn (see the control below).
    expect(alertSpy).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it('still routes a note link (control)', async () => {
    const { result } = await renderRouting(true);
    const listener = jest.fn();
    result.current.linking.subscribe?.(listener);

    urlHandler?.({ url: 'jot://notes/abc' });
    await flush();

    expect(listener).toHaveBeenCalledWith('jot://notes/abc');
    expect(alertSpy).toHaveBeenCalledWith('deepLink.missingServerTitle', expect.any(String));
  });
});
