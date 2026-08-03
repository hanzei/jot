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
  // forceExit required: @testing-library/react-native's waitFor uses setInterval
  // internally which can outlive tests in the react-native-env.js environment
  forceExit: true,
};
