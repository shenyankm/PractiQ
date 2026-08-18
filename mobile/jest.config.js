// SignInScreen reads GOOGLE_CLIENT_ID at module load; set it before any test file imports it.
process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = 'google-client';

module.exports = {
  preset: 'jest-expo',
  clearMocks: true,
  resolver: 'react-native-worklets/jest/resolver',
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
  moduleNameMapper: {
    '^expo-sqlite$': '<rootDir>/src/test-utils/sqlite-mock.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|heroui-native|native-base|standard-navigation|uniwind))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
