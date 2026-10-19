/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E relief on a synthetic scan (no network, no model): a 24 x 10 x 15 m block whose south facade carries a known
 * cornice profile, a string course, two pilasters, an 18-opening lattice with known reveals and sills, under heavy noise
 * (white 0.10 m, correlated 0.08 m, 3 % outliers up to 0.7 m). The native massing tool renders the relief map through its
 * slab; the native averaging must recover the profiles within tolerance, keep nothing the facade does not have, and the
 * solid built with them must carry the measured geometry. Screenshots under test-results/screenshots/version_e_relief/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing, type MassingNode, type MassingRun } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { writeMassingTexturedGlb } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import { plainTextures, MASSING_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';
import { reliefMap, runReliefAverage, runReliefStage, K_SIGMA, MIN_BLOCKS, MIN_OPENINGS, MEASURED_AVERAGED_LABEL, type ReliefOutcome } from '../src/node/3d-engine/staged-location/pipeline-e/relief';
import type { FacadeGrammar } from '../src/node/3d-engine/staged-location/facade-grammar';
import { renderFrameDepth, type FrameCamera } from '../src/node/spatial/StreetViewPoseRegistrar';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_e_relief');
const shot = (name: string, w: number, h: number, rgb: Uint8Array, ch: 3 | 4 = 3) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), encodePng(w, h, Buffer.from(rgb), ch)); };

// ------------------------------------------------------------------ the facade's truth (s = x, t = y on the south wall)
const W_M = 24, D_M = 10, H_M = 15;
const CORNICE = { t0: 13.4, t1: 14.4, depth: 0.6 };
const CORNICE_AT = (t: number) => (t < CORNICE.t0 || t >= CORNICE.t1 ? 0 : Math.min(CORNICE.depth, CORNICE.depth * (t - CORNICE.t0) / 0.6));
const STRING = { t0: 4.8, t1: 5.1, depth: 0.15 };
const PILASTERS = [{ s0: 0.3, s1: 0.8 }, { s0: 23.2, s1: 23.7 }];
const PILASTER_DEPTH = 0.12, PILASTER_TOP = CORNICE.t0;
const REVEAL = 0.25, SILL = { depth: 0.08, height: 0.2, overhang: 0.1 };
const WINDOWS = [1.4, 6.0, 9.6].flatMap(t0 => [0, 1, 2, 3, 4, 5].map(c => ({ s0: 2 + 3.6 * c, s1: 3.4 + 3.6 * c, t0, t1: t0 + 2.2 })));

function truth(s: number, t: number): number {
    let h = 0;
    h = Math.max(h, CORNICE_AT(t));
    if (t >= STRING.t0 && t < STRING.t1) h = Math.max(h, STRING.depth);
    if (t < PILASTER_TOP && PILASTERS.some(p => s >= p.s0 && s < p.s1)) h = Math.max(h, PILASTER_DEPTH);
    for (const w of WINDOWS) {
        if (s >= w.s0 && s < w.s1 && t >= w.t0 && t < w.t1) return -REVEAL;
        if (s >= w.s0 - SILL.overhang && s < w.s1 + SILL.overhang && t >= w.t0 - SILL.height && t < w.t0) h = Math.max(h, SILL.depth);
    }
    return h;
}

