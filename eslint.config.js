import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Vendored design-reference bundles (and any other vendored JS) are not our source.
  { ignores: ['dist', 'node_modules', 'uploads/design-reference/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // Honor the underscore convention for intentionally-unused args/vars/caught errors
      // (stub params, ignored handler payloads) so they need no eslint-disable comments.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The signaling server is standalone Node ESM (its own package, not bundled with the SPA),
    // so it runs with Node globals (process, setInterval, URL, console, …), not browser ones.
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
);
