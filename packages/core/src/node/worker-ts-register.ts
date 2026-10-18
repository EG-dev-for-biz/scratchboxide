/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ts-node options a worker thread loads a .ts entry with (development and tests; the compiled .js is loaded as is).
 * The project's tsconfig is skipped and the server's own target forced: the tsconfig ts-node would find from the working
 * directory may have none, and ts-node's default (ES5) compiles for...of over a Set or Map to a loop that never runs.
 */
export const WORKER_TS_NODE_OPTIONS = {
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { target: 'ES2022', module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, allowSyntheticDefaultImports: true }
} as const;

/** JavaScript for a worker's `eval` bootstrap: registers ts-node with WORKER_TS_NODE_OPTIONS when `entryExpr` names a .ts file. */
export function workerTsRegisterSource(entryExpr = 'workerData.entry'): string {
    return `if (/\\.ts$/.test(${entryExpr})) {
    require(require.resolve('ts-node', { paths: [require('path').dirname(${entryExpr})] })).register(${JSON.stringify(WORKER_TS_NODE_OPTIONS)});
}`;
}