/** The synthetic scan: the detailed south facade as a noisy grid, the other faces flat; a photo texture so the bake runs. */
function syntheticTile(dir: string, seed = 11): string {
    let st = seed;
    const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
    const gauss = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    // correlated noise: a few random sinusoids over the facade (0.08 m rms)
    const waves = Array.from({ length: 6 }, () => ({ ks: (0.5 + 2 * rnd()) / 3, kt: (0.5 + 2 * rnd()) / 3, ph: 2 * Math.PI * rnd() }));
    const corr = (s: number, t: number) => 0.08 * Math.SQRT2 / Math.sqrt(waves.length) * waves.reduce((a, w) => a + Math.sin(w.ks * s + w.kt * t + w.ph), 0);
    const g = 0.08, ns = Math.round(W_M / g), nt = Math.round(H_M / g);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [], ref: number[] = [], nrm: number[] = [];
    for (let j = 0; j <= nt; j++) for (let i = 0; i <= ns; i++) {
        const s = i * g, t = j * g;
        const edge = i === 0 || i === ns || j === 0 || j === nt;
        let h = truth(s, t) + (edge ? 0 : 0.10 * gauss() + corr(s, t));
        if (!edge && rnd() < 0.03) h += (rnd() * 2 - 1) * 0.7;
        pos.push(s, t, h); uv.push(s / W_M, 1 - t / H_M); ref.push(-2); nrm.push(0, 0, 1);
    }
    for (let j = 0; j < nt; j++) for (let i = 0; i < ns; i++) {
        const a = j * (ns + 1) + i, b = a + 1, c = a + ns + 1, d = c + 1;
        idx.push(a, b, d, a, d, c);
    }
    const quad = (p: number[][]) => { const b = pos.length / 3; p.forEach(q => { pos.push(...q); uv.push(0.5, 0.5); ref.push(-2); nrm.push(0, 1, 0); }); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); };
    quad([[W_M, 0, 0], [W_M, 0, -D_M], [W_M, H_M, -D_M], [W_M, H_M, 0]]);
    quad([[W_M, 0, -D_M], [0, 0, -D_M], [0, H_M, -D_M], [W_M, H_M, -D_M]]);
    quad([[0, 0, -D_M], [0, 0, 0], [0, H_M, 0], [0, H_M, -D_M]]);
    quad([[0, H_M, 0], [W_M, H_M, 0], [W_M, H_M, -D_M], [0, H_M, -D_M]]);
    const node: MassingNode = { name: 'scan', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array(pos), normals: new Float32Array(nrm), ref: new Int32Array(ref), st: new Float32Array(uv), indices: new Uint32Array(idx) };
    const T = 64, img = new Uint8Array(T * T * 4);
    for (let i = 0; i < T * T; i++) img.set([176, 160, 140, 255], i * 4);
    const glb = writeMassingTexturedGlb({
        nodes: [node], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }),
        textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(T, T, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0
    }).glb;
    const file = path.join(dir, 'tile.glb');
    fs.writeFileSync(file, glb);
    return file;
}

const MASSING: Pick<Massing, 'parts' | 'meshes' | 'check'> = {
    parts: [{ id: 'p', baseY: 0, topY: H_M, loops: [[[0, 0], [W_M, 0], [W_M, -D_M], [0, -D_M]]], planes: [], heightSource: 'vector', heights: {} }],
    meshes: [],
    check: { ok: true, iou: 1, heightErrMedianM: 0, heightErrP90M: 0 } as Massing['check']
};

function grammarFor(faceIndex: number): FacadeGrammar {
    const tiers = [1.4, 6.0, 9.6].map(t0 => ({ t0, t1: t0 + 2.2, cols: WINDOWS.filter(w => w.t0 === t0).map(w => [w.s0, w.s1] as [number, number]) }));
    return { schema: 'scratchbox.facade-grammar/1', facadeId: faceIndex, normal: [0, 0, 1], centroid: [12, 7.5, 0], tiers, storeyHeightsM: [4.6, 3.6], openings: tiers.map(t => ({ widthM: 1.4, heightM: 2.2, sillM: t.t0, bayPitchM: 3.6, count: 6 })), confidence: 0.8, source: 'tiles' };
}

