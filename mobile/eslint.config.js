// https://docs.expo.dev/guides/using-eslint/
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  globalIgnores(['.expo/*', 'android/*', 'coverage/*', 'dist/*', 'ios/*']),
  expoConfig,
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['**/*.ui.test.tsx'],
    languageOptions: {
      globals: globals.jest,
    },
    rules: {
      'import/first': 'off',
    },
  },
]);
