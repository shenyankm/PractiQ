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
    files: ['**/*.ui.test.tsx', '**/*.test.ts'],
    languageOptions: {
      globals: globals.jest,
    },
    rules: {
      'import/first': 'off',
      // heroui stubs define anonymous components in jest.mock factories
      'react/display-name': 'off',
      // jest.mock factories must use require() (hoisting forbids imports)
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      // stub factories and probe refs mutate module-level slots in tests
      'react-hooks/immutability': 'off',
      'react-hooks/globals': 'off',
    },
  },
]);
