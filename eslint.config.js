// @ts-check
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const react = require('eslint-plugin-react');
const globals = require('globals');

module.exports = tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/dist-electron/**',
            '**/build/**',
            '**/build_py/**',
            '**/CMakeFiles/**',
            '**/.cache/**',
            'docs/**',
            'coverage/**',
            'scripts/**',
            '*.config.js',
            'desktop-app/scripts/**'
        ]
    },
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node, ...globals.es2022 }
        },
        plugins: {
            'react-hooks': reactHooks,
            react
        },
        settings: { react: { version: 'detect' } },
        rules: {
            // React correctness
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            'react/jsx-key': ['error', { checkFragmentShorthand: true, warnOnDuplicates: true }],
            'react/no-array-index-key': 'warn',
            'react/jsx-no-target-blank': 'error',

            // Type hygiene: ratchet these from warn -> error as the codebase is cleaned up.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': true, 'ts-ignore': 'allow-with-description' }],

            // Plain JS safety
            'no-debugger': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'prefer-const': 'warn',
            'no-var': 'error'
        }
    },
    {
        files: ['**/test/**/*.ts', 'desktop-app/scripts/**'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off'
        }
    }
);
