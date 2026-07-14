describe('getAppBuildInfo', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.EXPO_PUBLIC_COMMIT_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_DATE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reports the app.json version with no commit/build time when unset', () => {
    const { getAppBuildInfo } = require('../src/utils/appInfo');
    expect(getAppBuildInfo()).toEqual({
      version: '0.1.0',
      commit: undefined,
      buildTime: undefined,
    });
  });

  it('surfaces commit and build time injected via EXPO_PUBLIC_* env vars', () => {
    process.env.EXPO_PUBLIC_COMMIT_SHA = 'abc1234';
    process.env.EXPO_PUBLIC_BUILD_DATE = '2026-07-14T12:00:00Z';

    const { getAppBuildInfo } = require('../src/utils/appInfo');
    expect(getAppBuildInfo()).toEqual({
      version: '0.1.0',
      commit: 'abc1234',
      buildTime: '2026-07-14T12:00:00Z',
    });
  });
});
