import { act, fireEvent, render } from '@testing-library/react-native';
import type { ServerConfig, User } from '@jot/shared';
import SsoSection from '../src/screens/settings/SsoSection';
import { useAuth } from '../src/store/AuthContext';
import { useServerConfig } from '../src/hooks/useServerConfig';
import { ConfirmContext } from '../src/hooks/useConfirm';
import { auth } from '../src/api/client';
import { runOidcBrowserFlow } from '../src/store/oidcFlow';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  auth: {
    oidcNativeLink: jest.fn(),
    oidcUnlink: jest.fn(),
  },
}));

jest.mock('../src/store/oidcFlow', () => ({
  ...jest.requireActual('../src/store/oidcFlow'),
  runOidcBrowserFlow: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.provider ? `${key}:${String(options.provider)}` : key,
  }),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseServerConfig = useServerConfig as jest.MockedFunction<typeof useServerConfig>;
const mockLink = auth.oidcNativeLink as jest.Mock;
const mockUnlink = auth.oidcUnlink as jest.Mock;
const mockRunFlow = runOidcBrowserFlow as jest.Mock;

const baseConfig: ServerConfig = { registration_enabled: true, password_min_length: 10, upload_max_bytes: 1024 };
const mixedMode: ServerConfig = { ...baseConfig, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: true } };
const ssoOnly: ServerConfig = { ...baseConfig, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: false } };

const baseUser: User = {
  id: 'u1', username: 'alice', first_name: '', last_name: '', role: 'user',
  has_profile_icon: false, created_at: '', updated_at: '',
};

const setUser = jest.fn();
const revalidateSession = jest.fn();
const confirm = jest.fn();

async function renderSection(config: ServerConfig, user: User) {
  mockUseServerConfig.mockReturnValue(config);
  mockUseAuth.mockReturnValue({ user, setUser, revalidateSession } as unknown as ReturnType<typeof useAuth>);
  return render(
    <ConfirmContext.Provider value={{ confirm }}>
      <SsoSection />
    </ConfirmContext.Provider>,
  );
}

async function press(element: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(element);
  });
}

