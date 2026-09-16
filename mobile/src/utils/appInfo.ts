import Constants from 'expo-constants';
import appJson from '../../app.json';

export interface AppBuildInfo {
  version: string;
  commit?: string;
  buildTime?: string;
}

// EXPO_PUBLIC_COMMIT_SHA is the full 40-char git SHA (see mobile-apk.yml). Show
// only the short form in the UI, matching the 7-char commit the server returns
// from /about (server.go buildInfo) so both rows read the same way.
const SHORT_COMMIT_LENGTH = 7;

// The resolved Expo config (after app.config.js runs) is the source of truth
// for the version: on tagged release builds it carries the git tag, otherwise
// the static app.json version. Fall back to app.json directly on the off chance
// the embedded config is unavailable at runtime.
export function getAppBuildInfo(): AppBuildInfo {
  const commitSha = process.env.EXPO_PUBLIC_COMMIT_SHA || undefined;
  return {
    version: Constants.expoConfig?.version ?? appJson.expo.version,
    commit: commitSha?.slice(0, SHORT_COMMIT_LENGTH),
    buildTime: process.env.EXPO_PUBLIC_BUILD_DATE || undefined,
  };
}
