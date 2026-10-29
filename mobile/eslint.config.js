// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    rules: {
      // As in the web app (../eslint.config.mjs): screens load their data when
      // they open and set state once it arrives. That is the effect this rule
      // warns about, and an async load is not the cascading render it means.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    ignores: ['dist/*', '.expo/*'],
  },
]);
