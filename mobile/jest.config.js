module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    // `marked` ships ESM only (its `exports` resolves to lib/marked.esm.js), so
    // Jest has to transform it. Metro consumes it as-is; this is a Jest-only
    // concern, not a sign the package needs special handling on device.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|axios|@tanstack/react-query|react-native-reanimated|react-native-gesture-handler|react-native-draggable-flatlist|marked)',
  ],
  setupFiles: ['./jest.setup.js'],
  setupFilesAfterEnv: ['./jest.setupAfterEnv.js'],
  // `__tests__/helpers/` holds shared harness code, not suites.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/helpers/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@jot/shared$': '<rootDir>/../shared/src',
  },
  // forceExit is required because @testing-library/react-native's waitFor uses
  // setInterval internally, which can outlive tests in the react-native-env.js
  // environment and otherwise hangs the run. It is global, though, so it also
  // masks a handle leaked by the app's own code (a sync/SSE/offline timer or
  // subscription). `npm run test:handles` sets JEST_DETECT_OPEN_HANDLES to drop
  // forceExit and turn on --detectOpenHandles instead, so those surface. That
  // run is a diagnostic — deliberately out of CI and `task check` — and will
  // hang on the known library timer after printing its report; read the report,
  // then Ctrl-C.
  forceExit: !process.env.JEST_DETECT_OPEN_HANDLES,
  detectOpenHandles: Boolean(process.env.JEST_DETECT_OPEN_HANDLES),
};