describe('SsoSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    revalidateSession.mockResolvedValue(true);
    confirm.mockResolvedValue(true);
  });

  it.each([
    ['no sso block', baseConfig],
    ['sso disabled', { ...baseConfig, sso: { enabled: false, provider_name: 'SSO', local_login_enabled: true } }],
  ])('renders nothing with %s', async (_label, config) => {
    const { queryByTestId } = await renderSection(config, { ...baseUser, has_sso_linked: true });
    expect(queryByTestId('settings-sso-section')).toBeNull();
  });

  it('offers Connect for an unlinked account in mixed mode', async () => {
    const { getByTestId, queryByTestId } = await renderSection(mixedMode, baseUser);

    expect(getByTestId('settings-sso-connect')).toHaveTextContent('settings.ssoConnect:Keycloak');
    expect(getByTestId('settings-sso-description')).toHaveTextContent('settings.ssoUnlinkedDescription:Keycloak');
    expect(queryByTestId('settings-sso-disconnect')).toBeNull();
  });

  it('offers Disconnect for a linked account', async () => {
    const { getByTestId, queryByTestId } = await renderSection(mixedMode, { ...baseUser, has_sso_linked: true });

    expect(getByTestId('settings-sso-disconnect')).toHaveTextContent('settings.ssoDisconnect:Keycloak');
    expect(queryByTestId('settings-sso-connect')).toBeNull();
  });

  it('hides Connect when the server has local login disabled (the server refuses linking)', async () => {
    const { queryByTestId } = await renderSection(ssoOnly, baseUser);
    expect(queryByTestId('settings-sso-connect')).toBeNull();
    expect(queryByTestId('settings-sso-section')).toBeNull();
  });

  it('hides Disconnect in SSO-only mode (unlinking would orphan the account)', async () => {
    const { getByTestId, queryByTestId } = await renderSection(ssoOnly, { ...baseUser, has_sso_linked: true });
    expect(getByTestId('settings-sso-description')).toHaveTextContent('settings.ssoLinkedDescription:Keycloak');
    expect(queryByTestId('settings-sso-disconnect')).toBeNull();
    expect(queryByTestId('settings-sso-connect')).toBeNull();
  });

  it('links through the browser flow and refreshes /me', async () => {
    mockRunFlow.mockResolvedValue({ type: 'code', code: 'link-code', codeVerifier: 'link-verifier' });
    mockLink.mockResolvedValue(undefined);
    const { getByTestId } = await renderSection(mixedMode, baseUser);

    await press(getByTestId('settings-sso-connect'));

    expect(mockRunFlow).toHaveBeenCalledWith('link');
    expect(mockLink).toHaveBeenCalledWith('link-code', 'link-verifier');
    expect(setUser).toHaveBeenCalledTimes(1);
    const updater = setUser.mock.calls[0]?.[0] as (prev: User | null) => User | null;
    expect(updater(baseUser)).toEqual({ ...baseUser, has_sso_linked: true });
    expect(revalidateSession).toHaveBeenCalled();
    expect(getByTestId('settings-sso-success')).toHaveTextContent('settings.ssoConnected');
  });

  it('returns quietly when the browser sheet is dismissed', async () => {
    mockRunFlow.mockResolvedValue({ type: 'cancelled' });
    const { getByTestId, queryByTestId } = await renderSection(mixedMode, baseUser);

    await press(getByTestId('settings-sso-connect'));

    expect(mockLink).not.toHaveBeenCalled();
    expect(queryByTestId('settings-sso-error')).toBeNull();
    expect(getByTestId('settings-sso-connect').props.accessibilityState).toEqual({ disabled: false, busy: false });
  });

  it('shows a callback error without calling the server', async () => {
    mockRunFlow.mockResolvedValue({ type: 'error', messageKey: 'auth.ssoCancelled' });
    const { getByTestId } = await renderSection(mixedMode, baseUser);

    await press(getByTestId('settings-sso-connect'));

    expect(mockLink).not.toHaveBeenCalled();
    expect(getByTestId('settings-sso-error')).toHaveTextContent('auth.ssoCancelled');
  });

  it.each([
    [409, 'settings.ssoLinkConflict'],
    [403, 'settings.ssoLinkUnavailable'],
    [400, 'settings.ssoLinkFailed'],
  ])('surfaces a link %i as %s and leaves the account unlinked', async (status, message) => {
    mockRunFlow.mockResolvedValue({ type: 'code', code: 'c', codeVerifier: 'v' });
    mockLink.mockRejectedValue({ response: { status, data: 'server text' } });
    const { getByTestId } = await renderSection(mixedMode, baseUser);

    await press(getByTestId('settings-sso-connect'));

    expect(getByTestId('settings-sso-error')).toHaveTextContent(message);
    expect(setUser).not.toHaveBeenCalled();
  });

  it('unlinks after confirmation and refreshes /me', async () => {
    mockUnlink.mockResolvedValue(undefined);
    const { getByTestId } = await renderSection(mixedMode, { ...baseUser, has_sso_linked: true });

    await press(getByTestId('settings-sso-disconnect'));

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(mockUnlink).toHaveBeenCalled();
    const updater = setUser.mock.calls[0]?.[0] as (prev: User | null) => User | null;
    expect(updater({ ...baseUser, has_sso_linked: true })).toEqual({ ...baseUser, has_sso_linked: false });
    expect(revalidateSession).toHaveBeenCalled();
    expect(getByTestId('settings-sso-success')).toHaveTextContent('settings.ssoDisconnected');
  });

  it('does nothing when the confirmation is declined', async () => {
    confirm.mockResolvedValue(false);
    const { getByTestId } = await renderSection(mixedMode, { ...baseUser, has_sso_linked: true });

    await press(getByTestId('settings-sso-disconnect'));

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('surfaces the strand guard when unlinking would lock the account out', async () => {
    mockUnlink.mockRejectedValue({ response: { status: 422, data: 'cannot unlink SSO: set a password first' } });
    const { getByTestId } = await renderSection(mixedMode, { ...baseUser, has_sso_linked: true });

    await press(getByTestId('settings-sso-disconnect'));

    expect(getByTestId('settings-sso-error')).toHaveTextContent('settings.ssoUnlinkWouldStrand');
    expect(setUser).not.toHaveBeenCalled();
  });
});
