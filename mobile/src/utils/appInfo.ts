import appConfig from '../../app.json';

export interface AppBuildInfo {
  version: string;
  commit?: string;
  buildTime?: string;
}

export function getAppBuildInfo(): AppBuildInfo {
  return {
    version: appConfig.expo.version,
    commit: process.env.EXPO_PUBLIC_COMMIT_SHA || undefined,
    buildTime: process.env.EXPO_PUBLIC_BUILD_DATE || undefined,
  };
}
