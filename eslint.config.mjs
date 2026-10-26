import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import { fixupPluginRules } from '@eslint/compat';
import globals from 'globals';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const noUnsafeExeca = require('./eslint-rules/no-unsafe-execa.js');

const localPlugin = {
  rules: {
    'no-unsafe-execa': noUnsafeExeca,
  },
};

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'eslint-rules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      security: fixupPluginRules(security),
    },
    rules: {
      ...security.configs.recommended.rules,
    },
  },
  {
    files: ['src/model-information-contract/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      local: localPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // New rules in ESLint 10 eslint:recommended - disable for now, enable in follow-up PR
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'security/detect-child-process': 'error',
      'local/no-unsafe-execa': 'warn',
    },
  },
);
