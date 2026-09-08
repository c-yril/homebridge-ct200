import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
        },
        rules: {
            'quotes': ['warn', 'single'],
            'indent': ['warn', 4, { 'SwitchCase': 1 }],
            'linebreak-style': ['error', 'unix'],
            'semi': ['warn', 'always'],
            'comma-dangle': ['warn', 'always-multiline'],
            'dot-notation': 'off',
            'eqeqeq': 'warn',
            'curly': ['warn', 'all'],
            'brace-style': ['warn'],
            'prefer-arrow-callback': ['warn'],
            'max-len': ['warn', 140],
            'no-console': ['warn'], // use the provided Homebridge log method instead
            'comma-spacing': ['error'],
            'no-multi-spaces': ['warn', { 'ignoreEOLComments': true }],
            'no-trailing-spaces': ['warn'],
            'lines-between-class-members': ['warn', 'always', { 'exceptAfterSingleLine': true }],
            '@typescript-eslint/no-unused-vars': ['error', { 'caughtErrors': 'none' }],
        },
    },
    {
        // Maintenance scripts run under Node directly, not inside Homebridge.
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: {
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
            },
        },
        rules: {
            'no-console': 'off',
        },
    },
);
