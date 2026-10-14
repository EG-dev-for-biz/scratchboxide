/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Native scan rectifier (scratchbox_scan_rectifier.hpp via scripts/run_scan_rectifier.cpp).
 *
 * The CLI is compiled with clang++ and run as a real subprocess. Every check below is measured
 * here, from the input GLB and the SBRX sidecar, by code that shares nothing with the kernel:
 * a minimal GLB reader, displacement statistics, flip and area tests, plane residuals and a
 * software rasteriser for the verification screenshots (test-results/screenshots/, gitignored).
 *
 *  1. A synthetic scan: a crinkled box building with a shallow frontispiece and a fully enclosed
 *     interior shell, split across primitives like tile chunks.
 *  2. The real Google 3D tile of the ESB district (skipped when the local tile is absent). The
 *     ESB frame and lot rectangle used for the facade check are TEST ORACLES only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const CLI_SRC = path.join(REPO, 'scripts/run_scan_rectifier.cpp');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const SHOTS = path.join(REPO, 'test-results/screenshots');

// ---------------------------------------------------------------------------------------------
// Independent GLB I/O (scene-order walk identical to the glTF spec traversal the reader uses)
// ---------------------------------------------------------------------------------------------
interface Scan {
    positions: Float32Array; // 3V
    triangles: Uint32Array;  // 3T
    primitiveOfTriangle: Uint32Array;
}

function readGlbScan(file: string): Scan {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    const binStart = 20 + jsonLen + 8;
    const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
    const order: number[] = [];
    const walk = (n: number) => {
        const node = json.nodes[n];
        for (const k of ['matrix', 'translation', 'rotation', 'scale']) {
            if (node[k] !== undefined) throw new Error('test reader expects untransformed tile nodes');
        }
        if (node.mesh !== undefined) order.push(node.mesh);
        for (const c of node.children ?? []) walk(c);
    };
    roots.forEach(walk);
    const pos: number[] = [];
    const tris: number[] = [];
    const prim: number[] = [];
    let base = 0;
    let primIndex = 0;
    for (const m of order) {
        for (const p of json.meshes[m].primitives) {
            if ((p.mode ?? 4) !== 4) continue;
            const acc = json.accessors[p.attributes.POSITION];
            if (acc.componentType !== 5126 || acc.type !== 'VEC3') throw new Error('POSITION must be float32 VEC3');
            const bv = json.bufferViews[acc.bufferView];
            const stride = bv.byteStride ?? 12;
            const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
            for (let i = 0; i < acc.count; i++) {
                for (let c = 0; c < 3; c++) pos.push(bin.readFloatLE(off + i * stride + c * 4));
            }
            const idx: number[] = [];
            if (p.indices !== undefined) {
                const ia = json.accessors[p.indices];
                const iv = json.bufferViews[ia.bufferView];
                const io = (iv.byteOffset ?? 0) + (ia.byteOffset ?? 0);
                const size = ia.componentType === 5125 ? 4 : ia.componentType === 5123 ? 2 : 1;
                for (let i = 0; i < ia.count; i++) {
                    idx.push(size === 4 ? bin.readUInt32LE(io + i * 4) : size === 2 ? bin.readUInt16LE(io + i * 2) : bin.readUInt8(io + i));
                }
            } else {
                for (let i = 0; i < acc.count; i++) idx.push(i);
            }
            for (let i = 0; i + 2 < idx.length; i += 3) {
                if (idx[i] >= acc.count || idx[i + 1] >= acc.count || idx[i + 2] >= acc.count) continue;
                tris.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
                prim.push(primIndex);
            }
            base += acc.count;
            primIndex++;
        }
    }
    return { positions: new Float32Array(pos), triangles: new Uint32Array(tris), primitiveOfTriangle: new Uint32Array(prim) };
}

/** Writes a minimal GLB with one mesh whose primitives are the given chunks (no materials). */
function writeGlb(file: string, chunks: Array<{ positions: number[]; indices: number[] }>): void {
    const parts: Buffer[] = [];
    let offset = 0;
    const bufferViews: object[] = [];
    const accessors: object[] = [];
    const primitives: object[] = [];
    const push = (b: Buffer, target: number) => {
        const pad = (4 - (b.length % 4)) % 4;
        parts.push(b, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
        offset += b.length + pad;
        return bufferViews.length - 1;
    };
    for (const ch of chunks) {
        const p = Buffer.from(new Float32Array(ch.positions).buffer);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < ch.positions.length; i++) {
            const c = i % 3;
            const v = Math.fround(ch.positions[i]);
            min[c] = Math.min(min[c], v);
            max[c] = Math.max(max[c], v);
        }
        const pv = push(p, 34962);
        accessors.push({ bufferView: pv, componentType: 5126, count: ch.positions.length / 3, type: 'VEC3', min, max });
        const iv = push(Buffer.from(new Uint32Array(ch.indices).buffer), 34963);
        accessors.push({ bufferView: iv, componentType: 5125, count: ch.indices.length, type: 'SCALAR' });
        primitives.push({ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, mode: 4 });
    }
    const binBuf = Buffer.concat(parts);
    const doc = {
        asset: { version: '2.0', generator: 'scan-rectifier.test' },
        buffers: [{ byteLength: binBuf.length }],
        bufferViews,
        accessors,
        meshes: [{ primitives }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0
    };
    let jsonBuf = Buffer.from(JSON.stringify(doc), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(jsonBuf.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binBuf.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([header, jh, jsonBuf, bh, binBuf]));
}

interface Sidecar { version: number; positions: Float32Array; flags: Uint8Array; }

function readSidecar(file: string): Sidecar {
    const b = fs.readFileSync(file);
    expect(b.toString('latin1', 0, 4)).toBe('SBRX');
    const version = b.readUInt32LE(4), v = b.readUInt32LE(8), t = b.readUInt32LE(12);
    expect(b.length).toBe(16 + 12 * v + t);
    const positions = new Float32Array(v * 3);
    for (let i = 0; i < v * 3; i++) positions[i] = b.readFloatLE(16 + 4 * i);
    return { version, positions, flags: new Uint8Array(b.subarray(16 + 12 * v, 16 + 12 * v + t)) };
}

// ---------------------------------------------------------------------------------------------
// Independent measurements
// ---------------------------------------------------------------------------------------------
type V = [number, number, number];
const at = (p: Float32Array, i: number): V => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.sqrt(dot(a, a));

function triNormalArea(p: Float32Array, t: Uint32Array, i: number): { n: V; area: number } {
    const a = at(p, t[3 * i]), b = at(p, t[3 * i + 1]), c = at(p, t[3 * i + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    return { n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0], area: 0.5 * l };
}

function displacement(p0: Float32Array, p1: Float32Array) {
    const n = p0.length / 3;
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = len(sub(at(p1, i), at(p0, i)));
    const sorted = Array.from(d).sort((a, b) => a - b);
    let sum = 0, untouched = 0;
    for (const x of d) { sum += x; if (x <= 0.01) untouched++; }
    return { d, max: sorted[n - 1], p95: sorted[Math.floor(0.95 * (n - 1))], mean: sum / n, untouchedFraction: untouched / n };
}

function flipsAndCollapses(p0: Float32Array, p1: Float32Array, t: Uint32Array, flags: Uint8Array) {
    let flips = 0, collapsedKept = 0;
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] !== 1) continue;
        const a = triNormalArea(p0, t, i), b = triNormalArea(p1, t, i);
        if (a.area > 1e-6 && dot(a.n, b.n) < 0) flips++;
        if (a.area > 1e-4 && b.area < 1e-4) collapsedKept++;
    }
    return { flips, collapsedKept };
}

