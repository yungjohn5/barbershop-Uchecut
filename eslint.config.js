const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'public/css/', 'coverage/', 'prisma/migrations/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
  prettier,
];
