import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import AboutSection from '../src/screens/settings/AboutSection';
import { useAuth } from '../src/store/AuthContext';
import { getAboutInfo } from '../src/api/settings';
import { getActiveServer } from '../src/store/serverAccounts';
import { getCurrentLocale } from '../src/i18n/utils';
import type { User, AboutInfo } from '@jot/shared';

// App build info the component reads. Mock the appInfo module boundary rather
// than expo-constants/process.env so all three fields (version, commit,
// buildTime) are controllable and their conditional render branches covered —
// the env-var path is exercised separately in appInfo.test.ts.
const APP_VERSION = '0.1.0';
const APP_COMMIT = 'abc1234';
const APP_BUILD_TIME = '2026-07-01T00:00:00Z';

jest.mock('../src/utils/appInfo', () => ({
  getAppBuildInfo: () => ({
    version: '0.1.0',
    commit: 'abc1234',
    buildTime: '2026-07-01T00:00:00Z',
  }),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  getAboutInfo: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
}));

jest.mock('../src/store/serverAccounts', () => ({
  getActiveServer: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockGetAboutInfo = getAboutInfo as jest.MockedFunction<typeof getAboutInfo>;
const mockGetActiveServer = getActiveServer as jest.MockedFunction<typeof getActiveServer>;

const baseUser: User = {
  id: 'user-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const serverInfo: AboutInfo = {
  version: '1.2.3',
  commit: 'deadbee',
  build_time: '2026-06-01T00:00:00Z',
  go_version: 'go1.26.0',
};

describe('AboutSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: baseUser } as unknown as ReturnType<typeof useAuth>);
    mockGetActiveServer.mockResolvedValue({ serverUrl: 'https://jot.example.com' } as never);
    mockGetAboutInfo.mockResolvedValue(serverInfo);
  });

  it('shows the mobile app version/commit/build time alongside the server version once expanded', async () => {
    const { getByTestId, getByText, findByText } = render(<AboutSection />);

    // Let the active-server lookup settle before expanding, so it doesn't race
    // with (and reset) the about-info fetch triggered by expansion below.
    await waitFor(() => expect(mockGetActiveServer).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.press(getByTestId('settings-about-toggle'));

    // App Info section shows the app's own version, commit, and build time.
    expect(getByText('App Info')).toBeTruthy();
    expect(getByText(APP_VERSION)).toBeTruthy();
    expect(getByText(APP_COMMIT)).toBeTruthy();
    // Build time is rendered via the component's own formatDate/locale, so
    // compute the expected string the same way to stay timezone-independent.
    const expectedBuildTime = new Date(APP_BUILD_TIME).toLocaleString(getCurrentLocale());
    expect(getByText(expectedBuildTime)).toBeTruthy();

    // Server Info section shows the fetched server version, once loaded.
    await waitFor(() => expect(mockGetAboutInfo).toHaveBeenCalled());
    expect(await findByText('1.2.3')).toBeTruthy();
    expect(getByText('go1.26.0')).toBeTruthy();
  });
});
