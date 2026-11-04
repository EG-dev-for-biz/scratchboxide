import { defineConfig } from 'vitest/config';
import path from 'path';
import DurationShardSequencer from './vitest.shard-sequencer';

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
        globalSetup: ['./vitest.global-setup.ts'],
        testTimeout: 180_000,
        hookTimeout: 60_000,
        silent: 'passed-only',
        pool: 'forks',
        // CI's Ubuntu shards (--shard=i/n) split by measured time (vitest.shard-sequencer.ts).
        sequence: { sequencer: DurationShardSequencer },
        env: {
            SCRATCHBOX_TEST: '1',
            // Tests exercise the chat model's own first call; the routing race (fast-router.ts) is tested on its own.
            SCRATCHBOX_CHAT_ROUTER: 'off',
            // Tests never bill and stay on the CPU, also on a Google Cloud machine with a GPU (deploy/devbox): the torch
            // sidecars' auto device is pinned to the CPU, and the metadata server's service-account credentials are off
            SCRATCHBOX_TORCH_DEVICE: 'cpu',
            METADATA_SERVER_DETECTION: 'none'
        }
    }
});
