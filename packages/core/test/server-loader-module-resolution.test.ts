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
import { decodePng } from './helpers/png-decode';

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
        targetMeshPath: ${JSON.stringify(mesh)}, outputDir: ${JSON.stringify(work)}, resolution: '1K', archetype: 'corten_steel'
    }, {} as any);
    console.log('RESULT ' + JSON.stringify({ status: (r as any).status, summary: String((r as any).summaryResult).slice(0, 3000) }));
    const x = await pbrMaterialHandlers.pbr_synthesize_material({
        targetMeshPath: ${JSON.stringify(mesh)}, outputDir: ${JSON.stringify(path.join(work, 'mtlx'))}, resolution: '1K', format: 'materialx', archetype: 'corten_steel'
    }, {} as any);
    console.log('MTLX ' + JSON.stringify((x as any).resultPayload.outputFiles));
    const u = await pbrMaterialHandlers.pbr_synthesize_material({
        targetMeshPath: ${JSON.stringify(mesh)}, outputDir: ${JSON.stringify(path.join(work, 'usdz'))}, resolution: '1K', format: 'usdz', archetype: 'corten_steel'
    }, {} as any);
    console.log('USDZ ' + JSON.stringify((u as any).resultPayload.outputFiles));
    const bad = await pbrMaterialHandlers.pbr_synthesize_material({
        targetMeshPath: ${JSON.stringify(mesh)}, outputDir: ${JSON.stringify(path.join(work, 'bad'))}, resolution: '1K', archetype: 'cor_ten_steel'
    }, {} as any).then(() => 'no error', e => e.name + ': ' + e.message.slice(0, 200));
    console.log('BAD ' + JSON.stringify(bad));
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
        expect((json.images || []).length, 'the output GLB carries real texture images').toBeGreaterThan(0);
        expect((json.materials || []).length).toBeGreaterThan(0);
        const material = json.materials[json.meshes[0].primitives[0].material];
        expect(material.pbrMetallicRoughness.baseColorTexture, 'the primitive\'s material samples the albedo image').toBeDefined();
        expect(material.normalTexture).toBeDefined();
        expect(json.images.every((i: any) => i.mimeType === 'image/png')).toBe(true);
        expect(fs.readFileSync(path.join(work, outGlb!)).equals(fs.readFileSync(mesh)), 'the output is not the input').toBe(false);
        expect(out).toMatch(/RESULT \{[^\n]*box_projection_uv/);
        expect(out, 'the texture set came from the native kernel').toMatch(/RESULT \{[^\n]*corten_steel 1024px via native-cpp20/);

        // The primitive samples a real baseColor image through real UVs: decode it from the GLB's BIN chunk
        const glb = fs.readFileSync(path.join(work, outGlb!));
        const jsonLen = glb.readUInt32LE(12);
        const bin = glb.subarray(20 + jsonLen + 8);
        const prim = json.meshes[0].primitives[0];
        expect(prim.attributes.TEXCOORD_0, 'the textured primitive has UVs').toBeDefined();
        const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
        expect(uvAcc.count).toBe(json.accessors[prim.attributes.POSITION].count);
        const decodeImage = (imageIndex: number) => {
            const bv = json.bufferViews[json.images[imageIndex].bufferView];
            return decodePng(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
        };
        const albedo = decodeImage(json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source);
        expect([albedo.width, albedo.height]).toEqual([1024, 1024]);
        const distinct = (png: { pixels: Uint8Array; channels: number }) => {
            const seen = new Set<number>();
            for (let i = 0; i < png.pixels.length; i += png.channels) seen.add(png.pixels[i] << 16 | png.pixels[i + 1] << 8 | png.pixels[i + 2]);
            return seen.size;
        };
        // The kernel's albedo varies only a few levels for this archetype (its character is in the normal / height); still not a flat fill
        expect(distinct(albedo), 'the albedo is not a flat fill').toBeGreaterThan(4);
        const normal = decodeImage(json.textures[material.normalTexture.index].source);
        expect(distinct(normal), 'the normal map carries relief').toBeGreaterThan(200);

        // MaterialX and USDZ companions exist and their PNGs decode
        const line = (tag: string) => JSON.parse(out.split('\n').find(l => l.startsWith(tag + ' '))!.slice(tag.length + 1));
        const mtlxFiles = line('MTLX');
        const mtlx = fs.readFileSync(mtlxFiles.materialx, 'utf8');
        for (const k of ['albedo', 'normal', 'orm']) {
            expect(mtlx).toContain(path.basename(mtlxFiles[k]));
            const png = decodePng(fs.readFileSync(mtlxFiles[k]));
            expect([png.width, png.height], k).toEqual([1024, 1024]);
        }
        const usdz = fs.readFileSync(line('USDZ').usdz);
        const entries = readStoredZip(usdz);
        expect(Object.keys(entries)).toEqual(expect.arrayContaining(['material.usda', 'textures/albedo.png', 'textures/normal.png', 'textures/orm.png']));
        for (const name of ['textures/albedo.png', 'textures/normal.png', 'textures/orm.png']) {
            expect(decodePng(entries[name]).width, name).toBe(1024);
            expect(entries['material.usda'].toString('utf8')).toContain(name);
        }
        const referenced = [...entries['material.usda'].toString('utf8').matchAll(/@([^@]+)@/g)].map(m => m[1]);
        expect(referenced.length).toBeGreaterThanOrEqual(3);
        for (const ref of referenced) expect(entries[ref], `the usda references ${ref}, which the archive must contain`).toBeDefined();

        // An unknown archetype is a typed error listing the valid keys, also through this loader
        expect(line('BAD')).toMatch(/^PbrUnknownArchetypeError: .*cor_ten_steel.*Valid archetypes: indiana_limestone/);
        expect(fs.existsSync(path.join(work, 'bad', 'cylinder_adaptive_pbr.glb'))).toBe(false);
    }, 300_000);
});

/** Entries of a ZIP whose members are STORED (method 0), as USDZ requires; read from the central directory. */
function readStoredZip(zip: Buffer): Record<string, Buffer> {
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd, 'zip end-of-central-directory').toBeGreaterThanOrEqual(0);
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    const out: Record<string, Buffer> = {};
    for (let i = 0; i < count; i++) {
        expect(zip.readUInt32LE(p)).toBe(0x02014b50);
        const method = zip.readUInt16LE(p + 10);
        const size = zip.readUInt32LE(p + 20);
        const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
        const local = zip.readUInt32LE(p + 42);
        const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
        expect(method, `${name} is stored uncompressed`).toBe(0);
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        out[name] = zip.subarray(dataStart, dataStart + size);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
