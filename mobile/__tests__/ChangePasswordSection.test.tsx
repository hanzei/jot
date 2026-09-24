import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ServerConfig, User } from '@jot/shared';
import ChangePasswordSection from '../src/screens/settings/ChangePasswordSection';
import { useServerConfig } from '../src/hooks/useServerConfig';
import { useAuth } from '../src/store/AuthContext';
import { changePassword } from '../src/api/settings';

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  changePassword: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUseServerConfig = useServerConfig as jest.MockedFunction<typeof useServerConfig>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockChangePassword = changePassword as jest.MockedFunction<typeof changePassword>;

const baseUser: User = {
  id: 'u1',
  username: 'alice',
  first_name: '',
  last_name: '',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function mockAuthUser(user: User) {
  const setUser = jest.fn();
  mockUseAuth.mockReturnValue({ user, setUser } as unknown as ReturnType<typeof useAuth>);
  return setUser;
}

const baseConfig: ServerConfig = { registration_enabled: true, password_min_length: 10, upload_max_bytes: 1024 };

describe('ChangePasswordSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser(baseUser);
  });

  it.each([
    ['no sso block', baseConfig],
    ['sso disabled', { ...baseConfig, sso: { enabled: false, provider_name: 'SSO', local_login_enabled: false } }],
    ['mixed mode', { ...baseConfig, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: true } }],
  ])('renders with %s', async (_label, config) => {
    mockUseServerConfig.mockReturnValue(config);
    const { getByText } = await render(<ChangePasswordSection />);
    expect(getByText('settings.changePasswordSection')).toBeTruthy();
  });

  it('renders nothing on an SSO-only server, where a password cannot sign in', async () => {
    mockUseServerConfig.mockReturnValue({
      ...baseConfig,
      sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: false },
    });
    const { queryByText } = await render(<ChangePasswordSection />);
    expect(queryByText('settings.changePasswordSection')).toBeNull();
  });

  describe('for an account without a password', () => {
    beforeEach(() => {
      mockUseServerConfig.mockReturnValue(baseConfig);
    });

    it('shows Set Password without a current-password field', async () => {
      mockAuthUser({ ...baseUser, has_password: false });
      const { getByText, queryByTestId } = await render(<ChangePasswordSection />);
      expect(getByText('settings.setPasswordSection')).toBeTruthy();
      expect(getByText('settings.setPasswordDescription')).toBeTruthy();
      expect(queryByTestId('settings-current-password')).toBeNull();
    });

    it('sets the password without current_password and marks the user as having one', async () => {
      const setUser = mockAuthUser({ ...baseUser, has_password: false });
      mockChangePassword.mockResolvedValue(undefined);
      const { getByTestId, findByText } = await render(<ChangePasswordSection />);

      await fireEvent.changeText(getByTestId('settings-new-password'), 'newpassword123');
      await fireEvent.changeText(getByTestId('settings-confirm-password'), 'newpassword123');
      await fireEvent.press(getByTestId('settings-change-password'));

      await waitFor(() => {
        expect(mockChangePassword).toHaveBeenCalledWith({ new_password: 'newpassword123' });
      });
      expect(await findByText('settings.passwordSet')).toBeTruthy();
      expect(setUser).toHaveBeenCalledTimes(1);
      const updater = setUser.mock.calls[0]![0] as (prev: User | null) => User | null;
      expect(updater({ ...baseUser, has_password: false })).toEqual({ ...baseUser, has_password: true });
    });
  });

  it('still requires the current password for an account that has one', async () => {
    mockUseServerConfig.mockReturnValue(baseConfig);
    const { getByTestId, findByText } = await render(<ChangePasswordSection />);

    await fireEvent.changeText(getByTestId('settings-new-password'), 'newpassword123');
    await fireEvent.changeText(getByTestId('settings-confirm-password'), 'newpassword123');
    await fireEvent.press(getByTestId('settings-change-password'));

    expect(await findByText('settings.currentPasswordRequired')).toBeTruthy();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });
});
