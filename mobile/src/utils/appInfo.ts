import Constants from 'expo-constants';
import appJson from '../../app.json';

export interface AppBuildInfo {
  version: string;
  commit?: string;
  buildTime?: string;
}

// The resolved Expo config (after app.config.js runs) is the source of truth
// for the version: on tagged release builds it carries the git tag, otherwise
// the static app.json version. Fall back to app.json directly on the off chance
// the embedded config is unavailable at runtime.
export function getAppBuildInfo(): AppBuildInfo {
  return {
    version: Constants.expoConfig?.version ?? appJson.expo.version,
    commit: process.env.EXPO_PUBLIC_COMMIT_SHA || undefined,
    buildTime: process.env.EXPO_PUBLIC_BUILD_DATE || undefined,
  };
}
