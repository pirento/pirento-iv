import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/', 'release/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      // `const { _id, ...record } = row` deliberately drops fields; best-effort cleanup uses empty catches.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['public/js/**/*.js', 'tests/browser/**/*.js'],
    languageOptions: { globals: { ...globals.browser, pdfMake: 'readonly' } },
  },
];
