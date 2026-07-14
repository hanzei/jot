import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import AboutSection from '../src/screens/settings/AboutSection';
import { useAuth } from '../src/store/AuthContext';
import { getAboutInfo } from '../src/api/settings';
import { getActiveServer } from '../src/store/serverAccounts';
import type { User, AboutInfo } from '@jot/shared';

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

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.0' } },
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

  it('shows the mobile app version alongside the server version once expanded', async () => {
    const { getByTestId, getByText, findByText } = render(<AboutSection />);

    // Let the active-server lookup settle before expanding, so it doesn't race
    // with (and reset) the about-info fetch triggered by expansion below.
    await waitFor(() => expect(mockGetActiveServer).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.press(getByTestId('settings-about-toggle'));

    // App Info section shows the app's own (package.json/app.json-sourced) version.
    expect(getByText('App Info')).toBeTruthy();
    expect(getByText('0.1.0')).toBeTruthy();

    // Server Info section shows the fetched server version, once loaded.
    await waitFor(() => expect(mockGetAboutInfo).toHaveBeenCalled());
    expect(await findByText('1.2.3')).toBeTruthy();
    expect(getByText('go1.26.0')).toBeTruthy();
  });
});