// ---------------------------------------------------------------------------------------------
// Verification screenshot: orthographic z-buffered render centred on view.origin,
// input (clay) | output (kept triangles, displacement heat: blue 0 m -> red >= 0.5 m)
// ---------------------------------------------------------------------------------------------
function renderComparison(file: string, scan: Scan, out: Sidecar, view: { origin: V; right: V; up: V; width: number; height: number; pxPerM: number }): void {
    const W = view.width, H = view.height;
    const rgba = Buffer.alloc(2 * W * H * 4, 255);
    const fwd = cross(view.up, view.right); // toward the viewer
    const disp = displacement(scan.positions, out.positions).d;
    const panels: Array<{ pos: Float32Array; heat: boolean; x0: number }> = [
        { pos: scan.positions, heat: false, x0: 0 },
        { pos: out.positions, heat: true, x0: W }
    ];
    for (const panel of panels) {
        const zbuf = new Float32Array(W * H).fill(-Infinity);
        for (let t = 0; t < scan.triangles.length / 3; t++) {
            if (panel.heat && out.flags[t] !== 1) continue;
            const ids = [scan.triangles[3 * t], scan.triangles[3 * t + 1], scan.triangles[3 * t + 2]];
            const scr = ids.map((v) => {
                const q = sub(at(panel.pos, v), view.origin);
                return [W / 2 + dot(q, view.right) * view.pxPerM, H / 2 - dot(q, view.up) * view.pxPerM, dot(q, fwd)];
            });
            const { n } = triNormalArea(panel.pos, scan.triangles, t);
            const shade = 0.35 + 0.65 * Math.abs(dot(n, [0.45, 0.75, 0.48]) / len([0.45, 0.75, 0.48]));
            const dm = (disp[ids[0]] + disp[ids[1]] + disp[ids[2]]) / 3;
            const h = Math.min(1, dm / 0.5);
            const base: V = panel.heat ? [0.25 + 0.75 * h, 0.55 * (1 - h) + 0.25, 0.85 * (1 - h) + 0.15] : [0.62, 0.63, 0.66];
            const minX = Math.max(0, Math.floor(Math.min(scr[0][0], scr[1][0], scr[2][0])));
            const maxX = Math.min(W - 1, Math.ceil(Math.max(scr[0][0], scr[1][0], scr[2][0])));
            const minY = Math.max(0, Math.floor(Math.min(scr[0][1], scr[1][1], scr[2][1])));
            const maxY = Math.min(H - 1, Math.ceil(Math.max(scr[0][1], scr[1][1], scr[2][1])));
            const det = (scr[1][0] - scr[0][0]) * (scr[2][1] - scr[0][1]) - (scr[2][0] - scr[0][0]) * (scr[1][1] - scr[0][1]);
            if (Math.abs(det) < 1e-9) continue;
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    const w1 = ((scr[1][0] - px) * (scr[2][1] - py) - (scr[2][0] - px) * (scr[1][1] - py)) / det;
                    const w2 = ((scr[2][0] - px) * (scr[0][1] - py) - (scr[0][0] - px) * (scr[2][1] - py)) / det;
                    const w3 = 1 - w1 - w2;
                    if (w1 < 0 || w2 < 0 || w3 < 0) continue;
                    const z = w1 * scr[0][2] + w2 * scr[1][2] + w3 * scr[2][2];
                    if (z <= zbuf[y * W + x]) continue;
                    zbuf[y * W + x] = z;
                    const o = (y * 2 * W + panel.x0 + x) * 4;
                    rgba[o] = Math.round(255 * base[0] * shade);
                    rgba[o + 1] = Math.round(255 * base[1] * shade);
                    rgba[o + 2] = Math.round(255 * base[2] * shade);
                    rgba[o + 3] = 255;
                }
            }
        }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(2 * W, H, rgba));
}

// ---------------------------------------------------------------------------------------------
// Build + run helpers (real subprocesses)
// ---------------------------------------------------------------------------------------------
let tmp = '';
let cli = '';

function runCli(args: string[], timeout = 170_000): string {
    return execFileSync(cli, args, { encoding: 'utf8', timeout });
}

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-rectifier-'));
    cli = path.join(tmp, 'run_scan_rectifier');
    execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O3', '-pthread', '-I', INCLUDE, CLI_SRC, '-o', cli, '-lz'], { stdio: 'pipe', timeout: 170_000 });
}, 180_000);

afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 1. Synthetic scan
// ---------------------------------------------------------------------------------------------
describe('scan rectifier: synthetic crinkled building with an enclosed shell', () => {
    // deterministic pseudo-random jitter
    let seed = 12345;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const chunks: Array<{ positions: number[]; indices: number[]; label: string }> = [];
    /** Grid face from origin O spanning U x V (outward normal U x V); interior vertices jittered along it. */
    const face = (label: string, O: V, U: V, Vv: V, nu: number, nv: number, jitter: number) => {
        const nrm = cross(U, Vv);
        const nl = len(nrm);
        const N: V = [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl];
        const positions: number[] = [];
        const indices: number[] = [];
        for (let j = 0; j <= nv; j++) {
            for (let i = 0; i <= nu; i++) {
                const interior = i > 0 && i < nu && j > 0 && j < nv;
                const e = interior ? (rand() * 2 - 1) * jitter : 0;
                for (let c = 0; c < 3; c++) positions.push(O[c] + (U[c] * i) / nu + (Vv[c] * j) / nv + N[c] * e);
            }
        }
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
                indices.push(a, b, c, a, c, d);
            }
        }
        chunks.push({ positions, indices, label });
    };
    // ground (outward +y) under and around the building
    face('ground', [-60, 0, -60], [0, 0, 120], [120, 0, 0], 12, 12, 0);
    // building 20 x 30 x 40 m, crinkled walls (+-0.12 m) and roof (+-0.08 m)
    face('wall+x', [10, 0, -15], [0, 40, 0], [0, 0, 30], 10, 6, 0.12);
    face('wall-x', [-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 10, 0.12);
    face('wall+z', [-10, 0, 15], [20, 0, 0], [0, 40, 0], 4, 10, 0.12);
    face('wall-z', [-10, 0, -15], [0, 40, 0], [20, 0, 0], 10, 4, 0.12);
    face('roof', [-10, 40, -15], [0, 0, 30], [20, 0, 0], 6, 4, 0.08);
    // shallow frontispiece on +x: 0.45 m proud (inside the 0.5 m wall snap tolerance), flat front
    face('front', [10.45, 0, -3], [0, 20, 0], [0, 0, 6], 4, 2, 0);
    face('front+z', [10, 0, 3], [0.45, 0, 0], [0, 20, 0], 1, 4, 0);
    face('front-z', [10, 0, -3], [0, 20, 0], [0.45, 0, 0], 4, 1, 0);
    face('front-top', [10, 20, -3], [0, 0, 6], [0.45, 0, 0], 2, 1, 0);
    // fully enclosed interior shell (a nested inner box, outward normals)
    for (const [label, O, U, Vv] of [
        ['shell+x', [4, 5, -4], [0, 8, 0], [0, 0, 8]],
        ['shell-x', [-4, 5, -4], [0, 0, 8], [0, 8, 0]],
        ['shell+z', [-4, 5, 4], [8, 0, 0], [0, 8, 0]],
        ['shell-z', [-4, 5, -4], [0, 8, 0], [8, 0, 0]],
        ['shell+y', [-4, 13, -4], [0, 0, 8], [8, 0, 0]],
        ['shell-y', [-4, 5, -4], [8, 0, 0], [0, 0, 8]]
    ] as Array<[string, V, V, V]>) face(label, O, U, Vv, 2, 2, 0);

    const glb = () => path.join(tmp, 'synthetic.glb');
    const side = () => path.join(tmp, 'synthetic.rectify.bin');
    let scan: Scan;
    let out: Sidecar;
    const triLabel: string[] = [];
    const vertLabel: string[] = [];

    beforeAll(() => {
        writeGlb(glb(), chunks);
        for (const ch of chunks) {
            for (let i = 0; i < ch.indices.length / 3; i++) triLabel.push(ch.label);
            for (let i = 0; i < ch.positions.length / 3; i++) vertLabel.push(ch.label);
        }
        const log = runCli(['--input', glb(), '--out', side(), '--rays', '64', '--rig-cams', '12', '--rig-aerial-res', '160', '--rig-street-width', '256', '--threads', '4']);
        expect(log).toContain('run_scan_rectifier');
        scan = readGlbScan(glb());
        out = readSidecar(side());
    }, 180_000);

    it('writes a well-formed SBRX v1 sidecar matching the scan, plus JSON stats', () => {
        expect(out.version).toBe(1);
        expect(out.positions.length).toBe(scan.positions.length);
        expect(out.flags.length).toBe(scan.triangles.length / 3);
        expect(Array.from(out.flags).every((f) => f === 0 || f === 1 || f === 2)).toBe(true);
        const stats = JSON.parse(fs.readFileSync(side().replace(/\.bin$/, '.json'), 'utf8'));
        expect(stats.format).toBe('SBRX');
        expect(stats.input_counts.triangles).toBe(scan.triangles.length / 3);
        expect(stats.regions.wallRegions).toBeGreaterThanOrEqual(5);
        // the grid of this scene is the x/z axes: a family at 0 (= 90) degrees, derived from the scan
        const fam = stats.families.map((f: { azimuthDeg_atan2_nz_nx_mod90: number }) => f.azimuthDeg_atan2_nz_nx_mod90);
        expect(fam.some((a: number) => Math.min(a, 90 - a) < 0.5)).toBe(true);
    });

    it('flags the enclosed interior shell hidden and keeps every exterior face', () => {
        for (let t = 0; t < triLabel.length; t++) {
            if (triLabel[t].startsWith('shell')) expect(out.flags[t]).toBe(0);
            if (['wall+z', 'wall-z', 'wall-x', 'roof', 'front'].includes(triLabel[t])) expect(out.flags[t]).toBe(1);
        }
    });

    it('snaps crinkled walls onto their fitted plane within the displacement budget', () => {
        const disp = displacement(scan.positions, out.positions);
        expect(disp.max).toBeLessThanOrEqual(0.75);
        let rmsIn = 0, rmsOut = 0, maxOut = 0, n = 0;
        for (let v = 0; v < vertLabel.length; v++) {
            if (vertLabel[v] !== 'wall+z') continue;
            rmsIn += (scan.positions[3 * v + 2] - 15) ** 2;
            const r = Math.abs(out.positions[3 * v + 2] - 15);
            rmsOut += r * r;
            maxOut = Math.max(maxOut, r);
            n++;
        }
        rmsIn = Math.sqrt(rmsIn / n);
        rmsOut = Math.sqrt(rmsOut / n);
        expect(rmsIn).toBeGreaterThan(0.04);
        expect(rmsOut).toBeLessThan(0.5 * rmsIn);
        expect(maxOut).toBeLessThan(0.07); // only sub-dead-band residuals remain
    });

    it('keeps shallow relief proud, leaves flat ground and hidden-only vertices untouched, flips nothing', () => {
        for (let v = 0; v < vertLabel.length; v++) {
            if (vertLabel[v] === 'front') expect(Math.abs(out.positions[3 * v] - 10.45)).toBeLessThan(0.02);
            if (vertLabel[v] === 'ground' || vertLabel[v].startsWith('shell')) {
                expect(len(sub(at(out.positions, v), at(scan.positions, v)))).toBeLessThan(1e-6);
            }
        }
        const fc = flipsAndCollapses(scan.positions, out.positions, scan.triangles, out.flags);
        expect(fc.flips).toBe(0);
        expect(fc.collapsedKept).toBe(0);
        renderComparison(path.join(SHOTS, 'scan_rectifier_synthetic_displacement.png'), scan, out, {
            // oblique from +x/+z and above, so the frontispiece reads against the wall behind it
            origin: [0, 16, 0], right: [-Math.SQRT1_2, 0, Math.SQRT1_2], up: [-0.2556, 0.9324, -0.2556], width: 520, height: 520, pxPerM: 8
        });
    });

    it('is deterministic across thread counts', () => {
        const a = path.join(tmp, 'det1.bin'), b = path.join(tmp, 'det7.bin');
        runCli(['--input', glb(), '--out', a, '--rays', '64', '--rig-cams', '12', '--rig-aerial-res', '160', '--rig-street-width', '256', '--threads', '1']);
        runCli(['--input', glb(), '--out', b, '--rays', '64', '--rig-cams', '12', '--rig-aerial-res', '160', '--rig-street-width', '256', '--threads', '7']);
        expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
        expect(fs.readFileSync(a).equals(fs.readFileSync(side()))).toBe(true);
    }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// 1b. Visibility guards without the camera rig: a face that pokes through a wall and a canopy
//     soffit only a pedestrian can see (both are culling false positives found on the real tile)
// ---------------------------------------------------------------------------------------------
describe('scan rectifier: partially exposed faces and street-only soffits stay visible (no rig)', () => {
    const chunks: Array<{ positions: number[]; indices: number[]; label: string }> = [];
    /** Planar grid face from O spanning U x V (outward normal U x V). */
    const quad = (label: string, O: V, U: V, Vv: V, nu = 2, nv = 2) => {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let j = 0; j <= nv; j++) {
            for (let i = 0; i <= nu; i++) for (let c = 0; c < 3; c++) positions.push(O[c] + (U[c] * i) / nu + (Vv[c] * j) / nv);
        }
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
                indices.push(a, b, c, a, c, d);
            }
        }
        chunks.push({ positions, indices, label });
    };
    /** Closed axis-aligned box [lo, hi] with outward faces, optionally without its -x face. */
    const box = (prefix: string, lo: V, hi: V, skipMinusX = false) => {
        const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        quad(`${prefix}+x`, [x1, y0, z0], [0, dy, 0], [0, 0, dz]);
        if (!skipMinusX) quad(`${prefix}-x`, [x0, y0, z0], [0, 0, dz], [0, dy, 0]);
        quad(`${prefix}+z`, [x0, y0, z1], [dx, 0, 0], [0, dy, 0]);
        quad(`${prefix}-z`, [x0, y0, z0], [0, dy, 0], [dx, 0, 0]);
        quad(`${prefix}+y`, [x0, y1, z0], [0, 0, dz], [dx, 0, 0]);
        quad(`${prefix}-y`, [x0, y0, z0], [dx, 0, 0], [0, 0, dz]);
    };
    quad('ground', [-60, 0, -60], [0, 0, 120], [120, 0, 0], 12, 12);
    // closed building (the ground is its floor) with an enclosed interior shell
    quad('bldg+x', [10, 0, -15], [0, 30, 0], [0, 0, 30]);
    quad('bldg-x', [-10, 0, -15], [0, 0, 30], [0, 30, 0]);
    quad('bldg+z', [-10, 0, 15], [20, 0, 0], [0, 30, 0]);
    quad('bldg-z', [-10, 0, -15], [0, 30, 0], [20, 0, 0]);
    quad('bldg+y', [-10, 30, -15], [0, 0, 30], [20, 0, 0]);
    box('shell', [-3, 5, -3], [3, 11, 3]);
    // one triangle through the -z wall: 4 m of it outside, 10 m inside; its three classic interior
    // ray origins (barycentric 4/6, 1/6, 1/6) all lie inside the building
    chunks.push({ positions: [0, 6, -19, 0, 6, -5, 0, 10, -5], indices: [0, 1, 2], label: 'pierce' });
    // closed 20 x 20 m courtyard (30 m walls) with a canopy slab along its west wall: the slab's
    // underside sees only the courtyard floor, never the sky
    quad('court-x', [25, 0, -10], [0, 30, 0], [0, 0, 20]);
    quad('court+x', [45, 0, -10], [0, 0, 20], [0, 30, 0]);
    quad('court-z', [25, 0, -10], [20, 0, 0], [0, 30, 0]);
    quad('court+z', [25, 0, 10], [0, 30, 0], [20, 0, 0]);
    box('slab', [25, 4, -8], [31, 4.5, 8], true);

    const glb = () => path.join(tmp, 'guards.glb');
    const triLabel: string[] = [];
    /** Runs the CLI with the camera rig disabled, so only the per-face visibility tests decide. */
    const flagsFor = (name: string, extra: string[]): Uint8Array => {
        const side = path.join(tmp, `${name}.bin`);
        runCli(['--input', glb(), '--out', side, '--rays', '64', '--rig-cams', '0', '--threads', '4', ...extra]);
        return readSidecar(side).flags;
    };
    const labelled = (flags: Uint8Array, prefix: string) => triLabel.flatMap((l, t) => (l.startsWith(prefix) ? [flags[t]] : []));

    beforeAll(() => {
        writeGlb(glb(), chunks);
        for (const ch of chunks) for (let i = 0; i < ch.indices.length / 3; i++) triLabel.push(ch.label);
    });

    it('culls the enclosed shell and keeps the piercing face and the soffit with the default guards', () => {
        const flags = flagsFor('guards_default', []);
        expect(labelled(flags, 'shell').every((f) => f === 0)).toBe(true);
        expect(labelled(flags, 'pierce')).toEqual([1]);
        expect(labelled(flags, 'slab-y').every((f) => f === 1)).toBe(true);
        for (const p of ['bldg', 'court', 'slab+y', 'slab+x']) expect(labelled(flags, p).every((f) => f === 1)).toBe(true);
    }, 120_000);

    it('loses the piercing face with the three fixed ray origins (and no nadir view)', () => {
        // the part outside the wall is also the top-most surface where it stands, so the nadir guard alone keeps it
        expect(labelled(flagsFor('guards_fixed_nadir', ['--fixed-origins']), 'pierce')).toEqual([1]);
        expect(labelled(flagsFor('guards_fixed', ['--fixed-origins', '--no-nadir']), 'pierce')).toEqual([0]);
    }, 120_000);

    it('loses the street-only soffit without the street-reach guard', () => {
        expect(labelled(flagsFor('guards_nostreet', ['--no-street-reach']), 'slab-y').every((f) => f === 0)).toBe(true);
    }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// 1c. Chunk seams: a crinkled facade chunk meets a ledge chunk along a T-junction seam (the ledge is
//     subdivided twice as finely, so half of its seam vertices sit on the facade chunk's top edges).
//     Snapping moves the facade; the ledge, on no plane, must follow it so the seam does not open.
// ---------------------------------------------------------------------------------------------
describe('scan rectifier: T-junction chunk seams stay closed while snapping', () => {
    let seed = 777;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const chunks: Array<{ positions: number[]; indices: number[]; label: string }> = [];
    const grid = (label: string, nu: number, nv: number, pos: (i: number, j: number) => V) => {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.push(...pos(i, j));
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
                indices.push(a, b, c, a, c, d);
            }
        }
        chunks.push({ positions, indices, label });
    };
    // ground and a 20 x 20 x 40 m building; the +z facade (z = 10) is crinkled (+-0.15 m, seam included)
    grid('ground', 12, 12, (i, j) => [-60 + 10 * j, 0, -60 + 10 * i]);
    grid('wall+x', 4, 8, (i, j) => [10, 5 * j, 10 - 5 * i]);
    grid('wall-x', 4, 8, (i, j) => [-10, 5 * j, -10 + 5 * i]);
    grid('wall-z', 4, 8, (i, j) => [10 - 5 * i, 5 * j, -10]);
    grid('roof', 4, 4, (i, j) => [-10 + 5 * i, 40, 10 - 5 * j]);
    // lower chunk: 4 x 4 cells (5 m), y 0..20, crinkled; its top row (the seam) has a fixed crinkle
    const top = [0, 0.14, -0.12, 0.13, 0];
    grid('seam-low', 4, 4, (i, j) => [-10 + 5 * i, 5 * j, 10 + (j === 4 ? top[i] : i === 0 || i === 4 ? 0 : (rand() * 2 - 1) * 0.15)]);
    // a 45 degree ledge chunk (1 m up, 1 m out; not a wall or roof, so on no plane region), 8 cells of 2.5 m: its
    // odd bottom vertices sit exactly on the lower chunk's top edges (T-junctions), the even ones on its vertices
    grid('seam-ledge', 8, 1, (i, j) => [-10 + 2.5 * i, 20 + j,
        10 + (j === 1 ? 1 : i % 2 === 0 ? top[i / 2] : 0.5 * (top[(i - 1) / 2] + top[(i + 1) / 2]))]);
    // upper chunk: the facade steps out to z = 11 above the ledge; 8 x 4 cells, y 21..40, crinkled interior
    grid('seam-high', 8, 4, (i, j) => [-10 + 2.5 * i, 21 + 4.75 * j, 11 + (j === 0 || i === 0 || i === 8 ? 0 : (rand() * 2 - 1) * 0.15)]);

    const glb = () => path.join(tmp, 'seams.glb');
    let scan: Scan;
    let tVerts: number[] = [];       // odd upper-chunk seam vertices (the T-junctions)
    let lowTop: number[] = [];       // lower chunk's top-row vertices, in order along x
    const gapsFor = (name: string, extra: string[]): number[] => {
        const side = path.join(tmp, `${name}.bin`);
        runCli(['--input', glb(), '--out', side, '--rays', '64', '--rig-cams', '0', '--threads', '4', ...extra]);
        const out = readSidecar(side);
        return tVerts.map((v) => {
            let best = Infinity;
            for (let k = 0; k + 1 < lowTop.length; k++) {
                const a = at(out.positions, lowTop[k]), b = at(out.positions, lowTop[k + 1]), p = at(out.positions, v);
                const d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), d) / dot(d, d)));
                best = Math.min(best, len(sub(p, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t])));
            }
            return best;
        });
    };

    beforeAll(() => {
        writeGlb(glb(), chunks);
        scan = readGlbScan(glb());
        let base = 0;
        for (const ch of chunks) {
            if (ch.label === 'seam-low') lowTop = Array.from({ length: 5 }, (_, i) => base + 4 * 5 + i);
            if (ch.label === 'seam-ledge') tVerts = [1, 3, 5, 7].map((i) => base + i);
            base += ch.positions.length / 3;
        }
        expect(scan.positions.length / 3).toBe(base);
    });

    it('keeps every T-junction on its partner edge (gap below 1 cm) while the facade is snapped', () => {
        const gaps = gapsFor('seams_default', []);
        expect(gaps.length).toBe(4);
        for (const g of gaps) expect(g).toBeLessThan(0.01);
    }, 120_000);

    it('opens the seam when the two chunks move independently (--no-seam-coherence)', () => {
        const gaps = gapsFor('seams_independent', ['--no-seam-coherence', '--no-tjunction']);
        expect(Math.max(...gaps)).toBeGreaterThan(0.03);
    }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// 1d. Single-sided visibility: the tile's materials are single-sided. A facade wrapped in an
//     inside-out skin (normals facing the building) is hidden from a two-sided ray test, yet a
//     back-face-culling viewer sees straight through the skin to it. It must stay.
// ---------------------------------------------------------------------------------------------
describe('scan rectifier: faces seen through back faces stay visible', () => {
    const chunks: Array<{ positions: number[]; indices: number[]; label: string }> = [];
    const quad = (label: string, O: V, U: V, Vv: V) => {
        const positions: number[] = [];
        for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 1]]) for (let c = 0; c < 3; c++) positions.push(O[c] + U[c] * i + Vv[c] * j);
        chunks.push({ positions, indices: [0, 1, 2, 0, 2, 3], label });
    };
    /** Box faces with outward (inward = false) or inward-facing normals. */
    const box = (prefix: string, lo: V, hi: V, inward: boolean) => {
        const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const faces: Array<[string, V, V, V]> = [
            ['+x', [x1, y0, z0], [0, dy, 0], [0, 0, dz]], ['-x', [x0, y0, z0], [0, 0, dz], [0, dy, 0]],
            ['+z', [x0, y0, z1], [dx, 0, 0], [0, dy, 0]], ['-z', [x0, y0, z0], [0, dy, 0], [dx, 0, 0]],
            ['+y', [x0, y1, z0], [0, 0, dz], [dx, 0, 0]]
        ];
        // outward normal = U x V; swapping U and V reverses the winding (normal into the box)
        for (const [n, O, U, Vv] of faces) quad(`${prefix}${n}`, O, inward ? Vv : U, inward ? U : Vv);
    };
    quad('ground', [-60, 0, -60], [0, 0, 120], [120, 0, 0]);
    box('bldg', [-10, 0, -15], [10, 30, 15], false);
    box('skin', [-10.5, 0, -15.5], [10.5, 30.5, 15.5], true);
    const glb = () => path.join(tmp, 'skin.glb');
    const triLabel: string[] = [];
    const flagsFor = (name: string, extra: string[]): Uint8Array => {
        const side = path.join(tmp, `${name}.bin`);
        runCli(['--input', glb(), '--out', side, '--rays', '128', '--rig-cams', '0', '--threads', '4', ...extra]);
        return readSidecar(side).flags;
    };
    const labelled = (flags: Uint8Array, prefix: string) => triLabel.flatMap((l, t) => (l.startsWith(prefix) ? [flags[t]] : []));

    beforeAll(() => {
        writeGlb(glb(), chunks);
        for (const ch of chunks) for (let i = 0; i < ch.indices.length / 3; i++) triLabel.push(ch.label);
        // the skin really faces inward: its +x face normal points to -x
        const scan = readGlbScan(glb());
        const t = triLabel.indexOf('skin+x');
        expect(triNormalArea(scan.positions, scan.triangles, t).n[0]).toBeLessThan(-0.99);
    });

    it('keeps the wrapped facade (and the skin) with the default visibility', () => {
        const flags = flagsFor('skin_default', []);
        for (const p of ['bldg+x', 'bldg-x', 'bldg+z', 'bldg-z', 'bldg+y']) expect(labelled(flags, p).every((f) => f === 1)).toBe(true);
        expect(labelled(flags, 'skin').every((f) => f === 1)).toBe(true);
    }, 120_000);

    it('culls the wrapped facade when back faces occlude (--two-sided-only)', () => {
        const flags = flagsFor('skin_two_sided', ['--two-sided-only']);
        expect(labelled(flags, 'bldg+x').every((f) => f === 0)).toBe(true);
    }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// 1e. Relief and thin walls: a parapet standing 0.2 m proud of a crinkled facade (outer face in the facade's
//     plane region, inner face 0.15 m behind it) and a pier strip 0.18 m proud of another crinkled facade.
//     Snapping the parapet's outer face onto the facade plane would push it through its own inner face, and
//     the pier strip would be pressed into the wall. Both must keep their geometry.
// ---------------------------------------------------------------------------------------------
describe('scan rectifier: thin walls keep their order and piers stay proud', () => {
    let seed = 4242;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const chunks: Array<{ positions: number[]; indices: number[]; label: string }> = [];
    const grid = (label: string, nu: number, nv: number, pos: (i: number, j: number) => V) => {
        const positions: number[] = [];
        const indices: number[] = [];
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.push(...pos(i, j));
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
                indices.push(a, b, c, a, c, d);
            }
        }
        chunks.push({ positions, indices, label });
    };
    const crinkle = (i: number, j: number, nu: number, nv: number) => (i === 0 || i === nu || j === 0 || j === nv ? 0 : (rand() * 2 - 1) * 0.12);
    // ground and a 30 x 20 x 30 m building (x -15..15, z -10..10); +z and +x facades crinkled (+-0.12 m)
    grid('ground', 12, 12, (i, j) => [-60 + 10 * j, 0, -60 + 10 * i]);
    grid('facade+z', 6, 6, (i, j) => [-15 + 5 * i, 5 * j, 10 + crinkle(i, j, 6, 6)]);
    grid('facade+x', 4, 6, (i, j) => [15 + crinkle(i, j, 4, 6), 5 * j, 10 - 5 * i]);
    grid('wall-x', 4, 6, (i, j) => [-15, 5 * j, -10 + 5 * i]);
    grid('wall-z', 6, 6, (i, j) => [15 - 5 * i, 5 * j, -10]);
    grid('roof', 6, 4, (i, j) => [-15 + 5 * i, 30, 10 - 5 * j]);
    // parapet along the +z roof edge: outer face 0.2 m proud of the facade, inner face 0.15 m behind it, cap on top
    grid('parapet-out', 6, 1, (i, j) => [-15 + 5 * i, 30 + 1.6 * j, 10.2]);
    grid('parapet-in', 6, 1, (i, j) => [15 - 5 * i, 30 + 1.6 * j, 10.05]);
    grid('parapet-cap', 6, 1, (i, j) => [-15 + 5 * i, 31.6, 10.2 - 0.15 * j]);
    // pier strip on the +x facade: 1.2 m wide, 26 m tall, flat, 0.18 m proud (its own chunk, like a tile strip)
    grid('pier', 1, 1, (i, j) => [15.18, 2 + 26 * j, 0.6 - 1.2 * i]);
    grid('pier-side+z', 1, 1, (i, j) => [15 + 0.18 * i, 2 + 26 * j, 0.6]);
    grid('pier-side-z', 1, 1, (i, j) => [15 + 0.18 * j, 2 + 26 * i, -0.6]);

    const glb = () => path.join(tmp, 'relief.glb');
    let scan: Scan;
    const verts = new Map<string, number[]>();
    const triLabel: string[] = [];
    const run = (name: string, extra: string[]): Sidecar => {
        const side = path.join(tmp, `${name}.bin`);
        runCli(['--input', glb(), '--out', side, '--rays', '64', '--rig-cams', '0', '--threads', '4', ...extra]);
        return readSidecar(side);
    };
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    /** Parapet outer face minus inner face along +z (min over the outer face's vertices vs max of the inner face). */
    const parapetGap = (p: Float32Array) => Math.min(...verts.get('parapet-out')!.map((v) => p[3 * v + 2])) - Math.max(...verts.get('parapet-in')!.map((v) => p[3 * v + 2]));
    /** Pier strip minus the facade's main plane along +x (median of the facade's interior vertices). */
    const pierProud = (p: Float32Array) => {
        const facade = median(verts.get('facade+x')!.map((v) => p[3 * v]));
        return Math.min(...verts.get('pier')!.map((v) => p[3 * v])) - facade;
    };

    beforeAll(() => {
        writeGlb(glb(), chunks);
        scan = readGlbScan(glb());
        let base = 0;
        for (const ch of chunks) {
            verts.set(ch.label, Array.from({ length: ch.positions.length / 3 }, (_, i) => base + i));
            base += ch.positions.length / 3;
            for (let i = 0; i < ch.indices.length / 3; i++) triLabel.push(ch.label);
        }
        expect(parapetGap(scan.positions)).toBeCloseTo(0.15, 5);
        expect(pierProud(scan.positions)).toBeGreaterThan(0.15);
    });

    it('keeps the parapet faces in order and the pier proud, with the default guards', () => {
        const out = run('relief_default', []);
        // every face of the parapet and the pier is kept
        for (let t = 0; t < triLabel.length; t++) if (triLabel[t].startsWith('parapet') || triLabel[t] === 'pier') expect(out.flags[t]).toBe(1);
        // the facade itself is snapped (its crinkle is removed) ...
        const fz = verts.get('facade+z')!.filter((v) => scan.positions[3 * v + 1] > 0 && scan.positions[3 * v + 1] < 30);
        const rmsIn = Math.sqrt(fz.reduce((s, v) => s + (scan.positions[3 * v + 2] - 10) ** 2, 0) / fz.length);
        const rmsOut = Math.sqrt(fz.reduce((s, v) => s + (out.positions[3 * v + 2] - 10) ** 2, 0) / fz.length);
        expect(rmsOut).toBeLessThan(0.6 * rmsIn);
        // ... the parapet's outer face stays in front of its inner face by at least min(0.5 x 0.15, 0.05) - a margin
        expect(parapetGap(out.positions)).toBeGreaterThan(0.04);
        // ... and the pier still stands at least 0.1 m proud of the facade
        expect(pierProud(out.positions)).toBeGreaterThan(0.1);
        const fc = flipsAndCollapses(scan.positions, out.positions, scan.triangles, out.flags);
        expect(fc.flips).toBe(0);
        renderComparison(path.join(SHOTS, 'scan_rectifier_thin_wall_and_pier.png'), scan, out, {
            origin: [12, 16, 10], right: [-Math.SQRT1_2, 0, Math.SQRT1_2], up: [-0.2556, 0.9324, -0.2556], width: 520, height: 520, pxPerM: 10
        });
    }, 120_000);

    it('turns the parapet inside out without the opposed-sheet guard', () => {
        const out = run('relief_noopposed', ['--no-opposed']);
        expect(parapetGap(out.positions)).toBeLessThan(0);
    }, 120_000);

    it('presses the pier into the facade without relief sheets', () => {
        const out = run('relief_nosheets', ['--no-sheets']);
        expect(pierProud(out.positions)).toBeLessThan(0.1);
    }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// 2. Real Google 3D tile (ESB district)
// ---------------------------------------------------------------------------------------------
describe.skipIf(!fs.existsSync(TILE))('scan rectifier: real ESB district tile', () => {
    let scan: Scan;
    let out: Sidecar;
    let stats: any;

    beforeAll(() => {
        const side = path.join(tmp, 'esb.rectify.bin');
        runCli([
            '--input', TILE, '--out', side, '--rays', '192', '--rig-cams', '48', '--tau-wall', '0.5', '--tau-roof', '0.4',
            '--tau-corner', '0.7', '--offset-tol', '0.3', '--family-snap-deg', '1.5', '--min-wall-area', '15', '--denoise', '--threads', '8'
        ], 1_500_000);
        scan = readGlbScan(TILE);
        out = readSidecar(side);
        stats = JSON.parse(fs.readFileSync(side.replace(/\.bin$/, '.json'), 'utf8'));
    }, 1_600_000);

    it('covers every vertex and triangle of the tile in GlbSceneReader order', () => {
        expect(scan.triangles.length / 3).toBe(169588);
        expect(out.positions.length).toBe(scan.positions.length);
        expect(out.flags.length).toBe(169588);
        expect(stats.input_counts.vertices).toBe(scan.positions.length / 3);
    });

    it('culls enclosed shells per triangle (not per chunk) without emptying any chunk', () => {
        const T = out.flags.length;
        const hidden = out.flags.filter((f) => f === 0).length;
        expect(hidden / T).toBeGreaterThan(0.2);
        expect(hidden / T).toBeLessThan(0.35);
        const keptPerPrim = new Map<number, number>();
        const totalPerPrim = new Map<number, number>();
        for (let t = 0; t < T; t++) {
            const p = scan.primitiveOfTriangle[t];
            totalPerPrim.set(p, (totalPerPrim.get(p) ?? 0) + 1);
            if (out.flags[t] === 1) keptPerPrim.set(p, (keptPerPrim.get(p) ?? 0) + 1);
        }
        for (const [p, n] of totalPerPrim) if (n >= 50) expect(keptPerPrim.get(p) ?? 0).toBeGreaterThan(0);
    });

    it('stays within the displacement budget with zero flips and no collapsed kept triangles', () => {
        const disp = displacement(scan.positions, out.positions);
        expect(disp.max).toBeLessThanOrEqual(0.75);
        expect(disp.p95).toBeLessThanOrEqual(0.45);
        expect(disp.mean).toBeLessThanOrEqual(0.12);
        expect(disp.untouchedFraction).toBeGreaterThanOrEqual(0.5);
        const fc = flipsAndCollapses(scan.positions, out.positions, scan.triangles, out.flags);
        expect(fc.flips).toBe(0);
        expect(fc.collapsedKept).toBe(0);
    });

    it('keeps unwelded chunk seams closed: at most 0.1% of T-junctions open by more than 5 cm', () => {
        // independent T-junction measurement: boundary vertices of the kept surface (1 mm weld) that lie within
        // 5 mm of a boundary edge of another connected piece at the input positions; gap re-measured at output
        const kept: number[] = [];
        for (let t = 0; t < out.flags.length; t++) if (out.flags[t] === 1) kept.push(t);
        const P0 = scan.positions, P1 = out.positions, T = scan.triangles;
        const weld = new Map<string, number>();
        const wid = new Int32Array(P0.length / 3);
        for (let v = 0; v < wid.length; v++) {
            const k = `${Math.round(P0[3 * v] * 1000)},${Math.round(P0[3 * v + 1] * 1000)},${Math.round(P0[3 * v + 2] * 1000)}`;
            if (!weld.has(k)) weld.set(k, weld.size);
            wid[v] = weld.get(k)!;
        }
        const parent = Int32Array.from({ length: wid.length }, (_, i) => i);
        const root = (a: number): number => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
        for (const t of kept) { parent[root(T[3 * t + 1])] = root(T[3 * t]); parent[root(T[3 * t + 2])] = root(T[3 * t]); }
        const uses = new Map<number, number>(), raw = new Map<number, [number, number]>();
        for (const t of kept) {
            for (let k = 0; k < 3; k++) {
                const va = T[3 * t + k], vb = T[3 * t + ((k + 1) % 3)];
                const a = Math.min(wid[va], wid[vb]), b = Math.max(wid[va], wid[vb]);
                if (a === b) continue;
                const key = a * weld.size + b;
                uses.set(key, (uses.get(key) ?? 0) + 1);
                if (!raw.has(key)) raw.set(key, [va, vb]);
            }
        }
        const edges: Array<[number, number]> = [];
        for (const [key, n] of uses) if (n === 1) edges.push(raw.get(key)!);
        const cellOf = (x: number, y: number, z: number) => `${Math.floor(x / 2)},${Math.floor(y / 2)},${Math.floor(z / 2)}`;
        const grid = new Map<string, number[]>();
        edges.forEach(([a, b], e) => {
            const lo = [0, 1, 2].map((c) => Math.floor((Math.min(P0[3 * a + c], P0[3 * b + c]) - 0.01) / 2));
            const hi = [0, 1, 2].map((c) => Math.floor((Math.max(P0[3 * a + c], P0[3 * b + c]) + 0.01) / 2));
            for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
                const key = `${i},${j},${k}`;
                if (!grid.has(key)) grid.set(key, []);
                grid.get(key)!.push(e);
            }
        });
        const segment = (P: Float32Array, v: number, a: number, b: number, tFixed?: number) => {
            const p = at(P, v), A = at(P, a), d = sub(at(P, b), A);
            const t = tFixed ?? Math.max(0, Math.min(1, dot(sub(p, A), d) / Math.max(dot(d, d), 1e-18)));
            return { gap: len(sub(p, [A[0] + d[0] * t, A[1] + d[1] * t, A[2] + d[2] * t])), t };
        };
        const bverts = new Set<number>();
        for (const [a, b] of edges) { bverts.add(a); bverts.add(b); }
        let contacts = 0, opened = 0;
        for (const v of bverts) {
            let best = { gap: Infinity, t: 0 }, be = -1;
            for (const e of grid.get(cellOf(P0[3 * v], P0[3 * v + 1], P0[3 * v + 2])) ?? []) {
                const [a, b] = edges[e];
                if (wid[a] === wid[v] || wid[b] === wid[v] || root(a) === root(v)) continue;
                const r = segment(P0, v, a, b);
                if (r.gap < best.gap) { best = r; be = e; }
            }
            if (be < 0 || best.gap >= 0.005) continue;
            contacts++;
            if (segment(P1, v, edges[be][0], edges[be][1], best.t).gap > 0.05) opened++;
        }
        expect(contacts).toBeGreaterThan(1000);
        expect(opened).toBeLessThanOrEqual(0.001 * contacts);
    });

    it('raises the plumb-and-grid facade area of the ESB lot to at least 0.70 (oracle frame)', () => {
        // TEST ORACLE ONLY (scratchpad survey): grid azimuth 61.07 deg, lot rectangle in (u, w)
        const th = (61.07 * Math.PI) / 180, C = Math.cos(th), S = Math.sin(th);
        const frac = (p: Float32Array) => {
            let good = 0, total = 0;
            for (let t = 0; t < out.flags.length; t++) {
                if (out.flags[t] !== 1) continue;
                const { n, area } = triNormalArea(p, scan.triangles, t);
                if (area < 1e-6 || Math.abs(n[1]) >= 0.3) continue;
                const c = [0, 1, 2].map((k) => at(p, scan.triangles[3 * t + k]));
                const cx = (c[0][0] + c[1][0] + c[2][0]) / 3, cz = (c[0][2] + c[1][2] + c[2][2]) / 3;
                const u = cx * C - cz * S, w = cx * S + cz * C;
                if (u < -30 || u > 32.4 || w < -64.9 || w > 65.4) continue;
                const tilt = (Math.asin(Math.min(1, Math.abs(n[1]))) * 180) / Math.PI;
                const phi = (Math.atan2(n[0] * S + n[2] * C, n[0] * C - n[2] * S) * 180) / Math.PI;
                const dev = ((((phi + 45) % 90) + 90) % 90) - 45;
                total += area;
                if (tilt < 1 && Math.abs(dev) < 1) good += area;
            }
            return good / total;
        };
        const before = frac(scan.positions), after = frac(out.positions);
        expect(after).toBeGreaterThanOrEqual(0.7);
        expect(after).toBeGreaterThan(before + 0.1);
        renderComparison(path.join(SHOTS, 'scan_rectifier_esb_displacement.png'), scan, out, {
            // looking at the 5th Ave (+w) side of the tower, right = -u, up = +y (oracle frame)
            origin: [0, 214, 0], right: [-C, 0, S], up: [0, 1, 0], width: 520, height: 900, pxPerM: 2.1
        });
    });
});
