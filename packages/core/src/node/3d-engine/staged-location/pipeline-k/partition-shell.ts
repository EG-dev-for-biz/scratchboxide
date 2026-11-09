/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Partition shell (experiment, 2026-11-09; SCRATCHBOX_K_PARTITION_SHELL=1): pipeline K's polish after the lattice (base
 * cleanup, clip, infill, orient, outside closure with its corner joins, inner core and hole repair) replaced by one closed
 * solid cut from space by K's planes (scripts/partition_shell.cpp over scratchbox_shell_fit.hpp), with K's lattice facades
 * inset on its planar walls and the scan kept only where it stands off the solid.
 *
 * Texturing, per part of the result:
 *   - a shell face on a rebuilt facade's plane, inside that facade's orthophoto: the lattice's own photo through the ortho's
 *     mapping (the lattice's texture coordinates are that same mapping), in the lattice node (FacadeLattice_<id>, its extras
 *     kept, so the twin's facade reader, window fit and materials read it as they read K's);
 *   - the lattice's relief pieces kept (recessed windows, reveals, piers): their own triangles, texture coordinates and photo;
 *   - every other shell face: baked into a new atlas from the cleaned scan's photo, each texel the nearest scan surface facing
 *     within 60 degrees of it within 1.5 m, along its normal (tile-texture-transfer.ts' sampler, not de-lit: the twin de-lights
 *     every photo after); a texel with none is filled from the nearest sampled texel of its chart (generated, counted);
 *   - the residual scan: its own triangles, texture coordinates and photo; its seam skirt: the residual triangle's mapping
 *     carried on (inner-core.ts extendMapping).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { encodePng } from '../png-encode';
import { loadTileSurface } from '../tile-texture-transfer';
import { appendNode, extendMapping, readSoup, type AppendPrim, type Soup } from './inner-core';
import { compileNativeCached, defaultNativeFlags, nativeBuildCacheRoot, nativeBuildEntryBinary, nativeBuildKey, NativeBuildError, type NativeCompileSpec } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';

export const PARTITION_SHELL_VERSION = 'partition-shell/1';

export function partitionShellEnabled(): boolean { return process.env.SCRATCHBOX_K_PARTITION_SHELL === '1'; }

export const PARTITION_SHELL_PARAMS = {
    /** Atlas texel of the baked shell faces (m); the tile's own is about 0.154 m. */
    texelM: 0.12,
    atlasSize: 4096,
    gutter: 2,
    /** A texel samples the scan within this along its normal (m). */
    sampleMaxM: 1.5,
    /** Native: scan farther than this from the shell (and outside it) is kept as measured detail. */
    residualTolM: 0.3
};

function compileSpec(repoRoot: string): NativeCompileSpec {
    return { sourcePath: path.join(repoRoot, 'scripts', 'partition_shell.cpp'), includeDirs: [path.join(repoRoot, 'packages', 'core', 'src', 'native', '3d-engine', 'include')], flags: defaultNativeFlags(), libs: ['-lz'], name: 'partition_shell', timeoutMs: 600_000 };
}

/** Built before the (synchronous) polish runs. */
export async function ensurePartitionShellBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_K_PARTITION_SHELL_BIN) return process.env.SCRATCHBOX_K_PARTITION_SHELL_BIN;
    try { return (await compileNativeCached(compileSpec(repoRoot))).binaryPath; } catch (err) { throw new Error(`could not build partition_shell: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`); }
}

function binarySync(repoRoot = findTileRefineRepoRoot()): string {
    if (process.env.SCRATCHBOX_K_PARTITION_SHELL_BIN) return process.env.SCRATCHBOX_K_PARTITION_SHELL_BIN;
    const bin = nativeBuildEntryBinary(nativeBuildCacheRoot(), nativeBuildKey(compileSpec(repoRoot)).key);
    if (!fs.existsSync(bin)) throw new Error('partition_shell is not built: await ensurePartitionShellBinary() before the polish');
    return bin;
}

interface FacadeRow { facadeId: number; normal: number[]; centroid: number[]; axisS: number[]; axisT: number[]; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number; area_m2: number }

export interface PartitionShellReport {
    version: string;
    native: Record<string, any>;
    photoMaps: Array<{ id: number; fromRow: boolean; fitRms: number; onPlaneShare: number }>;
    bake: { charts: number; atlases: number; texels: number; sampledShare: number; filledShare: number; areaM2: number; ms: number };
    triangles: number;
    nodes: Record<string, number>;
    stepWallTriangles: number;
    ms: { total: number; native: number; assemble: number };
    replacedSteps: string[];
}

const CLAY = (name: string) => ({ name, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } });

/** A GLB holding only the images, textures, samplers and materials of `bytes` (no meshes or nodes), its buffer compacted. */
function materialsOnly(bytes: Uint8Array): { json: any; bin: Uint8Array } {
    const g = parseGlbBytes(bytes);
    const j = g.json;
    const views: any[] = [];
    const chunks: Uint8Array[] = [];
    let len = 0;
    const images = (j.images ?? []).map((im: any) => {
        if (im.bufferView === undefined) return im;
        const bv = j.bufferViews[im.bufferView];
        const data = g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
        views.push({ buffer: 0, byteOffset: len, byteLength: data.length });
        chunks.push(data); len += data.length;
        return { ...im, bufferView: views.length - 1 };
    });
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    const json = { asset: j.asset, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: views, buffers: [{ byteLength: len }], images, textures: j.textures ?? [], samplers: j.samplers ?? [], materials: j.materials ?? [], ...(j.extensionsUsed ? { extensionsUsed: j.extensionsUsed } : {}), ...(j.extras ? { extras: j.extras } : {}) };
    return { json, bin };
}

/** Appends a PNG image, its texture and a material using it; returns the GLB and the material's index. */
function appendImageMaterial(bytes: Uint8Array, png: Uint8Array, name: string): { bytes: Buffer; material: number } {
    const g = parseGlbBytes(bytes);
    const j = g.json;
    const pad = (4 - (g.bin.length % 4)) % 4;
    const bin = new Uint8Array(g.bin.length + pad + png.length);
    bin.set(g.bin, 0); bin.set(png, g.bin.length + pad);
    j.bufferViews ??= []; j.images ??= []; j.textures ??= []; j.materials ??= []; j.samplers ??= [];
    j.bufferViews.push({ buffer: 0, byteOffset: g.bin.length + pad, byteLength: png.length });
    j.images.push({ name, mimeType: 'image/png', bufferView: j.bufferViews.length - 1 });
    j.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    j.textures.push({ source: j.images.length - 1, sampler: j.samplers.length - 1 });
    j.materials.push({ name, pbrMetallicRoughness: { baseColorTexture: { index: j.textures.length - 1 }, metallicFactor: 0, roughnessFactor: 0.9 } });
    j.buffers = [{ ...(j.buffers?.[0] ?? {}), byteLength: bin.length }];
    return { bytes: assembleGlb(j, bin), material: j.materials.length - 1 };
}

