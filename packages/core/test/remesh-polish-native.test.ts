/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's native remesh-polish steps against their TypeScript (remesh-polish-native.ts; SCRATCHBOX_K_NATIVE_POLISH=0
 * keeps the TypeScript), both compiled with the real clang++ through the native build cache:
 * - the window fit (scratchbox_window_fit.hpp) on synthetic straightened facades whose readings differ (punched windows
 *   over a shopfront with a corner the photo never reached, glass strips with mullions and coloured spandrels, a narrow
 *   tower face of one window column, two wings of different rhythm): the same accepted bands and band reports, and the
 *   same windows, lattice sites and panes, each within one texel;
 * - the infill (scratchbox_open_loop_fill.hpp) on synthetic shells with holes (flat holes, one wrapping a corner, the open
 *   base under a footprint, a hole in a rebuilt wall, a doubled skin): the same report, the same loops closed with the
 *   same triangle count, the same GLBs to the byte;
 * - one timing line of each, TypeScript against native, on the largest case.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { fillOpenLoops } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { ensureRemeshPolishBinary, nativePolishThreads } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { remeshWorkerThreads, runRemeshJobs } from '../src/node/3d-engine/staged-location/remesh-worker-pool';
import { ensureReliefBandBinary, fitOrthoFacades, fitOrthoFacadesNative, orthoFacades, WINDOW_FIT_PARAMS, type WindowFitEntry, type WindowRect } from '../src/node/3d-engine/staged-location/window-fit';

// ------------------------------------------------------------------------------------------------ synthetic facades

/** A small deterministic noise in [-1, 1] per texel. */
const noise = (x: number, y: number, seed: number) => { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return 2 * (s - Math.floor(s)) - 1; };

interface Synthetic { id: number; width: number; height: number; pixel: number; colour: (s: number, t: number, x: number, y: number) => [number, number, number] | undefined; uncovered?: (x: number, y: number) => boolean }

/**
 * Punched 1.2 x 2 m windows every 3 m along and 4 m up a 30 x 24 m wall over a 4 m shopfront, lit from the left: one window
 * lit (a light pane in a dark frame), the photo never reaching the top-right corner nor one window site mid-wall.
 */
const punched: Synthetic = {
    id: 1, width: 300, height: 240, pixel: 0.1,
    colour: (s, t, x, y) => {
        const lit = 1 - 0.15 * (x / 300), n = noise(x, y, 1) * 8;
        const win = t >= 4 && s % 3 >= 0.9 && s % 3 < 2.1 && t % 4 >= 0.8 && t % 4 < 2.8;
        const shop = t < 4;
        const lightPane = win && s >= 6 && s < 9 && t >= 16 && t < 20 && s % 3 >= 1.05 && s % 3 < 1.95 && t % 4 >= 0.95 && t % 4 < 2.65;
        const v = (lightPane ? 165 : win ? 45 + (Math.floor(s / 3) % 3) * 12 : shop ? 60 : 196) * lit + n;
        return [v, v * 0.97, win ? v * 1.15 : v * 0.9];
    },
    uncovered: (x, y) => (x > 250 && y < 40) || (x >= 126 && x < 145 && y >= 88 && y < 116)
};
/** Glass strips 2 m wide every 3.5 m along a 42 x 36 m wall: dark blue glass rows over lighter brown spandrels every 3.6 m, mullions every 1 m. */
const strips: Synthetic = {
    id: 2, width: 420, height: 360, pixel: 0.1,
    colour: (s, t, x, y) => {
        const n = noise(x, y, 2) * 6, inBay = s % 3.5 >= 0.75 && s % 3.5 < 2.75, glass = t % 3.6 < 2.3;
        const mullion = inBay && Math.abs(((s % 3.5) - 0.75) % 1 - 0.5) < 0.06;
        if (!inBay) return [205 + n, 200 + n, 188 + n];
        if (mullion) return [150 + n, 150 + n, 150 + n];
        return glass ? [40 + n, 58 + n, 95 + n] : [105 + n, 92 + n, 80 + n];
    }
};
/** A 6 m wide, 40 m tall tower face: one window column 2.2 m wide, a window every 3.5 m storey. */
const tower: Synthetic = {
    id: 3, width: 60, height: 400, pixel: 0.1,
    colour: (s, t, x, y) => {
        const n = noise(x, y, 3) * 6, win = s >= 1.9 && s < 4.1 && t % 3.5 >= 0.9 && t % 3.5 < 2.9;
        const v = (win ? 48 : 190) + n;
        return [v, v, v * (win ? 1.2 : 0.95)];
    }
};
/** Two wings: on the left 1.4 m windows every 2.5 m, on the right 2 m windows every 4.5 m, storeys 3.2 m and 3.8 m. */
const wings: Synthetic = {
    id: 4, width: 560, height: 300, pixel: 0.1,
    colour: (s, t, x, y) => {
        const n = noise(x, y, 4) * 7;
        const win = s < 28 ? s % 2.5 >= 0.55 && s % 2.5 < 1.95 && t % 3.2 >= 0.7 && t % 3.2 < 2.5 : s % 4.5 >= 1.25 && s % 4.5 < 3.25 && t % 3.8 >= 0.9 && t % 3.8 < 2.9;
        const wall = s < 28 ? 182 : 214;
        const v = (win ? 52 : wall) + n;
        return [v * (s < 28 ? 1.05 : 0.95), v, v * 0.92];
    }
};

