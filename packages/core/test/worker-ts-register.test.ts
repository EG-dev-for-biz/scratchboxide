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
import { Worker } from 'worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { workerTsRegisterSource } from '../src/node/worker-ts-register';

/**
 * A worker thread that loads a .ts entry through ts-node must not take the target from whatever tsconfig ts-node finds:
 * with an ES5 target (TypeScript's default when a tsconfig gives none, as the repo root's does) for...of over a Set or
 * Map transpiles to an index loop that never runs. The cross-view match, edge render and texture pools share this bootstrap.
 */
// inside the repo (gitignored test-results), so the entry resolves ts-node from node_modules as the pools' entries do
const base = path.resolve(__dirname, '../../../test-results');
fs.mkdirSync(base, { recursive: true });
const dir = fs.mkdtempSync(path.join(base, 'worker-ts-register-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function runWorker(entry: string, bootstrap: string, cwd: string): Promise<unknown> {
    const was = process.cwd();
    process.chdir(cwd);
    try {
        const w = new Worker(bootstrap, { eval: true, workerData: { entry } });
        return new Promise((resolve, reject) => {
            w.once('message', m => { void w.terminate(); resolve(m); });
            w.once('error', reject);
        });
    } finally {
        process.chdir(was);
    }
}

describe('worker ts-node bootstrap', () => {
    it('iterates a Set and a Map in a worker started from a directory whose tsconfig says ES5', async () => {
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES5', module: 'commonjs' } }));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, [
            "import { parentPort } from 'worker_threads';",
            'const s = new Set<number>([1, 2, 3]);',
            "const m = new Map<string, number>([['a', 10], ['b', 20]]);",
            'let n = 0;',
            'for (const x of s) n += x;',
            'for (const [, v] of m) n += v;',
            'n += [...s].length * 100;',
            'parentPort!.postMessage(n);'
        ].join('\n'));
        const bootstrap = `const { workerData } = require('worker_threads');\n${workerTsRegisterSource()}\nrequire(workerData.entry);`;
        expect(await runWorker(entry, bootstrap, dir)).toBe(1 + 2 + 3 + 10 + 20 + 300);
    }, 60_000);

    it('is the bootstrap every worker pool uses', () => {
        const src = path.resolve(__dirname, '../src/node');
        for (const f of ['spatial/CrossViewMatchPool.ts', 'spatial/HeadlessEdgeRenderPool.ts', '3d-engine/staged-location/texture-worker-pool.ts']) {
            const text = fs.readFileSync(path.join(src, f), 'utf8');
            expect(text, f).toContain('${workerTsRegisterSource()}');
            expect(text, f).not.toMatch(/\.register\(\{/);
        }
    });
});
