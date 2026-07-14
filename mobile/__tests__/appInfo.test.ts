import Constants from 'expo-constants';
import { getAppBuildInfo } from '../src/utils/appInfo';
import appJson from '../app.json';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: null } },
}));

// Cast to a mutable shape so each test can set the resolved config version.
const mockConstants = Constants as unknown as { expoConfig: { version: string | null } | null };

describe('getAppBuildInfo', () => {
  // Mutate process.env in place (never reassign it): the transformed source
  // reads env vars via expo/virtual/env, whose `env` export is bound to this
  // same process.env object reference at import time.
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_COMMIT_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_DATE;
    mockConstants.expoConfig = { version: '1.2.3' };
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_COMMIT_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_DATE;
  });

  it('reports the resolved Expo config version, with no commit/build time when unset', () => {
    expect(getAppBuildInfo()).toEqual({
      version: '1.2.3',
      commit: undefined,
      buildTime: undefined,
    });
  });

  it('surfaces commit and build time injected via EXPO_PUBLIC_* env vars', () => {
    process.env.EXPO_PUBLIC_COMMIT_SHA = 'abc1234';
    process.env.EXPO_PUBLIC_BUILD_DATE = '2026-07-14T12:00:00Z';

    expect(getAppBuildInfo()).toEqual({
      version: '1.2.3',
      commit: 'abc1234',
      buildTime: '2026-07-14T12:00:00Z',
    });
  });

  it('falls back to the static app.json version when the resolved config has none', () => {
    mockConstants.expoConfig = { version: null };
    expect(getAppBuildInfo().version).toBe(appJson.expo.version);

    mockConstants.expoConfig = null;
    expect(getAppBuildInfo().version).toBe(appJson.expo.version);
  });
});