/** An orthos folder of these facades (facades.json, their photos and uncovered masks), as tile_refine writes it. */
function orthosOf(dir: string, facades: Synthetic[], scale = 1): void {
    const frames = facades.map(f => {
        const W = f.width * scale, H = f.height * scale, px = f.pixel / scale, rgba = Buffer.alloc(W * H * 4), unc = Buffer.alloc(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = (x + 0.5) * px, t = H * px - (y + 0.5) * px, k = y * W + x;
            const c = f.colour(s, t, x / scale, y / scale);
            const off = !c || (f.uncovered && f.uncovered(x / scale, y / scale));
            rgba.set(off ? [128, 128, 128, 255] : [...c!.map(v => Math.max(0, Math.min(255, Math.round(v)))), 255], k * 4);
            unc[k] = off ? 255 : 0;
        }
        fs.writeFileSync(path.join(dir, `facade_${f.id}.png`), encodePng(W, H, rgba, 4));
        fs.writeFileSync(path.join(dir, `facade_${f.id}_uncovered.png`), encodePng(W, H, unc, 1));
        return { facadeId: f.id, image: `facade_${f.id}.png`, uncoveredMask: `facade_${f.id}_uncovered.png`, width: W, height: H, pixel: px, orthoSMin: 0, orthoTMax: H * px, texel: px / 2, coverage: 1 };
    });
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: frames }));
}

type Fitted = Exclude<WindowFitEntry, { error: string }>;
const byId = (es: WindowFitEntry[]) => new Map(es.map(e => [e.facadeId, e]));

/** Two rect lists equal in count, each pair (both sorted) within `tol` texels on every side. */
function rectsWithin(a: WindowRect[], b: WindowRect[], tol: number): { same: boolean; worst: number } {
    if (a.length !== b.length) return { same: false, worst: Infinity };
    const sa = [...a].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]), sb = [...b].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
    let worst = 0;
    sa.forEach((r, i) => r.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - sb[i][k])); }));
    return { same: worst <= tol, worst };
}

// ------------------------------------------------------------------------------------------------ synthetic shells

type V = [number, number, number];

/** A face as a grid of cells: origin, the two in-plane steps, the cell count each way, cells skipped by `hole`; wound by `flip`; jittered by position. */
function face(o: V, a: V, b: V, n: number, m: number, flip: boolean, hole: (i: number, j: number) => boolean = () => false, jitter = 0): V[] {
    const at = (i: number, j: number): V => {
        const p: V = [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
        return jitter ? [p[0] + jitter * noise(p[1], p[2], 5), p[1] + jitter * noise(p[0], p[2], 6), p[2] + jitter * noise(p[0], p[1], 7)] : p;
    };
    const out: V[] = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
        if (hole(i, j)) continue;
        const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        out.push(...(flip ? [q[0], q[2], q[1], q[0], q[3], q[2]] : [q[0], q[1], q[2], q[0], q[2], q[3]]));
    }
    return out;
}

