/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

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

/**
 * A worker entry file `name` (.js or .ts): beside `dirname` (the module that starts it, run from source or compiled), else
 * under an ancestor of `dirname` at `src/node/<subdir>/` or `dist/node/<subdir>/`. The second is the bundled server's case:
 * the bundle (e.g. dist/node/mcp/scratchbox-mcp.cjs) holds the module's code but not the worker's file, and `dirname` is the
 * bundle's folder, so the entry is looked for in the package the bundle was built from (its source first: a bundle's
 * compiled tree may be older than it). Throws naming every place looked when there is none.
 */
export function findWorkerEntry(name: string, dirname: string = typeof __dirname !== 'undefined' ? __dirname : process.cwd(), subdir = ''): string {
    const tried: string[] = [];
    const exists = (p: string) => { tried.push(p); return fs.existsSync(p); };
    for (const ext of ['.js', '.ts']) { const p = path.join(dirname, name + ext); if (exists(p)) return p; }
    for (let dir = dirname; ; dir = path.dirname(dir)) {
        for (const [root, ext] of [['src', '.ts'], ['dist', '.js']] as const) {
            const p = path.join(dir, root, 'node', subdir, name + ext);
            if (exists(p)) return p;
        }
        if (path.dirname(dir) === dir) break;
    }
    throw new Error(`the worker entry ${name} was not found (looked in ${tried.slice(0, 6).join(', ')}${tried.length > 6 ? ` and ${tried.length - 6} more` : ''})`);
}

/** JavaScript for a worker's `eval` bootstrap: registers ts-node with WORKER_TS_NODE_OPTIONS when `entryExpr` names a .ts file. */
export function workerTsRegisterSource(entryExpr = 'workerData.entry'): string {
    return `if (/\\.ts$/.test(${entryExpr})) {
    require(require.resolve('ts-node', { paths: [require('path').dirname(${entryExpr})] })).register(${JSON.stringify(WORKER_TS_NODE_OPTIONS)});
}`;
}
