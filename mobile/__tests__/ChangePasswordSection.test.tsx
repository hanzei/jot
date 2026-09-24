import { render } from '@testing-library/react-native';
import type { ServerConfig } from '@jot/shared';
import ChangePasswordSection from '../src/screens/settings/ChangePasswordSection';
import { useServerConfig } from '../src/hooks/useServerConfig';

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  changePassword: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUseServerConfig = useServerConfig as jest.MockedFunction<typeof useServerConfig>;

const baseConfig: ServerConfig = { registration_enabled: true, password_min_length: 10, upload_max_bytes: 1024 };

describe('ChangePasswordSection', () => {
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
});