/** One GLB of named triangle-soup nodes; a rebuilt wall carries sbFacadeLattice and a photo material with its UVs. */
function glb(parts: Array<{ name: string; tris: V[]; facadeId?: number; uv?: (p: V) => [number, number] }>): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{}], materials: [], textures: [], images: [], samplers: [{}] };
    const chunks: Uint8Array[] = [];
    let len = 0;
    const view = (a: Float32Array | Uint32Array, target: number) => { json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: a.byteLength, target }); chunks.push(new Uint8Array(a.buffer)); len += a.byteLength; return json.bufferViews.length - 1; };
    for (const p of parts) {
        const P = Float32Array.from(p.tris.flat()), I = Uint32Array.from(p.tris.map((_, i) => i));
        const min = [0, 1, 2].map(k => p.tris.reduce((m, v) => Math.min(m, v[k]), Infinity)), max = [0, 1, 2].map(k => p.tris.reduce((m, v) => Math.max(m, v[k]), -Infinity));
        json.accessors.push({ bufferView: view(P, 34962), componentType: 5126, count: p.tris.length, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
        let material: number | undefined;
        if (p.uv) {
            json.accessors.push({ bufferView: view(Float32Array.from(p.tris.flatMap(v => p.uv!(v))), 34962), componentType: 5126, count: p.tris.length, type: 'VEC2' });
            attributes.TEXCOORD_0 = json.accessors.length - 1;
            json.images.push({ uri: `${p.name}.png` }); json.textures.push({ source: json.images.length - 1, sampler: 0 });
            json.materials.push({ name: p.name, pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 } } });
            material = json.materials.length - 1;
        }
        json.accessors.push({ bufferView: view(I, 34963), componentType: 5125, count: I.length, type: 'SCALAR' });
        json.meshes.push({ name: p.name, primitives: [{ attributes, indices: json.accessors.length - 1, mode: 4, ...(material !== undefined ? { material } : {}) }] });
        json.nodes.push({ name: p.name, mesh: json.meshes.length - 1, ...(p.facadeId !== undefined ? { extras: { sbFacadeLattice: { facadeId: p.facadeId, windows: { uv: [] } } } } : {}) });
        json.scenes[0].nodes.push(json.nodes.length - 1);
    }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers[0].byteLength = len;
    return assembleGlb(json, bin);
}

/**
 * A shell L metres a side on cells of `c` metres: open at the bottom (the base the fill caps), its front split into a
 * rebuilt wall (left, textured) and scan (right), holes in the scan faces (flat ones, and one wrapping the corner of the
 * back and the right side), one in the rebuilt wall, and a doubled patch of skin over the roof. Jittered off its planes.
 */
function shell(L: number, c: number, holes: number): { clay: Buffer; tex: Buffer; footprint: Array<Array<[number, number]>> } {
    const n = Math.round(L / c), h = (i: number, j: number, k: number) => (noise(i * 3.1, j * 7.7, k) + 1) / 2 < holes / (n * n) && i > 0 && j > 0 && i < n - 1 && j < n - 1;
    const v = (x: number): V => [x, 0, 0];
    const wallHole = (i: number, j: number) => i >= Math.floor(n * 0.2) && i < Math.floor(n * 0.2) + 2 && j >= Math.floor(n / 2) && j < Math.floor(n / 2) + 2;
    const half = Math.floor(n / 2);
    const corner = (i: number, j: number) => i >= n - 2 && j >= Math.floor(n * 0.6) && j < Math.floor(n * 0.6) + 3;
    const scan = [
        ...face([0, 0, 0], v(c), [0, c, 0], n, n, true, (i, j) => i < half || h(i, j, 1)),
        ...face([0, 0, L], v(c), [0, c, 0], n, n, false, (i, j) => h(i, j, 2) || corner(i, j)),
        ...face([0, 0, 0], [0, 0, c], [0, c, 0], n, n, false, (i, j) => h(i, j, 3)),
        ...face([L, 0, 0], [0, 0, c], [0, c, 0], n, n, true, (i, j) => h(i, j, 4) || corner(i, j)),
        ...face([0, L, 0], v(c), [0, 0, c], n, n, true, (i, j) => h(i, j, 5))
    ];
    const jittered = (tris: V[]) => tris.map(p => [p[0] + 0.004 * noise(p[1], p[2], 8), p[1] + 0.004 * noise(p[0], p[2], 9), p[2] + 0.004 * noise(p[0], p[1], 10)] as V);
    const wall = face([0, 0, 0], v(c), [0, c, 0], half, n, true, wallHole);
    const skin = face([L * 0.3, L, L * 0.3], v(c), [0, 0, c], 3, 3, true);
    const parts = (textured: boolean) => [
        { name: 'scan', tris: jittered(scan) },
        { name: 'skin', tris: skin },
        { name: 'wall', tris: wall, facadeId: 7, ...(textured ? { uv: (p: V) => [p[0] / L, 1 - p[1] / L] as [number, number] } : {}) }
    ];
    return { clay: glb(parts(false)), tex: glb(parts(true)), footprint: [[[0, 0], [L, 0], [L, L], [0, L]]] };
}

