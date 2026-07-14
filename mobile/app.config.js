// Dynamic Expo config layered on top of the static app.json.
//
// `config` is the resolved contents of app.json's `expo` key. We override only
// the version so a tagged release build carries the git tag as its version:
// CI sets APP_VERSION to the tag name (e.g. `v1.2.3`) on tag builds, and we
// strip the leading `v` (matching the server's `strings.TrimPrefix(version,
// "v")`) so the value is a valid iOS CFBundleShortVersionString / Android
// versionName. When APP_VERSION is unset (local dev, master, PRs) the static
// app.json version is used unchanged.
//
// This resolved version flows into three places from a single source: the
// native versionName baked by `expo prebuild`, the bundled JS config, and the
// About screen (which reads it back via Constants.expoConfig.version).
export default ({ config }) => {
  const tag = process.env.APP_VERSION;
  return {
    ...config,
    version: tag ? tag.replace(/^v/, '') : config.version,
  };
};
