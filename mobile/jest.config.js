module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    // `marked` and `@formatjs/*` ship ESM only (e.g. marked's `exports` resolves
    // to lib/marked.esm.js), so Jest has to transform them. Metro consumes them
    // as-is; this is a Jest-only concern, not a sign the packages need special
    // handling on device.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|axios|@tanstack/react-query|react-native-reanimated|react-native-gesture-handler|react-native-draggable-flatlist|marked|@formatjs/.*)',
  ],
  setupFiles: ['./jest.setup.js'],
  setupFilesAfterEnv: ['./jest.setupAfterEnv.js'],
  // `__tests__/helpers/` holds shared harness code, not suites.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/helpers/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@jot/shared$': '<rootDir>/../shared/src',
    // babel-preset-expo lowers array destructuring, object rest, async
    // functions, and classes to `@babel/runtime/helpers/*` requires. In a file
    // under shared/, Node resolution walks up from shared/, which has no
    // node_modules, so without this every suite fails to load
    // (__tests__/sharedBabelRuntime.test.ts covers it). Metro needs no
    // equivalent: an `expo export` with a helper required from shared/src
    // resolves it, and the Hermes build leaves these constructs unlowered.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
  // No forceExit: every suite lets its worker exit on its own, so a handle
  // leaked by app code (a sync/SSE/offline timer or subscription) shows up as
  // Jest's "worker process has failed to exit gracefully" warning or a hung
  // run instead of being masked. The TanStack Query GC timers that used to hold
  // workers open are unref'd in jest.setupAfterEnv.js. To locate a new leak,
  // `npm run test:handles` sets JEST_DETECT_OPEN_HANDLES to turn on
  // --detectOpenHandles (a diagnostic, deliberately out of CI and `task check`).
  detectOpenHandles: Boolean(process.env.JEST_DETECT_OPEN_HANDLES),
};