function flatNormals(P: Float32Array): Float32Array {
    const N = new Float32Array(P.length);
    for (let t = 0; t < P.length; t += 9) {
        const e1 = [P[t + 3] - P[t], P[t + 4] - P[t + 1], P[t + 5] - P[t + 2]], e2 = [P[t + 6] - P[t], P[t + 7] - P[t + 1], P[t + 8] - P[t + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) N[t + k * 3 + c] = n[c] / l;
    }
    return N;
}

/**
 * The partition shell in place of K's polish after the lattice. `cleanedTex` is the textured scan as cleaned (before the
 * lattice), `latticeTex` the textured model after the lattice (its FacadeLattice nodes are what is inset).
 */
export function buildPartitionShell(cleanedTex: Uint8Array, latticeTex: Uint8Array, orthosDir: string, opts: { threads?: number } = {}, P = PARTITION_SHELL_PARAMS): { clay: Buffer; tex: Buffer; report: PartitionShellReport } {
    const t0 = Date.now();
    const scan: Soup = readSoup(parseGlbBytes(cleanedTex));
    const latG = parseGlbBytes(latticeTex);
    const lat: Soup = readSoup(latG, name => !name.startsWith('FacadeLattice_'));
    const latFacade = Int32Array.from(lat.node, ni => latG.json.nodes[ni]?.extras?.sbFacadeLattice?.facadeId ?? -1);
    const latExtras = new Map<number, any>();
    const latMaterial = new Map<number, number>();
    for (let t = 0; t < latFacade.length; t++) if (!latExtras.has(latFacade[t])) { latExtras.set(latFacade[t], latG.json.nodes[lat.node[t]].extras); latMaterial.set(latFacade[t], lat.material[t]); }
    const facades: FacadeRow[] = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades;
    const byId = new Map(facades.map(f => [f.facadeId, f] as const));
    // every rebuilt facade's plane and photo mapping read from its own lattice (a wall sheet, id >= 10000, has no row in
    // facades.json; a facade's row gives its plane exactly): the on-plane triangles' texture coordinates are an affine map of
    // the plane's (s, t), fitted by least squares and refitted on the corners within 0.002 of it
    const maps = new Map<number, { row: FacadeRow; A: number[]; B: number[]; fitRms: number; onPlaneShare: number }>();
    {
        const byFac = new Map<number, number[]>();
        for (let t = 0; t < latFacade.length; t++) { const l = byFac.get(latFacade[t]); if (l) l.push(t); else byFac.set(latFacade[t], [t]); }
        const triN = (t: number) => { const p = lat.pos; const e1 = [p[t * 9 + 3] - p[t * 9], p[t * 9 + 4] - p[t * 9 + 1], p[t * 9 + 5] - p[t * 9 + 2]], e2 = [p[t * 9 + 6] - p[t * 9], p[t * 9 + 7] - p[t * 9 + 1], p[t * 9 + 8] - p[t * 9 + 2]]; const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(n[0], n[1], n[2]); return { n: l > 0 ? n.map(x => x / l) : [0, 0, 0], a: l / 2 }; };
        for (const [fid, tris] of byFac) {
            let row = byId.get(fid);
            if (!row) {
                // the plane: the facing holding the most area (normals binned at 5 degrees), its offset the area-weighted median
                const bins = new Map<string, { n: number[]; a: number; tris: number[] }>();
                for (const t of tris) { const { n, a } = triN(t); if (!(a > 0)) continue; const k = n.map(x => Math.round(x * 12)).join(','); const b = bins.get(k) ?? { n: [0, 0, 0], a: 0, tris: [] }; b.n = b.n.map((x, i) => x + n[i] * a); b.a += a; b.tris.push(t); bins.set(k, b); }
                const best = [...bins.values()].sort((x, y) => y.a - x.a)[0];
                if (!best) continue;
                const nl = Math.hypot(best.n[0], best.n[1], best.n[2]); const n = best.n.map(x => x / nl);
                const offs = best.tris.map(t => { const c = [0, 1, 2].map(k => (lat.pos[t * 9 + k] + lat.pos[t * 9 + 3 + k] + lat.pos[t * 9 + 6 + k]) / 3); return { d: c[0] * n[0] + c[1] * n[1] + c[2] * n[2], a: triN(t).a, c }; }).sort((x, y) => x.d - y.d);
                let acc = 0, d = offs[0].d; const half = offs.reduce((q, o) => q + o.a, 0) / 2; for (const o of offs) { acc += o.a; if (acc >= half) { d = o.d; break; } }
                const cen = offs.reduce((q, o) => q.map((x, i) => x + o.c[i] * o.a), [0, 0, 0]).map(x => x / (2 * half));
                const cd = cen[0] * n[0] + cen[1] * n[1] + cen[2] * n[2] - d; const c = cen.map((x, i) => x - n[i] * cd);
                const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
                const tl = up.map((x, i) => x - n[i] * (up[0] * n[0] + up[1] * n[1] + up[2] * n[2])); const tll = Math.hypot(tl[0], tl[1], tl[2]); const T = tl.map(x => x / tll);
                const S = [T[1] * n[2] - T[2] * n[1], T[2] * n[0] - T[0] * n[2], T[0] * n[1] - T[1] * n[0]];
                row = { facadeId: fid, normal: n, centroid: c, axisS: S, axisT: T, orthoSMin: 0, orthoTMax: 0, pixel: 0, width: 0, height: 0, area_m2: 2 * half };
            }
            const r = row;
            const st: number[][] = [], uv: number[][] = [];
            for (const t of tris) {
                const { n } = triN(t);
                if (Math.abs(n[0] * r.normal[0] + n[1] * r.normal[1] + n[2] * r.normal[2]) < 0.95) continue;
                for (let k = 0; k < 3; k++) {
                    const q = [lat.pos[t * 9 + k * 3] - r.centroid[0], lat.pos[t * 9 + k * 3 + 1] - r.centroid[1], lat.pos[t * 9 + k * 3 + 2] - r.centroid[2]];
                    if (Math.abs(q[0] * r.normal[0] + q[1] * r.normal[1] + q[2] * r.normal[2]) > 0.03) continue;
                    st.push([q[0] * r.axisS[0] + q[1] * r.axisS[1] + q[2] * r.axisS[2], q[0] * r.axisT[0] + q[1] * r.axisT[1] + q[2] * r.axisT[2]]);
                    uv.push([lat.uv[t * 6 + k * 2], lat.uv[t * 6 + k * 2 + 1]]);
                }
            }
            if (st.length < 12) continue;
            const fit = (idx: number[]) => {
                const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
                for (const i of idx) { const x = [st[i][0], st[i][1], 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a][b] += x[a] * x[b]; bu[a] += x[a] * uv[i][0]; bv[a] += x[a] * uv[i][1]; } }
                const solve = (b: number[]) => { const m = M.map((row, i) => [...row, b[i]]); for (let c = 0; c < 3; c++) { let p = c; for (let r2 = c + 1; r2 < 3; r2++) if (Math.abs(m[r2][c]) > Math.abs(m[p][c])) p = r2; [m[c], m[p]] = [m[p], m[c]]; for (let r2 = 0; r2 < 3; r2++) if (r2 !== c) { const f = m[r2][c] / m[c][c]; for (let k = c; k < 4; k++) m[r2][k] -= f * m[c][k]; } } return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]; };
                return { A: solve(bu), B: solve(bv) };
            };
            let all = st.map((_, i) => i);
            let f = fit(all);
            const res = (i: number) => Math.hypot(f.A[0] * st[i][0] + f.A[1] * st[i][1] + f.A[2] - uv[i][0], f.B[0] * st[i][0] + f.B[1] * st[i][1] + f.B[2] - uv[i][1]);
            const inl = all.filter(i => res(i) < 0.002);
            if (inl.length >= 12) { f = fit(inl); all = inl; }
            const rms = Math.sqrt(all.reduce((q, i) => q + res(i) ** 2, 0) / all.length);
            if (![...f.A, ...f.B].every(Number.isFinite)) continue;
            maps.set(fid, { row: r, A: f.A, B: f.B, fitRms: rms, onPlaneShare: inl.length / st.length });
        }
    }

    // ---------------------------------------------------------------- native
    const parts: Buffer[] = [Buffer.from('PSH1')];
    const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
    const f32 = (a: Float32Array) => parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    u32(scan.pos.length / 9); f32(scan.pos);
    u32(lat.pos.length / 9); f32(lat.pos); parts.push(Buffer.from(latFacade.buffer, latFacade.byteOffset, latFacade.byteLength));
    const rows: Array<{ row: FacadeRow; A: number[]; B: number[]; rebuilt: boolean }> = [...maps.values()].map(m => ({ row: m.row, A: m.A, B: m.B, rebuilt: true }));
    for (const f of facades) if (!maps.has(f.facadeId)) rows.push({ row: f, A: [0, 0, 0], B: [0, 0, 0], rebuilt: false });
    u32(rows.length);
    for (const { row: f, A, B, rebuilt } of rows) {
        const b = Buffer.alloc(4 + 8 * 19 + 1);
        b.writeInt32LE(f.facadeId, 0);
        [...f.normal, ...f.centroid, ...f.axisS, ...f.axisT, ...A, ...B, f.area_m2].forEach((v, i) => b.writeDoubleLE(v, 4 + i * 8));
        b.writeUInt8(rebuilt ? 1 : 0, 4 + 8 * 19);
        parts.push(b);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partition-shell-'));
    const inFile = path.join(dir, 'in.bin'), outFile = path.join(dir, 'out.bin'), repFile = path.join(dir, 'report.json');
    fs.writeFileSync(inFile, Buffer.concat(parts));
    const tn = Date.now();
    const run = spawnSync(binarySync(), ['--input', inFile, '--output', outFile, '--report', repFile, '--set', 'residualTolM', String(P.residualTolM), '--set', 'threads', String(opts.threads ?? Math.max(1, os.cpus().length))], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 1_800_000 });
    const msNative = Date.now() - tn;
    const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
    let ok = false;
    try { ok = JSON.parse(line).ok === true; } catch { /* reported below */ }
    if (!ok) throw new Error(`partition_shell failed: ${line || run.stderr?.slice(-800) || run.error}`);
    const native = JSON.parse(fs.readFileSync(repFile, 'utf8'));
    const ob = fs.readFileSync(outFile);
    fs.rmSync(dir, { recursive: true, force: true });
    let o = 4;
    const nV = ob.readUInt32LE(o); o += 4;
    const V = new Float32Array(ob.buffer.slice(ob.byteOffset + o, ob.byteOffset + o + nV * 12)); o += nV * 12;
    const nT = ob.readUInt32LE(o); o += 4;
    const I = new Uint32Array(ob.buffer.slice(ob.byteOffset + o, ob.byteOffset + o + nT * 12)); o += nT * 12;
    const kind = new Uint8Array(nT), ref = new Int32Array(nT), fac = new Int32Array(nT);
    for (let t = 0; t < nT; t++) { kind[t] = ob.readUInt8(o); ref[t] = ob.readInt32LE(o + 1); fac[t] = ob.readInt32LE(o + 5); o += 10; }
    const vtx = (t: number, k: number) => { const v = I[t * 3 + k]; return [V[v * 3], V[v * 3 + 1], V[v * 3 + 2]]; };

    // ---------------------------------------------------------------- bake the other shell faces
    const tb = Date.now();
    const bakeTris: number[] = [];
    for (let t = 0; t < nT; t++) if (kind[t] === 0) bakeTris.push(t);
    // charts: kind-0 triangles joined across shared edges when coplanar (normals within 1 degree, same plane within 2 cm)
    const nrm = (t: number) => { const a = vtx(t, 0), b = vtx(t, 1), c = vtx(t, 2); const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const l = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };
    const parent = new Int32Array(bakeTris.length).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const normals = bakeTris.map(nrm);
    {
        const edgeOwner = new Map<string, number>();
        bakeTris.forEach((t, i) => {
            for (let k = 0; k < 3; k++) {
                const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
                const key = a < b ? `${a},${b}` : `${b},${a}`;
                const j = edgeOwner.get(key);
                if (j === undefined) { edgeOwner.set(key, i); continue; }
                const ni = normals[i], nj = normals[j];
                if (ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2] < Math.cos(Math.PI / 180)) continue;
                const ri = find(i), rj = find(j);
                if (ri !== rj) parent[ri] = rj;
            }
        });
    }
    const charts = new Map<number, number[]>();
    bakeTris.forEach((_, i) => { const r = find(i); const l = charts.get(r); if (l) l.push(i); else charts.set(r, [i]); });
    interface Chart { list: number[]; n: number[]; u: number[]; v: number[]; u0: number; v0: number; w: number; h: number; texel: number; atlas: number; x: number; y: number }
    const chartList: Chart[] = [];
    for (const list of charts.values()) {
        let n = [0, 0, 0];
        for (const i of list) { const a = vtx(bakeTris[i], 0), b = vtx(bakeTris[i], 1), c = vtx(bakeTris[i], 2); const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; n = [n[0] + e1[1] * e2[2] - e1[2] * e2[1], n[1] + e1[2] * e2[0] - e1[0] * e2[2], n[2] + e1[0] * e2[1] - e1[1] * e2[0]]; }
        const nl = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map(x => x / nl);
        const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]]; const ul = Math.hypot(u[0], u[1], u[2]); u = u.map(x => x / ul);
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const i of list) for (let k = 0; k < 3; k++) { const p = vtx(bakeTris[i], k); const pu = p[0] * u[0] + p[1] * u[1] + p[2] * u[2], pv = p[0] * v[0] + p[1] * v[1] + p[2] * v[2]; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
        let texel = P.texelM;
        const maxDim = P.atlasSize / 2 - 2 * P.gutter;
        texel = Math.max(texel, (u1 - u0) / maxDim, (v1 - v0) / maxDim);
        chartList.push({ list, n, u, v, u0, v0, w: Math.max(1, Math.ceil((u1 - u0) / texel)) + 1, h: Math.max(1, Math.ceil((v1 - v0) / texel)) + 1, texel, atlas: 0, x: 0, y: 0 });
    }
    // shelf packing, tallest first
    chartList.sort((a, b) => b.h - a.h);
    let atlas = 0, sx = 0, sy = 0, shelf = 0;
    for (const c of chartList) {
        const W = c.w + 2 * P.gutter, H = c.h + 2 * P.gutter;
        if (sx + W > P.atlasSize) { sx = 0; sy += shelf; shelf = 0; }
        if (sy + H > P.atlasSize) { atlas++; sx = 0; sy = 0; shelf = 0; }
        c.atlas = atlas; c.x = sx + P.gutter; c.y = sy + P.gutter; sx += W; shelf = Math.max(shelf, H);
    }
    const nAtlas = chartList.length ? atlas + 1 : 0;
    const surface = loadTileSurface(cleanedTex, { delight: false });
    const images: Uint8Array[] = [];
    const bakeUv = new Float32Array(nT * 6);
    let texels = 0, sampled = 0, filled = 0, bakeArea = 0;
    for (let a = 0; a < nAtlas; a++) {
        const S = P.atlasSize;
        const rgba = new Uint8Array(S * S * 4);
        const has = new Uint8Array(S * S);   // 0 none, 1 inside a chart (unsampled), 2 sampled
        const owner = new Int32Array(S * S).fill(-1);
        chartList.forEach((c, ci) => {
            if (c.atlas !== a) return;
            const toPx = (p: number[]) => [c.x + ((p[0] * c.u[0] + p[1] * c.u[1] + p[2] * c.u[2]) - c.u0) / c.texel, c.y + ((p[0] * c.v[0] + p[1] * c.v[1] + p[2] * c.v[2]) - c.v0) / c.texel];
            for (const i of c.list) {
                const t = bakeTris[i];
                const q = [vtx(t, 0), vtx(t, 1), vtx(t, 2)];
                const px = q.map(toPx);
                for (let k = 0; k < 3; k++) { bakeUv[t * 6 + k * 2] = px[k][0] / S; bakeUv[t * 6 + k * 2 + 1] = px[k][1] / S; }
                const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
                bakeArea += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
                // rasterise (texel centres, with half a texel of slack so thin triangles are covered)
                const x0 = Math.max(0, Math.floor(Math.min(px[0][0], px[1][0], px[2][0]) - 1)), x1 = Math.min(S - 1, Math.ceil(Math.max(px[0][0], px[1][0], px[2][0]) + 1));
                const y0 = Math.max(0, Math.floor(Math.min(px[0][1], px[1][1], px[2][1]) - 1)), y1 = Math.min(S - 1, Math.ceil(Math.max(px[0][1], px[1][1], px[2][1]) + 1));
                const den = (px[1][1] - px[2][1]) * (px[0][0] - px[2][0]) + (px[2][0] - px[1][0]) * (px[0][1] - px[2][1]);
                if (Math.abs(den) < 1e-12) continue;
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const cx = x + 0.5, cy = y + 0.5;
                    const w0 = ((px[1][1] - px[2][1]) * (cx - px[2][0]) + (px[2][0] - px[1][0]) * (cy - px[2][1])) / den;
                    const w1 = ((px[2][1] - px[0][1]) * (cx - px[2][0]) + (px[0][0] - px[2][0]) * (cy - px[2][1])) / den;
                    const w2 = 1 - w0 - w1;
                    const slack = -0.75 / Math.max(1, Math.sqrt(Math.abs(den)));
                    if (w0 < slack || w1 < slack || w2 < slack) continue;
                    const pi = y * S + x;
                    if (has[pi]) continue;
                    has[pi] = 1; owner[pi] = ci; texels++;
                    const p = [0, 1, 2].map(k => w0 * q[0][k] + w1 * q[1][k] + w2 * q[2][k]);
                    const s = surface.sample(p as [number, number, number], c.n as [number, number, number], P.sampleMaxM);
                    if (!s) continue;
                    const lin = s.litLinear ?? s.rgb;
                    const to8 = (x: number) => s.litLinear ? Math.round(255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055))) : Math.round(Math.min(255, Math.max(0, x)));
                    rgba[pi * 4] = to8(lin[0]); rgba[pi * 4 + 1] = to8(lin[1]); rgba[pi * 4 + 2] = to8(lin[2]); rgba[pi * 4 + 3] = 255;
                    has[pi] = 2; sampled++;
                }
            }
        });
        // fill: unsampled chart texels and the gutters from the nearest sampled texel of the same chart (rings outward)
        let frontier: number[] = [];
        for (let i = 0; i < S * S; i++) if (has[i] === 2) frontier.push(i);
        const done = new Uint8Array(S * S);
        for (const i of frontier) done[i] = 1;
        for (let ring = 0; ring < 64 && frontier.length; ring++) {
            const next: number[] = [];
            for (const i of frontier) {
                const x = i % S, y = (i / S) | 0;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
                    const j = yy * S + xx;
                    if (done[j]) continue;
                    if (has[j] === 1 && owner[j] !== owner[i]) continue;
                    if (has[j] === 0) { const cj = chartList[owner[i]]; if (!cj || xx < cj.x - P.gutter || yy < cj.y - P.gutter || xx >= cj.x + cj.w + P.gutter || yy >= cj.y + cj.h + P.gutter) continue; owner[j] = owner[i]; }
                    else filled++;
                    rgba.copyWithin(j * 4, i * 4, i * 4 + 4);
                    done[j] = 1; next.push(j);
                }
            }
            frontier = next;
        }
        // chart texels nothing reached: the scan has no photo near that face at all
        for (let i = 0; i < S * S; i++) if (has[i] === 1 && !done[i]) { rgba[i * 4] = 140; rgba[i * 4 + 1] = 135; rgba[i * 4 + 2] = 128; rgba[i * 4 + 3] = 255; }
        images.push(encodePng(S, S, rgba, 4));
    }
    const msBake = Date.now() - tb;

    // ---------------------------------------------------------------- assemble
    const ta = Date.now();
    const base = materialsOnly(latticeTex);
    let tex: Buffer = assembleGlb(base.json, base.bin);
    const atlasMaterials: number[] = [];
    images.forEach((png, i) => { const r = appendImageMaterial(tex, png, `PartitionShellBake_${i}`); tex = r.bytes; atlasMaterials.push(r.material); });
    const chartOf = new Int32Array(nT).fill(-1);
    chartList.forEach((c, ci) => { for (const i of c.list) chartOf[bakeTris[i]] = ci; });
    type Group = { tris: number[]; uv: number[][][]; mat: number | Record<string, unknown> };
    const nodes = new Map<string, Map<string, Group>>();
    const put = (node: string, matKey: string, mat: number | Record<string, unknown>, t: number, uv: number[][] | undefined) => {
        let m = nodes.get(node); if (!m) { m = new Map(); nodes.set(node, m); }
        let g = m.get(matKey); if (!g) { g = { tris: [], uv: [], mat }; m.set(matKey, g); }
        g.tris.push(t); g.uv.push(uv ?? []);
    };
    const orthoUv = (fid: number, p: number[]) => {
        const m = maps.get(fid)!, f = m.row;
        const d = [p[0] - f.centroid[0], p[1] - f.centroid[1], p[2] - f.centroid[2]];
        const s = d[0] * f.axisS[0] + d[1] * f.axisS[1] + d[2] * f.axisS[2], tt = d[0] * f.axisT[0] + d[1] * f.axisT[1] + d[2] * f.axisT[2];
        return [m.A[0] * s + m.A[1] * tt + m.A[2], m.B[0] * s + m.B[1] * tt + m.B[2]];
    };
    let stepWalls = 0;
    for (let t = 0; t < nT; t++) {
        const k = kind[t];
        if (k === 0) {
            const c = chartList[chartOf[t]];
            put('PartitionShell', `atlas${c.atlas}`, atlasMaterials[c.atlas], t, [0, 1, 2].map(j => [bakeUv[t * 6 + j * 2], bakeUv[t * 6 + j * 2 + 1]]));
        } else if (k === 1) {
            // a step wall (facing across the plane) is unfolded into it about its shallowest corner's depth, so its photo is the
            // facade's texels beside the step, not one texel stretched over its depth
            const f = maps.get(fac[t])!.row;
            const q = [vtx(t, 0), vtx(t, 1), vtx(t, 2)];
            const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
            const wn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const wl = Math.hypot(wn[0], wn[1], wn[2]) || 1;
            const cosN = (wn[0] * f.normal[0] + wn[1] * f.normal[1] + wn[2] * f.normal[2]) / wl;
            if (Math.abs(cosN) < 0.3) {
                const depth = q.map(p => (p[0] - f.centroid[0]) * f.normal[0] + (p[1] - f.centroid[1]) * f.normal[1] + (p[2] - f.centroid[2]) * f.normal[2]);
                const top = Math.max(...depth);
                const w = wn.map(x => x / wl);
                put(`FacadeLattice_${fac[t]}`, `m${latMaterial.get(fac[t])}`, latMaterial.get(fac[t])!, t, q.map((p, j) => orthoUv(fac[t], [0, 1, 2].map(k => p[k] + w[k] * (top - depth[j])))));
                stepWalls++;
            } else put(`FacadeLattice_${fac[t]}`, `m${latMaterial.get(fac[t])}`, latMaterial.get(fac[t])!, t, q.map(p => orthoUv(fac[t], p)));
        } else if (k === 2) {
            const s = ref[t];
            put(`FacadeLattice_${fac[t]}`, `m${lat.material[s]}`, lat.material[s], t, [0, 1, 2].map(j => [lat.uv[s * 6 + j * 2], lat.uv[s * 6 + j * 2 + 1]]));
        } else if (k === 3 || k === 4) {
            const s = ref[t];
            const node = k === 3 ? 'ResidualScan' : 'ShellSeam';
            if (scan.kind[s] === 0 || scan.material[s] < 0) { put(node, 'clay', CLAY(node), t, undefined); continue; }
            let uv: number[][] | undefined;
            if (k === 3) {
                // the residual triangle may have been written reversed: match its corners to the scan's by position
                const src = [0, 1, 2].map(j => [scan.pos[s * 9 + j * 3], scan.pos[s * 9 + j * 3 + 1], scan.pos[s * 9 + j * 3 + 2]]);
                uv = [0, 1, 2].map(j => { const p = vtx(t, j); let best = 0, bd = Infinity; src.forEach((q, qi) => { const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (d < bd) { bd = d; best = qi; } }); return [scan.uv[s * 6 + best * 2], scan.uv[s * 6 + best * 2 + 1]]; });
            } else uv = extendMapping(scan.pos.subarray(s * 9, s * 9 + 9), scan.uv.subarray(s * 6, s * 6 + 6), [0, 1, 2].map(j => vtx(t, j)));
            if (!uv || !uv.every(x => Number.isFinite(x[0]) && Number.isFinite(x[1]))) { put(node, 'clay', CLAY(node), t, undefined); continue; }
            put(node, `m${scan.material[s]}`, scan.material[s], t, uv);
        }
    }
    const extrasFor = (node: string): Record<string, unknown> => {
        const prov = { version: PARTITION_SHELL_VERSION };
        if (node.startsWith('FacadeLattice_')) { const f = Number(node.slice('FacadeLattice_'.length)); return { ...(latExtras.get(f) ?? {}), sbPartitionShell: { ...prov, part: 'facade: shell face in the ortho (the lattice photo, its mapping) + the lattice relief kept' } }; }
        if (node === 'PartitionShell') return { sbPartitionShell: { ...prov, part: 'shell faces off the rebuilt facades', provenance: { geometry: 'measured where the scan supports the face within 0.5 m, else generated (the min-cut closed a gap)', texture: { label: 'photo-inferred', method: 'baked from the cleaned scan photo, nearest surface facing within 60 deg within 1.5 m; unsampled texels filled from the nearest sampled texel (generated)' } } } };
        if (node === 'ResidualScan') return { sbPartitionShell: { ...prov, part: 'scan farther than the residual tolerance from the shell and outside it', provenance: { label: 'measured' } } };
        return { sbPartitionShell: { ...prov, part: 'skirt joining the residual scan to the shell', provenance: { label: 'generated', method: "each open residual edge within reach joined to its closest points on the shell; the residual triangle's mapping carried on" } } };
    };
    let clay: Buffer = assembleGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], materials: [] }, new Uint8Array(0));
    const nodeCounts: Record<string, number> = {};
    for (const [node, groups] of nodes) {
        const texPrims: AppendPrim[] = [];
        const clayPos: Float32Array[] = [];
        let count = 0;
        for (const g of groups.values()) {
            const P9 = new Float32Array(g.tris.length * 9);
            g.tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const p = vtx(t, k); P9.set(p, i * 9 + k * 3); } });
            const N9 = flatNormals(P9);
            const hasUv = g.uv.every(u => u.length === 3);
            const UV = hasUv ? new Float32Array(g.tris.length * 6) : undefined;
            if (UV) g.uv.forEach((u, i) => u.forEach((x, k) => { UV[i * 6 + k * 2] = x[0]; UV[i * 6 + k * 2 + 1] = x[1]; }));
            texPrims.push({ positions: P9, normals: N9, ...(UV ? { uv: UV } : {}), material: g.mat });
            clayPos.push(P9);
            count += g.tris.length;
        }
        const extras = extrasFor(node);
        tex = appendNode(tex, texPrims, node, extras);
        const all = new Float32Array(clayPos.reduce((s, a) => s + a.length, 0));
        let off = 0; for (const a of clayPos) { all.set(a, off); off += a.length; }
        clay = appendNode(clay, [{ positions: all, normals: flatNormals(all), material: CLAY(node) }], node, extras);
        nodeCounts[node.startsWith('FacadeLattice_') ? 'FacadeLattice' : node] = (nodeCounts[node.startsWith('FacadeLattice_') ? 'FacadeLattice' : node] ?? 0) + count;
    }
    // a rebuilt facade's mesh is named as the lattice names it (material-regions.ts finds rebuilt facades by it)
    const renameMeshes = (bytes: Buffer): Buffer => {
        const g = parseGlbBytes(bytes);
        for (const n of g.json.nodes ?? []) { const m = /^FacadeLattice_(\d+)$/.exec(n.name ?? ''); if (m && n.mesh !== undefined) g.json.meshes[n.mesh].name = `facade_lattice_${m[1]}`; }
        return assembleGlb(g.json, g.bin);
    };
    tex = renameMeshes(tex); clay = renameMeshes(clay);
    const report: PartitionShellReport = {
        version: PARTITION_SHELL_VERSION, native, photoMaps: [...maps].map(([id, m]) => ({ id, fromRow: byId.has(id), fitRms: Number(m.fitRms.toExponential(2)), onPlaneShare: Number(m.onPlaneShare.toFixed(3)) })),
        bake: { charts: chartList.length, atlases: nAtlas, texels, sampledShare: texels ? sampled / texels : 0, filledShare: texels ? (texels - sampled) / texels : 0, areaM2: Math.round(bakeArea), ms: msBake },
        triangles: nT, nodes: nodeCounts, stepWallTriangles: stepWalls,
        ms: { total: Date.now() - t0, native: msNative, assemble: Date.now() - ta },
        replacedSteps: ['base', 'clip', 'infill', 'orient', 'closure (corner join, inner core, hole repair)', "lattice's scan cut, tear and proud audits (run, output not used)"]
    };
    return { clay, tex, report };
}
