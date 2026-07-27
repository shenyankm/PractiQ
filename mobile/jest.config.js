module.exports = {
  preset: 'jest-expo',
  clearMocks: true,
  resolver: 'react-native-worklets/jest/resolver',
  testMatch: ['<rootDir>/src/**/*.ui.test.tsx'],
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|heroui-native|native-base|standard-navigation|uniwind))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
