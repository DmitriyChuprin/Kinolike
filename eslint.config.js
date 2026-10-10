const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh');

module.exports = tseslint.config(
  { ignores: ['**/*.js', 'dist/**', 'client/**', 'node_modules/**', 'server/**', 'test/**', 'mcp-server/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', matchMedia: 'readonly', fetch: 'readonly', URL: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly', Blob: 'readonly', FileReader: 'readonly', ResizeObserver: 'readonly', HTMLElement: 'readonly', HTMLVideoElement: 'readonly', HTMLMediaElement: 'readonly', Event: 'readonly', CustomEvent: 'readonly', KeyboardEvent: 'readonly', MediaQueryListEvent: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
