import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { ServerConfig } from '@jot/shared';
import ConnectToServerScreen from '../src/screens/ConnectToServerScreen';
import { probeServerReachability } from '../src/api/client';
import { probeServerConfig } from '../src/api/config';
import i18n from '../src/i18n';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../src/api/client', () => ({
  probeServerReachability: jest.fn(),
}));

jest.mock('../src/api/config', () => ({
  DEFAULT_SERVER_CONFIG: { registration_enabled: true, password_min_length: 10, upload_max_bytes: 26214400 },
  probeServerConfig: jest.fn(),
}));

jest.mock('../src/store/upgradeToServer', () => ({
  registerOnServer: jest.fn(),
  runPreflightChecks: jest.fn(),
  seedReplayQueue: jest.fn(),
  configureMigrationApiClient: jest.fn(),
  runMigrationDrainPass: jest.fn(),
  flipToServerMode: jest.fn(),
  runBackgroundReconcileScopes: jest.fn(),
}));

jest.mock('../src/store/localMode', () => ({
  getLocalIdentity: jest.fn(),
}));

jest.mock('../src/db/syncQueue', () => ({
  getDeadLetterCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({ completeServerUpgrade: jest.fn() }),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ isConnected: true }),
}));

jest.mock('../src/hooks/queryKeys', () => ({
  notesLocalQueryScopeKey: jest.fn(() => ['notes-local']),
  labelsQueryKey: jest.fn(() => ['labels']),
}));

jest.mock('../src/utils/retryWithBackoff', () => ({
  retrySync: jest.fn(),
}));

const mockProbeServerReachability = probeServerReachability as jest.MockedFunction<typeof probeServerReachability>;
const mockProbeServerConfig = probeServerConfig as jest.MockedFunction<typeof probeServerConfig>;

const SERVER_A = 'https://server-a.example.com';
const SERVER_B = 'https://server-b.example.com';

describe('ConnectToServerScreen out-of-order config probes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProbeServerReachability.mockImplementation(async (url: string) => ({ ok: true, canonicalUrl: url }));
  });

  it('does not let a slow probe for an abandoned server overwrite the later target server config', async () => {
    let resolveServerAConfig!: (cfg: ServerConfig) => void;
    const serverAConfig: ServerConfig = { registration_enabled: true, password_min_length: 6, upload_max_bytes: 1000 };
    const serverBConfig: ServerConfig = { registration_enabled: true, password_min_length: 14, upload_max_bytes: 2000 };

    mockProbeServerConfig.mockImplementation((url: string) => {
      if (url === SERVER_A) {
        // Left pending — resolved explicitly later in the test, after B has
        // already become the target.
        return new Promise((resolve) => { resolveServerAConfig = resolve; });
      }
      return Promise.resolve(serverBConfig);
    });

    const { getByTestId, findByTestId, getByText } = await render(<ConnectToServerScreen />);

    // Probe server A — its config fetch is left pending.
    await fireEvent.changeText(getByTestId('upgrade-server-url-input'), SERVER_A);
    await fireEvent.press(getByTestId('upgrade-server-url-submit'));
    await findByTestId('upgrade-username-input');

    // Change target to server B before A's config probe has resolved.
    await fireEvent.press(getByTestId('upgrade-back-to-server-url'));
    await fireEvent.changeText(getByTestId('upgrade-server-url-input'), SERVER_B);
    await fireEvent.press(getByTestId('upgrade-server-url-submit'));
    await findByTestId('upgrade-username-input');

    // B's own (immediately-resolving) probe should already be reflected.
    await fireEvent.changeText(getByTestId('upgrade-username-input'), 'newuser');
    await fireEvent.changeText(getByTestId('upgrade-password-input'), 'p'.repeat(10));
    await fireEvent.press(getByTestId('upgrade-register-button'));
    await waitFor(() => {
      expect(getByText(i18n.t('auth.passwordMin', { min: 14 }))).toBeTruthy();
    });

    // A's stale probe finally resolves — it must not override B's config.
    // Flush the resolution (and any state update it triggers) before
    // interacting again, so a still-pending update can't hide the bug by
    // simply losing the race with the next assertion.
    await act(async () => {
      resolveServerAConfig(serverAConfig);
      await Promise.resolve();
      await Promise.resolve();
    });

    await fireEvent.press(getByTestId('upgrade-register-button'));
    await waitFor(() => {
      expect(getByText(i18n.t('auth.passwordMin', { min: 14 }))).toBeTruthy();
    });
    expect(mockProbeServerConfig).toHaveBeenCalledWith(SERVER_A);
    expect(mockProbeServerConfig).toHaveBeenCalledWith(SERVER_B);
  });
});
