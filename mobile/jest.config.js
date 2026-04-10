module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|axios|@tanstack/react-query|react-native-reanimated|react-native-gesture-handler|react-native-draggable-flatlist)',
  ],
  setupFiles: ['./jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@jot/shared$': '<rootDir>/../shared/src',
    // Stub the axios fetch adapter to prevent its top-level ReadableStream probe
    // from crashing against Expo's polyfill in the Jest environment.
    '^axios/lib/adapters/fetch(\\.js)?$': '<rootDir>/__mocks__/axios-fetch-adapter.js',
  },
  // forceExit required: @testing-library/react-native's waitFor uses setInterval
  // internally which can outlive tests in the react-native-env.js environment
  forceExit: true,
};
