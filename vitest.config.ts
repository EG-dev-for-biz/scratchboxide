import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: [
            { find: '@scratchbox/core/style.css', replacement: path.resolve(__dirname, 'packages/core/src/style.css') },
            { find: /^@scratchbox\/core\/(.*)$/, replacement: path.resolve(__dirname, 'packages/core/src') + '/$1' },
            { find: '@scratchbox/core', replacement: path.resolve(__dirname, 'packages/core/src') }
        ]
    },
    test: {
        environment: 'node',
        include: ['packages/core/test/**/*.test.ts', 'packages/cli/test/**/*.test.ts', 'desktop-app/test/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**'],
        testTimeout: 180_000,
        hookTimeout: 60_000,
        silent: 'passed-only',
        pool: 'forks',
        env: {
            SCRATCHBOX_TEST: '1'
        }
    }
});
