/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Records every checkout's published models (each `git worktree`'s public/models and desktop-app/public/models) in the
 * durable asset store, so a saved chat keeps its models when they were built in another checkout, and after that
 * checkout is cleaned. A server sweeps only its own checkout when it starts; this covers the checkouts whose servers
 * do not run again. A name found in several checkouts is served as its newest copy. Files already recorded with the
 * same size and mtime are not hashed again, so a second run is quick.
 *
 * The store keeps bytes as APFS clones of the checkout files (no extra space on the same volume) and a recorded file
 * outlives its checkout: cleaning a worktree then frees less. The sweep stops when the volume's free space falls under
 * --min-free-gb (default 10).
 *
 * Needs Node 22.13+ (node:sqlite):
 *   ~/.nvm/versions/node/v22.18.0/bin/node node_modules/.bin/ts-node --transpile-only -P desktop-app/tsconfig.electron.json \
 *     scripts/asset_store_sweep_checkouts.ts [--dry-run] [--min-free-gb 10]
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { defaultDurableAssetStore, normalizeServedPath } from '../packages/core/src/node/asset-store/durable-asset-store';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const minFreeGb = Number(args[args.indexOf('--min-free-gb') + 1]) || 10;
const GB = 1024 ** 3;

interface Candidate { file: string; servedPath: string; checkout: string; bytes: number; mtimeMs: number }

function checkouts(): string[] {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    return out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length)).filter(d => fs.existsSync(d));
}

function modelsIn(checkout: string): Candidate[] {
    const found: Candidate[] = [];
    for (const rel of ['public/models', 'desktop-app/public/models']) {
        const base = path.join(checkout, rel);
        if (!fs.existsSync(base)) continue;
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith('.')) continue;
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(file);
                // links point into another checkout's copy, which is swept there
                else if (entry.isFile()) {
                    const stat = fs.statSync(file);
                    found.push({ file, servedPath: normalizeServedPath(`/models/${path.relative(base, file).split(path.sep).join('/')}`), checkout, bytes: stat.size, mtimeMs: stat.mtimeMs });
                }
            }
        };
        walk(base);
    }
    return found;
}

function freeGb(dir: string): number {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / GB;
}

async function main(): Promise<void> {
    const store = defaultDurableAssetStore();
    if (!store) throw new Error(`the asset store is not available on Node ${process.versions.node} (it needs 22.13+ for node:sqlite)`);
    const all = checkouts().flatMap(modelsIn).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const names = new Set(all.map(c => c.servedPath));
    const totalGb = all.reduce((s, c) => s + c.bytes, 0) / GB;
    console.log(`[sweep] ${all.length} files, ${names.size} served paths, ${totalGb.toFixed(1)} GB in ${new Set(all.map(c => c.checkout)).size} checkouts; store ${store.home}; ${freeGb(store.root).toFixed(1)} GB free`);
    if (dryRun) return;

    const report = { recorded: 0, unchanged: 0, failed: [] as string[] };
    const started = Date.now();
    // oldest first, so the newest copy of a name is recorded last and is what the store serves for it
    for (const [i, c] of all.entries()) {
        if (freeGb(store.root) < minFreeGb) {
            console.warn(`[sweep] stopped: under ${minFreeGb} GB free on the store's volume after ${i} of ${all.length} files`);
            break;
        }
        try {
            const known = store.db.scanned(c.file, c.bytes, c.mtimeMs);
            const current = store.db.served(c.servedPath);
            if (known && current?.sha256 === known && store.lookup(c.servedPath)) {
                report.unchanged++;
                continue;
            }
            const stored = store.putFile(c.file, { servedPath: c.servedPath, origin: 'backfill', workspace: c.checkout });
            store.db.rememberScanned(c.file, c.bytes, c.mtimeMs, stored.sha256);
            report.recorded++;
        } catch (err) {
            report.failed.push(`${c.file}: ${(err as Error).message}`);
        }
        if ((i + 1) % 250 === 0) console.log(`[sweep] ${i + 1} / ${all.length} (${((Date.now() - started) / 1000).toFixed(0)} s, ${freeGb(store.root).toFixed(1)} GB free)`);
    }
    console.log(`[sweep] recorded ${report.recorded}, unchanged ${report.unchanged}, failed ${report.failed.length}; ${store.db.countServed()} served paths in the store; ${freeGb(store.root).toFixed(1)} GB free (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    for (const f of report.failed.slice(0, 10)) console.warn(`[sweep] failed: ${f}`);
}

main().catch(err => {
    console.error(`[sweep] ${(err as Error).message}`);
    process.exit(1);
});