// ------------------------------------------------------------------ clay renders of the solid (depth-shaded, studio grey)
function clayRender(nodes: MassingNode[], eye: [number, number, number], target: [number, number, number], W = 720, H = 480, fovDeg = 50): Uint8Array {
    const V: number[] = [], I: number[] = [];
    for (const n of nodes) { const b = V.length / 3; V.push(...n.positions); for (const k of n.indices) I.push(b + k); }
    const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const nrm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const fwd = nrm(sub(target, eye)), right = nrm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
    const f = (W / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
    const cam = { eye, right, up, fwd, fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H } as unknown as FrameCamera;
    const z = renderFrameDepth({ vertices: new Float32Array(V), indices: new Uint32Array(I) }, cam);
    const rgb = new Uint8Array(W * H * 3);
    const P = (x: number, y: number) => { const d = z[y * W + x]; if (!(d > 0 && d < 1e7)) return undefined; const u = (x + 0.5 - W / 2) / f, v = (y + 0.5 - H / 2) / f; return [eye[0] + d * (fwd[0] + u * right[0] - v * up[0]), eye[1] + d * (fwd[1] + u * right[1] - v * up[1]), eye[2] + d * (fwd[2] + u * right[2] - v * up[2])]; };
    const light = nrm([0.45, 0.8, 0.55]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = P(x, y), px = P(Math.min(W - 1, x + 1), y), py = P(x, Math.min(H - 1, y + 1));
        if (!p) { rgb.set([206, 208, 212], (y * W + x) * 3); continue; }
        let n = px && py ? nrm(cross(sub(px, p), sub(py, p))) : [0, 0, 1];
        if (n[0] * fwd[0] + n[1] * fwd[1] + n[2] * fwd[2] > 0) n = [-n[0], -n[1], -n[2]];
        const l = 0.35 + 0.65 * Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
        const c = Math.round(Math.min(255, 150 * l + 20));
        rgb.set([c, c, Math.min(255, c + 4)], (y * W + x) * 3);
    }
    return rgb;
}

/** A plot of the recovered row profile (mean +- k SE, blue) over the truth (black) against height. */
function profilePlot(rows: Float32Array, face: { orthoTMax: number; pixel: number; height: number }, base: number, tMin: number, tMax: number): { w: number; h: number; rgb: Uint8Array } {
    const w = 480, h = 600, rgb = new Uint8Array(w * h * 3).fill(255);
    const X = (d: number) => Math.round(60 + (d + 0.3) / 1.0 * (w - 80)), Y = (t: number) => Math.round(h - 20 - (t - tMin) / (tMax - tMin) * (h - 40));
    const put = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < w && y < h) rgb.set(c, (y * w + x) * 3); };
    for (let y = 0; y < h; y++) put(X(0), y, [200, 200, 200]);
    for (let r = 0; r < face.height; r++) {
        const t = face.orthoTMax - (r + 0.5) * face.pixel;
        if (t < tMin || t > tMax) continue;
        const m = rows[r * 3] , se = rows[r * 3 + 1];
        if (Number.isFinite(m)) { for (let x = X(m - K_SIGMA * se); x <= X(m + K_SIGMA * se); x++) put(x, Y(t), [170, 200, 240]); put(X(m), Y(t), [20, 70, 200]); put(X(m) + 1, Y(t), [20, 70, 200]); }
        put(X(Math.max(...[2.5, 6.5, 10.5, 12.0].map(s => truth(s, t)))), Y(t), [0, 0, 0]);
    }
    void base;
    return { w, h, rgb };
}

async function cleanRun(dir: string, tile: string): Promise<MassingRun> {
    const out = path.join(dir, 'native');
    return runMassing(massingSpecText(MASSING, { outDir: out, tile, isolate: tile, params: { ...MASSING_PARAMS, sections: 0, topdown: 0 } }), out);
}

