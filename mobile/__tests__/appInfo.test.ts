import { getAppBuildInfo } from '../src/utils/appInfo';

describe('getAppBuildInfo', () => {
  // Mutate process.env in place (never reassign it): the transformed source
  // reads env vars via expo/virtual/env, whose `env` export is bound to this
  // same process.env object reference at import time.
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_COMMIT_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_DATE;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_COMMIT_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_DATE;
  });

  it('reports the app.json version with no commit/build time when unset', () => {
    expect(getAppBuildInfo()).toEqual({
      version: '0.1.0',
      commit: undefined,
      buildTime: undefined,
    });
  });

  it('surfaces commit and build time injected via EXPO_PUBLIC_* env vars', () => {
    process.env.EXPO_PUBLIC_COMMIT_SHA = 'abc1234';
    process.env.EXPO_PUBLIC_BUILD_DATE = '2026-07-14T12:00:00Z';

    expect(getAppBuildInfo()).toEqual({
      version: '0.1.0',
      commit: 'abc1234',
      buildTime: '2026-07-14T12:00:00Z',
    });
  });
});
