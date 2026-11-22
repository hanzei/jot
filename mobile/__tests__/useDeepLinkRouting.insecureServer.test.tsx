import React from 'react';
import { Linking } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import type { NavigationContainerRef } from '@react-navigation/native';
import { useDeepLinkRouting } from '../src/hooks/useDeepLinkRouting';
import { ConfirmContext, type ConfirmOptions } from '../src/hooks/useConfirm';
import { addServer } from '../src/store/serverAccounts';
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

describe('useDeepLinkRouting and an unknown http:// server (#1337)', () => {
  let urlHandler: ((event: { url: string }) => void) | null;
  const confirm = jest.fn<Promise<boolean>, [ConfirmOptions]>();

  beforeEach(() => {
    jest.clearAllMocks();
    urlHandler = null;
    confirm.mockResolvedValue(false);
    jest.spyOn(Linking, 'addEventListener').mockImplementation(((_type: string, handler: (event: { url: string }) => void) => {
      urlHandler = handler;
      return { remove: jest.fn() };
    }) as unknown as typeof Linking.addEventListener);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function openLink(url: string) {
    const navigationRef = { isReady: () => false } as unknown as NavigationContainerRef<RootStackParamList>;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConfirmContext.Provider value={{ confirm }}>{children}</ConfirmContext.Provider>
    );
    const { result } = await renderHook(() => useDeepLinkRouting({
      navigationRef,
      isNavReady: false,
      isAuthenticated: true,
      revalidateSession: jest.fn(),
    }), { wrapper });
    result.current.linking.subscribe?.(jest.fn());
    urlHandler?.({ url });
    await flush();
  }

  it('warns about plain HTTP in the add-server prompt', async () => {
    await openLink(`jot://notes/abc?server=${encodeURIComponent('http://jot.lan:8080')}`);

    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0]![0];
    expect(options.message).toContain('serverSecurity.insecureMessage');
    expect(options.confirmLabel).toBe('serverSecurity.insecureConfirm');
    expect(options.destructive).toBe(true);
    // Declined: the server is not added.
    expect(addServer).not.toHaveBeenCalled();
  });

  it('asks without the warning for an https:// server', async () => {
    await openLink(`jot://notes/abc?server=${encodeURIComponent('https://other.example.com')}`);

    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0]![0];
    expect(options.message).not.toContain('serverSecurity.insecureMessage');
    expect(options.confirmLabel).toBe('deepLink.addAndSwitchAction');
    expect(options.destructive).toBe(false);
  });
});