describe('pipeline E relief: averaging the scan along repeats (synthetic facade, heavy noise)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-e-relief-'));
    const tile = syntheticTile(dir, Number(process.env.RELIEF_SEED ?? 11));
    let run: MassingRun;
    let outcome: ReliefOutcome;

    it('renders a relief map of the facade through the slab, the wall on the scanned facade', async () => {
        run = await cleanRun(dir, tile);
        const south = run.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        expect(south).toBeTruthy();
        const m = reliefMap(run, south)!;
        expect(m.valid / (south.width * south.height)).toBeGreaterThan(0.8);
        // inside a window the map reads the recess, on the cornice the projection (one noisy texel each; the averages are tested below)
        const at = (s: number, t: number) => m.relief[Math.floor((south.orthoTMax - t) / south.pixel) * south.width + Math.floor((s - south.orthoSMin) / south.pixel)];
        expect(at(2.7, 7.1)).toBeLessThan(0);
        expect(at(12, 14.2)).toBeGreaterThan(0.2);
        const rgb = new Uint8Array(south.width * south.height * 3);
        for (let i = 0; i < south.width * south.height; i++) {
            const v = m.relief[i];
            if (!Number.isFinite(v)) { rgb.set([60, 60, 60], i * 3); continue; }
            const a = Math.max(-1, Math.min(1, v / 0.5));
            rgb.set(a >= 0 ? [235, Math.round(235 * (1 - a)), Math.round(235 * (1 - a))] : [Math.round(235 * (1 + a)), Math.round(235 * (1 + a)), 235], i * 3);
        }
        shot('synthetic_relief_map_noisy.png', south.width, south.height, rgb);
    }, 120_000);

    it('recovers the cornice and string-course profiles, the pilasters, and the windows\' reveal and sill within tolerance', async () => {
        const south = run.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        const g = grammarFor(south.index);
        outcome = await runReliefStage({
            massing: MASSING, run, build: { parts: MASSING.parts, sweeps: [], openings: [] },
            base: { run, ...plainTextures(run) }, grammars: [g], tilePath: tile, isolateGlb: tile, dir: path.join(dir, 'relief'), stage: 'relief', stageKey: 'test'
        });
        const fr = outcome.report.faces.find(f => f.index === south.index)!;
        expect(Math.abs(fr.baseline)).toBeLessThan(0.05);
        const rowT = (y: number) => south.orthoTMax - (y + 0.5) * south.pixel;
        // bands: exactly the cornice and the string course (nothing the facade does not have)
        const bands = fr.bands.filter(b => b.accepted);
        const tRange = (b: typeof bands[number]) => [rowT(b.l1), rowT(b.l0)];
        const cornice = bands.find(b => tRange(b)[0] > 13 && tRange(b)[1] < 14.8)!;
        const string = bands.find(b => tRange(b)[0] > 4.5 && tRange(b)[1] < 5.4)!;
        expect(cornice).toBeTruthy();
        expect(string).toBeTruthy();
        for (const b of bands) expect(b === cornice || b === string, `an accepted band at ${tRange(b).map(x => x.toFixed(2))} m`).toBe(true);
        expect(cornice.fullLength).toBe(true);
        expect(Math.abs(cornice.depth - CORNICE.depth)).toBeLessThan(0.06);
        expect(cornice.depth).toBeGreaterThanOrEqual(K_SIGMA * cornice.se);
        expect(cornice.blocks).toBeGreaterThanOrEqual(MIN_BLOCKS);
        // the cornice's cross-section against its truth (rows inside the true band; the scan's 8 cm grid smooths the edges)
        const err: number[] = [];
        cornice.lines.forEach((l, k) => { const t = rowT(l); if (t > CORNICE.t0 + 0.1 && t < CORNICE.t1 - 0.1) err.push(cornice.profile[k] - CORNICE_AT(t)); });
        const rms = Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length);
        expect(err.length).toBeGreaterThan(10);
        expect(rms).toBeLessThan(0.05);
        expect(Math.abs(string.depth - STRING.depth)).toBeLessThan(0.05);
        // vertical elements: the two pilasters, at their place
        const verts = fr.verticals.filter(v => v.accepted);
        const colS = (x: number) => south.orthoSMin + (x + 0.5) * south.pixel;
        expect(verts.length).toBe(2);
        for (const v of verts) {
            const s0 = colS(v.l0), s1 = colS(v.l1);
            expect(PILASTERS.some(p => s0 > p.s0 - 0.15 && s1 < p.s1 + 0.15), `a vertical element at ${s0.toFixed(2)}-${s1.toFixed(2)} m`).toBe(true);
            expect(Math.abs(v.depth - PILASTER_DEPTH)).toBeLessThan(0.04);
        }
        // the lattice unit: 18 openings co-registered and averaged
        expect(fr.units.length).toBe(1);
        const u = fr.units[0];
        expect(u.members.length).toBe(18);
        expect(u.reveal.accepted).toBe(true);
        expect(u.reveal.n).toBeGreaterThanOrEqual(MIN_OPENINGS);
        expect(Math.abs(u.reveal.depth - REVEAL)).toBeLessThan(0.04);
        expect(u.below.accepted).toBe(true);
        expect(Math.abs(u.below.depth - SILL.depth)).toBeLessThan(0.035);
        // the sill runs past both jambs by about its overhang
        expect(u.below.a0).toBeLessThan(0.02);
        expect(u.below.a1).toBeGreaterThan(-0.02);
        // nothing stands out above or beside the openings
        expect(u.above.accepted).toBe(false);
        expect(u.left.accepted).toBe(false);
        expect(u.right.accepted).toBe(false);
        // the plot and the averaged unit, for the record
        const rows = new Float32Array(fs.readFileSync(path.join(dir, 'relief', 'average', `rows_${south.index}.f32`)).buffer.slice(0));
        const plot = profilePlot(rows, south, fr.baseline, 0, 15);
        shot('synthetic_row_profile_vs_truth.png', plot.w, plot.h, plot.rgb);
        const patch = new Float32Array(fs.readFileSync(path.join(dir, 'relief', 'average', u.patch)).buffer.slice(0));
        const rgb = new Uint8Array(u.pw * u.ph * 3);
        for (let i = 0; i < u.pw * u.ph; i++) { const a = Math.max(-1, Math.min(1, patch[i] / 0.3)); rgb.set(!Number.isFinite(patch[i]) ? [60, 60, 60] : a >= 0 ? [235, Math.round(235 * (1 - a)), Math.round(235 * (1 - a))] : [Math.round(235 * (1 + a)), Math.round(235 * (1 + a)), 235], i * 3); }
        shot('synthetic_window_unit_averaged.png', u.pw, u.ph, rgb);
    }, 180_000);

    it('builds the measured geometry on the clean solid, labelled with its uncertainty', async () => {
        const names = outcome.run.nodes.map(n => n.name);
        const band = outcome.run.nodes.find(n => n.name.startsWith('sweep:relief_band_'))!;
        expect(band).toBeTruthy();
        // the swept cornice stands out of the wall by its measured depth, at its height
        let maxZ = -Infinity, yAtMax = 0;
        for (let i = 0; i < band.positions.length; i += 3) if (band.positions[i + 2] > maxZ) { maxZ = band.positions[i + 2]; yAtMax = band.positions[i + 1]; }
        const wallZ = outcome.run.report.faces.find(f => f.wall && f.normal[2] > 0.9)!.origin[2];
        expect(maxZ - wallZ).toBeGreaterThan(0.5);
        expect(maxZ - wallZ).toBeLessThan(0.7);
        expect(yAtMax).toBeGreaterThan(13.8);
        expect(names.filter(n => n.startsWith('facesweep:relief_vert_')).length).toBe(2);
        expect(names.some(n => n.startsWith('facesweep:relief_unit_') && n.endsWith('_below'))).toBe(true);
        const recesses = outcome.run.nodes.filter(n => n.kind === 'opening');
        expect(recesses.length).toBe(18);
        // every recess is as deep as the measured reveal
        for (const r of recesses) {
            const zs = Array.from(r.positions.filter((_, i) => i % 3 === 2));
            expect(Math.abs((Math.max(...zs) - Math.min(...zs)) - outcome.report.faces[0].units[0].reveal.depth)).toBeLessThan(0.01);
        }
        // provenance: measured by averaging the scan, with the standard error
        const rec = outcome.geometry.provenance.get(band.name)!;
        expect(rec.label).toBe(MEASURED_AVERAGED_LABEL);
        expect(rec.measuredGeometry).toBe(true);
        expect(rec.note).toMatch(/\+- [0-9.]+ m \(standard error\)/);
        expect(outcome.counts.bands.accepted).toBe(2);
        expect(outcome.counts.verticals.accepted).toBe(2);
        expect(outcome.counts.reveals.accepted).toBe(1);
        // clay before and after: front, oblique, close-up of the cornice and windows
        const before = (await cleanRun(path.join(dir, 'b'), tile)).nodes.filter(n => n.kind !== 'residual');
        const after = outcome.run.nodes.filter(n => n.kind !== 'residual');
        const views: Array<[string, [number, number, number], [number, number, number], number]> = [
            ['front', [12, 7.5, 30], [12, 7.5, 0], 50], ['oblique', [34, 12, 22], [12, 7, 0], 50], ['closeup', [9, 11.5, 6.5], [8, 12.5, 0], 50]
        ];
        for (const [name, eye, target, fov] of views) {
            const a = clayRender(before, eye, target, 720, 480, fov), b = clayRender(after, eye, target, 720, 480, fov);
            const both = new Uint8Array(1448 * 480 * 3).fill(255);
            for (let y = 0; y < 480; y++) { both.set(a.subarray(y * 720 * 3, (y + 1) * 720 * 3), y * 1448 * 3); both.set(b.subarray(y * 720 * 3, (y + 1) * 720 * 3), (y * 1448 + 728) * 3); }
            shot(`synthetic_clay_${name}_before_after.png`, 1448, 480, both);
        }
    }, 180_000);

    it('fails the gate on a facade with no repeated relief (noise only): nothing is kept', async () => {
        const south = run.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        // noise alone: the same white, correlated and outlier noise, no relief
        let st = 5;
        const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
        const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
        const relief = new Float32Array(south.width * south.height);
        for (let i = 0; i < relief.length; i++) relief[i] = 0.10 * gauss() + (rnd() < 0.03 ? (rnd() * 2 - 1) * 0.7 : 0);
        const g = grammarFor(south.index);
        const cells = g.tiers.flatMap(t => t.cols.map(([s0, s1]) => ({ group: 0, x0: (s0 - south.orthoSMin) / south.pixel, x1: (s1 - south.orthoSMin) / south.pixel, y0: (south.orthoTMax - t.t1) / south.pixel, y1: (south.orthoTMax - t.t0) / south.pixel })));
        const rep = await runReliefAverage([{ face: south, relief, openings: cells }], path.join(dir, 'noise'));
        const fr = rep.faces[0];
        expect(fr.bands.filter(b => b.accepted).length).toBe(0);
        expect(fr.verticals.filter(b => b.accepted).length).toBe(0);
        const u = fr.units[0];
        expect([u.reveal, u.below, u.above, u.left, u.right].filter(x => x.accepted).length).toBe(0);
    }, 60_000);
});
