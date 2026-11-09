#!/usr/bin/env node
/**
 * The job image's TypeScript transpiled once, at image build: every .ts under the given folders gets a .js beside it
 * (esbuild, one file at a time, CommonJS for Node 22, as ts-node's transpile-only mode treats each file on its own), so a
 * task starts on JavaScript instead of transpiling the orchestrator's whole import graph (it took about a minute of a
 * Cloud Run task's start, 2026-11-09). Node resolves an extensionless require to the .js first, and the worker pools
 * already load the .js beside them; a .ts named explicitly still goes through ts-node. A .js already there is kept.
 *
 *   node deploy/kd-chunk-job/transpile.js packages/core/src
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const roots = process.argv.slice(2);
if (!roots.length) { console.error('usage: transpile.js <folder>...'); process.exit(2); }
let files = 0, kept = 0, bytes = 0;
const skipped = [];
/** Build folders hold generated files with a .ts name that are not TypeScript (CMake's compiler_depend.ts). */
const SKIP_DIRS = new Set(['node_modules', 'CMakeFiles', 'build_py', 'dist']);
const t0 = Date.now();
const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
        if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
        const out = p.slice(0, -3) + '.js';
        if (fs.existsSync(out)) { kept++; continue; }
        let r;
        try {
            r = esbuild.transformSync(fs.readFileSync(p, 'utf8'), {
                loader: 'ts', format: 'cjs', platform: 'node', target: 'node22', sourcefile: p,
                tsconfigRaw: { compilerOptions: { target: 'ES2022', esModuleInterop: true, allowSyntheticDefaultImports: true } }
            });
        } catch (err) {
            // left to ts-node, which would fail on it the same way if anything required it
            skipped.push(`${p}: ${String(err.message).split('\n')[1] ?? err.message}`);
            continue;
        }
        fs.writeFileSync(out, r.code);
        files++; bytes += r.code.length;
    }
};
for (const r of roots) walk(path.resolve(r));
console.log(`[transpile] ${files} files to JavaScript (${(bytes / 1e6).toFixed(1)} MB), ${kept} .js already there, ${skipped.length} not transpiled, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const s of skipped) console.log(`[transpile] not transpiled: ${s}`);