function trianglesOf(bytes: Buffer, node: string): number {
    const g = parseGlbBytes(bytes), nd = g.json.nodes.find((x: any) => x.name === node);
    if (!nd) return 0;
    return (g.json.meshes[nd.mesh].primitives as any[]).reduce((s, p) => s + readAccessor(g, p.indices ?? p.attributes.POSITION).count / 3, 0);
}

/** fillOpenLoops with SCRATCHBOX_K_NATIVE_POLISH set to `on`, and how long it took. */
function fillWith(on: boolean, s: ReturnType<typeof shell>, threads?: number) {
    const prior = process.env.SCRATCHBOX_K_NATIVE_POLISH;
    process.env.SCRATCHBOX_K_NATIVE_POLISH = on ? '1' : '0';
    try {
        const t = performance.now();
        const r = fillOpenLoops(s.clay, [s.tex], { footprint: s.footprint, ...(threads ? { threads } : {}) });
        return { ...r, ms: performance.now() - t };
    } finally {
        if (prior === undefined) delete process.env.SCRATCHBOX_K_NATIVE_POLISH; else process.env.SCRATCHBOX_K_NATIVE_POLISH = prior;
    }
}

// ------------------------------------------------------------------------------------------------ the tests

describe('pipeline K remesh polish: native C++ against the TypeScript', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remesh-polish-native-'));
    const timings: string[] = [];
    beforeAll(async () => { await Promise.all([ensureRemeshPolishBinary(), ensureReliefBandBinary()]); }, 900_000);
    afterAll(() => {
        fs.rmSync(scratch, { recursive: true, force: true });
        // the timing line, TypeScript against native
        if (timings.length) console.log(`remesh polish timing (TypeScript vs native): ${timings.join('; ')}`);
    });

    it('fits the same windows, lattice sites, panes and band reports on facades whose readings differ', async () => {
        const dir = path.join(scratch, 'orthos');
        fs.mkdirSync(dir);
        orthosOf(dir, [punched, strips, tower, wings]);
        const facades = orthoFacades(dir);
        const ts = byId(await fitOrthoFacades(dir, facades, WINDOW_FIT_PARAMS, { concurrency: 4 }));
        const nat = byId(await fitOrthoFacadesNative(dir, facades, WINDOW_FIT_PARAMS, { threads: 4 }));
        let readings = 0, windows = 0, panes = 0, completed = 0;
        for (const f of facades) {
            const a = ts.get(f.facadeId) as Fitted, b = nat.get(f.facadeId) as Fitted;
            expect('error' in a ? a.error : '', `TypeScript, facade ${f.facadeId}`).toBe('');
            expect('error' in b ? b.error : '', `native, facade ${f.facadeId}`).toBe('');
            // the accepted bands, their readings and gates: the same report, key for key
            expect(JSON.stringify(b.bands), `bands of facade ${f.facadeId}`).toBe(JSON.stringify(a.bands));
            for (const [name, x, y] of [['rects', a.rects, b.rects], ['panes', a.panes ?? [], b.panes ?? []], ['generated', a.generated ?? [], b.generated ?? []]] as const) {
                const d = rectsWithin(x, y, 1);
                expect(d.same, `${name} of facade ${f.facadeId}: ${x.length} vs ${y.length}, worst ${d.worst} texels`).toBe(true);
            }
            readings += a.bands.filter(bd => bd.accepted).length;
            windows += a.rects.length; panes += a.panes?.length ?? 0;
            completed += a.bands.reduce((s, bd) => s + (bd.completed ?? 0), 0);
        }
        // the cases read something: every facade some windows, punched windows and strips, a narrow column, completed sites
        const kinds = new Set([...ts.values()].flatMap(e => ('bands' in e ? e.bands.filter(bd => bd.accepted).map(bd => `${bd.grid}:${bd.kind}`) : [])));
        expect(readings).toBeGreaterThanOrEqual(5);
        expect(windows).toBeGreaterThan(100);
        expect(panes).toBeGreaterThan(50);
        expect([...kinds].some(k => k.endsWith('strips')), [...kinds].join(', ')).toBe(true);
        expect(kinds.has('column:cells'), [...kinds].join(', ')).toBe(true);
        expect(completed).toBeGreaterThan(0);
        // what the facades exercised, per facade: each band's grid:kind, accepted or why not, completions and panes
        console.log(facades.map(f => { const e = ts.get(f.facadeId) as Fitted; return `facade ${f.facadeId}: ${e.rects.length} windows, ${e.panes?.length ?? 0} panes; ${e.bands.map(bd => `${bd.grid ?? '-'}:${bd.kind ?? '-'} ${bd.accepted ? 'accepted' : bd.why}${bd.completed ? ` +${bd.completed}` : ''}${bd.panes ? ` [${bd.panes}]` : ''}${bd.subPitch ? ` sub ${bd.subPitch}` : ''}`).join(', ')}`; }).join('\n'));
    }, 900_000);

    it('closes the same loops with the same triangles, report and GLBs', () => {
        for (const [L, c, holes] of [[10, 1, 3], [16, 0.5, 12]] as const) {
            const s = shell(L, c, holes);
            const a = fillWith(false, s), b = fillWith(true, s);
            expect(b.report, `report of the ${L} m shell`).toEqual(a.report);
            expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report));
            expect(trianglesOf(b.clay, 'Seal')).toBe(trianglesOf(a.clay, 'Seal'));
            expect(Buffer.compare(b.clay, a.clay), `clay GLB of the ${L} m shell`).toBe(0);
            expect(Buffer.compare(b.others[0], a.others[0]), `textured GLB of the ${L} m shell`).toBe(0);
            // the shells exercise the fill: loops closed flat and in 3D, the base capped, fill dropped, caps turned
            expect(a.report.loops).toBeGreaterThan(3);
            expect(a.report.filled + a.report.clipped3d).toBeGreaterThan(3);
            expect(trianglesOf(a.clay, 'Seal')).toBeGreaterThan(10);
        }
    }, 900_000);

    it('times the largest case of each, TypeScript against native', async () => {
        const dir = path.join(scratch, 'orthos-large');
        fs.mkdirSync(dir);
        orthosOf(dir, [punched, strips, tower, wings], 2);
        const facades = orthoFacades(dir);
        // as the orchestrator runs each: the TypeScript a facade a worker thread (remesh-worker-pool.ts), largest first;
        // the native fit one process on every core
        const workers = remeshWorkerThreads(), threads = nativePolishThreads();
        let t = performance.now();
        const ts = await runRemeshJobs<WindowFitEntry>(facades.map(facade => ({ kind: 'windowFacade' as const, orthosDir: dir, facade, params: WINDOW_FIT_PARAMS })), { threads: workers, order: facades.map((_, i) => i).sort((a, b) => facades[b].width * facades[b].height - facades[a].width * facades[a].height || a - b) });
        const tsMs = performance.now() - t;
        t = performance.now();
        const nat = await fitOrthoFacadesNative(dir, facades, WINDOW_FIT_PARAMS, { threads });
        const natMs = performance.now() - t;
        const tsById = byId(ts);
        for (const e of nat) {
            const a = tsById.get(e.facadeId) as Fitted, b = e as Fitted;
            expect(JSON.stringify(b.bands), `bands of facade ${e.facadeId}`).toBe(JSON.stringify(a.bands));
            expect(rectsWithin(a.rects, b.rects, 1).same, `windows of facade ${e.facadeId}`).toBe(true);
        }
        timings.push(`window fit, 4 facades at 0.05 m (${facades.map(f => `${f.width}x${f.height}`).join(', ')}): ${Math.round(tsMs)} ms on ${workers} worker threads vs ${Math.round(natMs)} ms on ${threads} native threads`);
        const s = shell(40, 0.25, 60);
        const a = fillWith(false, s), b = fillWith(true, s, threads);
        expect(JSON.stringify(b.report)).toBe(JSON.stringify(a.report));
        expect(Buffer.compare(b.clay, a.clay)).toBe(0);
        expect(Buffer.compare(b.others[0], a.others[0])).toBe(0);
        timings.push(`infill, ${trianglesOf(s.clay, 'scan') + trianglesOf(s.clay, 'wall')} triangles, ${a.report.loops} loops: ${Math.round(a.ms)} ms vs ${Math.round(b.ms)} ms on ${threads} native threads`);
    }, 900_000);
});
