/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The API server runs the TypeScript source through ts-node as CommonJS (desktop-app `server:dev`), not through
 * vitest or the Vite bundler. Those two quietly map `import('./x.js')` to `x.ts`; Node's CommonJS loader does not.
 * A `.js` ending on a relative import therefore passed every test and then failed in the app the first time the
 * tool ran: "Cannot find module './native-material-pbr-service.js'" from pbr_synthesize_material.
 *
 * Two checks, both against the server's own loader: every relative specifier in the server-loaded code resolves
 * as the CommonJS loader would, and pbr_synthesize_material really runs through its adaptive path in a ts-node child.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { cylinderMesh, readGlbJson, writeFixtureGlb } from './helpers/mesh-glb-fixtures';

const REPO = path.resolve(__dirname, '../../..');
/**
 * The directories ts-node loads on the server. Browser code (packages/core/src/browser) is bundled by Vite, which does
 * resolve ".js" to ".ts", so it is not checked here.
 */
const SERVER_DIRS = ['packages/core/src/node', 'packages/core/src/common', 'desktop-app/server'];
/** Run by `tsx` (see .claude/mcp_settings.json), which maps `.js` to `.ts` itself, so its `.js` endings are right. */
const TSX_ENTRY_POINTS = new Set(['packages/core/src/node/mcp/scratchbox-mcp-server.ts']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

/** True for `import type ... from '...'` and `export type ... from '...'`, which TypeScript erases at compile time. */
function isTypeOnlyStatement(text: string, specifierIndex: number): boolean {
    const start = Math.max(text.lastIndexOf('\nimport ', specifierIndex), text.lastIndexOf('\nexport ', specifierIndex));
    return start >= 0 && /^\s*(import|export)\s+type\b/.test(text.slice(start, specifierIndex));
}

/** What Node's CommonJS loader (with the .ts/.tsx extensions ts-node registers) finds for a relative specifier. */
function resolvesAsCommonJs(fromFile: string, specifier: string): boolean {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
    if (isFile(base)) return true;
    for (const ext of ['.js', '.json', '.node', '.ts', '.tsx']) if (isFile(base + ext)) return true;
    for (const ext of ['.js', '.ts', '.tsx']) if (isFile(path.join(base, 'index' + ext))) return true;
    return false;
}

describe('code the API server loads through ts-node (CommonJS)', () => {
    it('has no relative import that only vitest or the bundler can resolve', () => {
        const unresolved: string[] = [];
        for (const dir of SERVER_DIRS) {
            for (const file of sourceFiles(path.join(REPO, dir))) {
                const rel = path.relative(REPO, file);
                if (TSX_ENTRY_POINTS.has(rel)) continue;
                const text = fs.readFileSync(file, 'utf8');
                for (const m of text.matchAll(SPECIFIER)) {
                    if (m[2].includes('${') || m[2].includes('{')) continue; // a path inside a code generator's template, not a module specifier
                    if (isTypeOnlyStatement(text, m.index!)) continue; // erased before it runs
                    if (!resolvesAsCommonJs(file, m[2])) {
                        unresolved.push(`${rel}:${text.slice(0, m.index).split('\n').length}  ${m[2]}`);
                    }
                }
            }
        }
        expect(unresolved, `these specifiers fail under ts-node CommonJS (drop the ".js" ending):\n${unresolved.join('\n')}`).toEqual([]);
    });

    it('runs pbr_synthesize_material on a mesh through the same loader the server uses', () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-loader-pbr-'));
        const mesh = writeFixtureGlb(path.join(work, 'cylinder.glb'), cylinderMesh(1, 4, 24, 8));
        const runner = path.join(work, 'run.ts');
        fs.writeFileSync(runner, `
import { pbrMaterialHandlers } from ${JSON.stringify(path.join(REPO, 'packages/core/src/node/gemini/tools/pbr-material-tools'))};
(async () => {
    const r = await pbrMaterialHandlers.pbr_synthesize_material({
        targetMeshPath: ${JSON.stringify(mesh)}, outputDir: ${JSON.stringify(work)}, resolution: '1K'
    }, {} as any);
    console.log('RESULT ' + JSON.stringify({ status: (r as any).status, summary: String((r as any).summaryResult).slice(0, 300) }));
})().catch(e => { console.log('THREW ' + (e && e.message)); process.exit(1); });
`);
        const tsNode = path.join(REPO, 'node_modules/.bin/ts-node');
        const run = spawnSync(tsNode, ['--transpile-only', '-P', path.join(REPO, 'desktop-app/tsconfig.electron.json'), runner],
            { cwd: path.join(REPO, 'desktop-app'), encoding: 'utf8', timeout: 240_000, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' } });
        const out = `${run.stdout}\n${run.stderr}`;
        expect(out, out.slice(-1500)).not.toMatch(/Cannot find module/);
        expect(out, out.slice(-1500)).toMatch(/RESULT \{/);
        const outGlb = fs.readdirSync(work).find(f => f.endsWith('_adaptive_pbr.glb'));
        expect(outGlb, `no adaptive_pbr GLB written: ${fs.readdirSync(work).join(', ')}`).toBeTruthy();
        const json = readGlbJson(path.join(work, outGlb!));
        expect((json.materials || []).length).toBeGreaterThan(0);
    }, 300_000);
});
