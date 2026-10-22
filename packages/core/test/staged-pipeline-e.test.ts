/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged-location pipeline E on synthetic inputs (no network, no model): the native footprint extrusion (closed volume, cut
 * party walls, roof planes), the ortho bake of a photo-textured scan onto a clean wall moved onto it, bay averaging on a
 * noisy repeated facade with an occluded bay, and tree separation (a crown in front of a wall masked and refilled from the
 * facade's own bays). Screenshots under test-results/screenshots/version_e/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { buildMassing, cellsFootprint, massingSpecText, ringArea, simplifyRing, solarPlane, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { readFaceOrtho, runMassing, type MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { writeMassingTexturedGlb, type FaceTexture } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import { averageBays, bayGroups } from '../src/node/3d-engine/staged-location/pipeline-e/bay-average';
import { crownMask, crownsFromStrip, fillFromOtherFacades } from '../src/node/3d-engine/staged-location/pipeline-e/occluders';
import { straighten } from '../src/node/3d-engine/staged-location/pipeline-e/straighten';
import { stagedPipelineE } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_e');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-e-'));
const shot = (name: string, w: number, h: number, rgba: Uint8Array) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), encodePng(w, h, Buffer.from(rgba), 4)); };

/** Signed volume of the closed nodes (divergence theorem). */
function volume(nodes: MassingNode[]): number {
    let v = 0;
    for (const n of nodes) {
        if (n.kind === 'opening' || n.kind === 'residual' || n.kind === 'sweep') continue;
        const P = n.positions;
        for (let i = 0; i < n.indices.length; i += 3) {
            const a = n.indices[i] * 3, b = n.indices[i + 1] * 3, c = n.indices[i + 2] * 3;
            v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
        }
    }
    return v;
}

describe('pipeline E flag', () => {
    it('is on by default (an isolated structure); SCRATCHBOX_STAGED_PIPELINE=d (or 0) goes back to the current pipeline', () => {
        expect(stagedPipelineE({} as NodeJS.ProcessEnv)).toBe(true);
        expect(stagedPipelineE({ SCRATCHBOX_STAGED_PIPELINE: 'e' } as NodeJS.ProcessEnv)).toBe(true);
        expect(stagedPipelineE({ SCRATCHBOX_STAGED_PIPELINE: 'E' } as NodeJS.ProcessEnv)).toBe(true);
        expect(stagedPipelineE({ SCRATCHBOX_STAGED_PIPELINE: 'd' } as NodeJS.ProcessEnv)).toBe(false);
        expect(stagedPipelineE({ SCRATCHBOX_STAGED_PIPELINE: 'D' } as NodeJS.ProcessEnv)).toBe(false);
        expect(stagedPipelineE({ SCRATCHBOX_STAGED_PIPELINE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    });
});

describe('footprint extrusion (native)', () => {
    it('extrudes adjacent parts into one closed solid: the shared wall is cut to what stands above the lower part', async () => {
        const dir = tmp();
        const m: Pick<Massing, 'parts' | 'meshes'> = {
            parts: [
                { id: 'a', baseY: 0, topY: 10, loops: [[[0, 0], [20, 0], [20, -10], [0, -10]]], planes: [], heightSource: 'vector', heights: {} },
                { id: 'b', baseY: 0, topY: 6, loops: [[[20, 0], [30, 0], [30, -10], [20, -10]]], planes: [], heightSource: 'vector', heights: {} }
            ],
            meshes: []
        };
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 } }), dir);
        // 20x10x10 + 10x10x6, every face outward (positive volume) and closed
        expect(volume(r.nodes)).toBeCloseTo(2600, 3);
        const shared = r.report.faces.find(f => f.key === 'w:a:0:1')!;
        expect(shared.tBottom).toBeCloseTo(6, 6);  // only the 4 m above part b
        expect(shared.area).toBeCloseTo(40, 6);
        // part b's wall against part a is inside a taller part: dropped
        expect(r.report.faces.some(f => f.key.startsWith('w:b:0:3'))).toBe(false);
    });

    it('shapes a pitched roof from Solar facets as the lower envelope of planes, closed with gable walls', async () => {
        const dir = tmp();
        // a 10 x 8 m box, eaves at 6 m; two facets facing north and south, 30 degrees, ridge along x at z = -4
        const k = Math.tan(Math.PI / 6);
        const south = solarPlane({ pitchDeg: 30, azimuthDeg: 180, x: 5, z: -2, y: 6 + 2 * k });
        const north = solarPlane({ pitchDeg: 30, azimuthDeg: 0, x: 5, z: -6, y: 6 + 2 * k });
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'g', baseY: 0, topY: 20, loops: [[[0, 0], [10, 0], [10, -8], [0, -8]]], planes: [south, north], heightSource: 'solar', heights: {} }], meshes: [] };
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 } }), dir);
        // box 10 * 8 * 6 plus the prism 10 * (8 * 4k / 2)
        expect(volume(r.nodes)).toBeCloseTo(480 + 10 * 16 * k, 2);
        const gable = r.report.faces.find(f => f.key === 'w:g:0:1')!;
        expect(Math.max(...gable.top.map(p => p[1]))).toBeCloseTo(6 + 4 * k, 4);
        expect(r.report.faces.filter(f => f.kind === 'roof').length).toBe(2);
    });

    it('cuts an arched opening (the wall loses the rectangle and the arch, the recess closes it), a plain rectangle unchanged, and a door from the ground', async () => {
        const dir = tmp();
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'g', baseY: 0, topY: 10, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const probe = await runMassing(massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 } }), dir);
        const wall = probe.report.faces.find(f => f.kind === 'wall' && Math.abs(f.sMax - f.sMin - 10) < 1e-6)!;
        const mid = 0.5 * (wall.sMin + wall.sMax);
        const openings = [
            { id: 'arch', face: wall.key, s0: mid - 1, s1: mid + 1, t0: 2, t1: 6, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred', archRiseM: 1 },
            { id: 'rect', face: wall.key, s0: wall.sMin + 1, s1: wall.sMin + 2.5, t0: 2, t1: 5, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred' },
            // a shop front read 2 cm above the street: it starts at the wall's bottom
            { id: 'door', face: wall.key, s0: wall.sMax - 3, s1: wall.sMax - 1.5, t0: 0.02, t1: 2.5, depth: 0.3, scanned: false, confidence: 0.5, provenance: 'photo-inferred' }
        ];
        const spec = massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 }, openings });
        expect(spec).toContain(' arch 1');
        const r = await runMassing(spec, dir);
        expect(r.report.rejectedOpenings).toEqual([]);
        const st = (n: MassingNode) => {
            const out: Array<[number, number]> = [];
            for (let i = 0; i < n.positions.length; i += 3) {
                const d = [n.positions[i] - wall.origin[0], n.positions[i + 1] - wall.origin[1], n.positions[i + 2] - wall.origin[2]];
                out.push([d[0] * wall.axisS[0] + d[1] * wall.axisS[1] + d[2] * wall.axisS[2], d[0] * wall.axisT[0] + d[1] * wall.axisT[1] + d[2] * wall.axisT[2]]);
            }
            return out;
        };
        const tris = (n: MassingNode, keep: (i: number) => boolean = () => true) => {
            const p = st(n), out: Array<[[number, number], [number, number], [number, number]]> = [];
            for (let i = 0; i < n.indices.length; i += 3) if (keep(i)) out.push([p[n.indices[i]], p[n.indices[i + 1]], p[n.indices[i + 2]]]);
            return out;
        };
        const area = (ts: ReturnType<typeof tris>) => ts.reduce((a, [p, q, s]) => a + Math.abs((q[0] - p[0]) * (s[1] - p[1]) - (s[0] - p[0]) * (q[1] - p[1])) / 2, 0);
        const covers = (ts: ReturnType<typeof tris>, s: number, t: number) => ts.some(([p, q, u]) => {
            const d = (q[0] - p[0]) * (u[1] - p[1]) - (u[0] - p[0]) * (q[1] - p[1]);
            const a = ((s - p[0]) * (u[1] - p[1]) - (u[0] - p[0]) * (t - p[1])) / d, b = ((q[0] - p[0]) * (t - p[1]) - (s - p[0]) * (q[1] - p[1])) / d;
            return a >= 0 && b >= 0 && a + b <= 1;
        });
        // the arch: 2 x 3 m below the springing line plus a semicircle of radius 1 sampled in 16 segments
        const segment = 0.5 * 16 * Math.sin(Math.PI / 16);
        const wallNode = r.nodes.find(n => n.name === wall.key)!;
        const wallTris = tris(wallNode);
        expect(area(wallTris)).toBeCloseTo(10 * 10 - (6 + segment) - 1.5 * 3 - 1.5 * 2.5, 3);
        expect(covers(wallTris, wall.sMax - 2.25, 0.01)).toBe(false);  // open down to the street
        expect(covers(wallTris, mid, 5.9)).toBe(false);           // under the crown: open
        expect(covers(wallTris, mid - 0.97, 5.9)).toBe(true);     // the spandrel beside the crown: wall
        expect(covers(wallTris, mid - 0.97, 4.5)).toBe(false);    // the jamb's inside below the springing: open
        // the recess: its back panel (facing out, 0.3 m behind) has the hole's area; the rectangle keeps 2 back + 8 reveal triangles
        const arch = r.nodes.find(n => n.name === 'opening:arch')!;
        const backOnly = (n: MassingNode) => (i: number) => {
            const v = n.indices[i] * 3;
            return Math.abs(n.normals[v] - wall.normal[0]) + Math.abs(n.normals[v + 1] - wall.normal[1]) + Math.abs(n.normals[v + 2] - wall.normal[2]) < 1e-6;
        };
        expect(area(tris(arch, backOnly(arch)))).toBeCloseTo(6 + segment, 3);
        const rect = r.nodes.find(n => n.name === 'opening:rect')!;
        expect(rect.indices.length / 3).toBe(10);
        expect(area(tris(rect, backOnly(rect)))).toBeCloseTo(4.5, 6);
        const door = r.nodes.find(n => n.name === 'opening:door')!;
        expect(Math.min(...st(door).map(p => p[1]))).toBeCloseTo(0, 6);
    });

    it('simplifies a noisy plan ring to its corners', () => {
        const ring: Array<[number, number]> = [];
        for (let i = 0; i <= 20; i++) ring.push([i, 0.03 * Math.sin(i)]);
        ring.push([20, -10], [0, -10]);
        expect(simplifyRing(ring).length).toBe(4);
    });

    it('checks the massing against the scan and refuses one that disagrees', () => {
        const cells = new Set<string>();
        for (let x = 0; x < 20; x++) for (let z = -10; z < 0; z++) cells.add(`${x},${z}`);
        const building = { id: 'b', parts: [], extruded: [{ loops: [[[0, 0], [20, 0], [20, -10], [0, -10]] as Array<[number, number]>], heightM: 12 }] };
        const ok = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 12.4, cells });
        expect(ok.check.ok).toBe(true);
        expect(ok.check.iou).toBeCloseTo(1, 2);
        expect(ok.parts[0].heightSource).toBe('vector');
        const off = buildMassing({ buildings: [{ ...building, extruded: [{ loops: [[[30, 0], [50, 0], [50, -10], [30, -10]] as Array<[number, number]>], heightM: 12 }] }], groundY: 0, scanTop: () => 12, cells });
        expect(off.check.ok).toBe(false);
        expect(off.check.reason).toMatch(/intersection over union/);
    });

    it('masses a building from its footprint over its modelled volume when asked (pipeline G), and from the volume otherwise', () => {
        const cells = new Set<string>();
        for (let x = 0; x < 20; x++) for (let z = -10; z < 0; z++) cells.add(`${x},${z}`);
        // a modelled box volume (heights from the ground) and the same footprint, plan only
        const v: Array<[number, number, number]> = [[0, 0, 0], [20, 0, 0], [20, 0, -10], [0, 0, -10], [0, 12, 0], [20, 12, 0], [20, 12, -10], [0, 12, -10]];
        const idx = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7];
        const building = { id: 'b', parts: [], volumes: [{ vertices: v, indices: idx }], extruded: [{ loops: [[[0, 0], [20, 0], [20, -10], [0, -10]] as Array<[number, number]>], planOnly: true }] };
        const asModelled = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 12, cells });
        expect(asModelled.meshes.length).toBe(1);
        expect(asModelled.parts.length).toBe(0);
        const fromFootprint = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 12, cells, preferExtrusion: true });
        expect(fromFootprint.meshes.length).toBe(0);
        expect(fromFootprint.parts.length).toBe(1);
        expect(fromFootprint.parts[0].topY).toBeCloseTo(12, 1);
        // with no vector footprint, the scan's plan of the structure (its cells) is the footprint
        const volumeOnly = buildMassing({ buildings: [{ ...building, extruded: [] }], groundY: 0, scanTop: () => 12, cells, preferExtrusion: true });
        expect(volumeOnly.meshes.length).toBe(0);
        expect(volumeOnly.parts.length).toBe(1);
        expect(Math.abs(ringArea(volumeOnly.parts[0].loops[0]))).toBeCloseTo(200, 0);
        // a stepped diagonal edge in the cells straightens to one edge
        const tri = new Set<string>();
        for (let x = 0; x < 30; x++) for (let z = 0; z <= x; z++) tri.add(`${x},${z}`);
        const plan = cellsFootprint(tri)!;
        expect(plan.length).toBeLessThanOrEqual(4);
        expect(Math.abs(ringArea(plan))).toBeCloseTo(450, -1);
    });
});

describe('ortho bake (native)', () => {
    it('moves the wall onto the scanned facade and textures it with the tile photo through a thin slab', async () => {
        const dir = tmp();
        // the "scan": a 12 x 9 m box whose south facade (normal +z) stands at z = 1.0, 1 m outside the vector plan (z = 0);
        // its photo is vertical stripes, red where u < 0.5 and blue beyond
        const W = 64, H = 64, img = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.set(x < W / 2 ? [220, 40, 40, 255] : [40, 40, 220, 255], (y * W + x) * 4);
        const quad = (p: number[][], uv: number[][]) => ({ p, uv });
        const z0 = 1.0, x0 = 0, x1 = 12, h = 9, back = -9;
        const faces = [
            quad([[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]], [[0, 1], [1, 1], [1, 0], [0, 0]]),             // south +z
            quad([[x1, 0, z0], [x1, 0, back], [x1, h, back], [x1, h, z0]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),       // east
            quad([[x1, 0, back], [x0, 0, back], [x0, h, back], [x1, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),   // north
            quad([[x0, 0, back], [x0, 0, z0], [x0, h, z0], [x0, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),       // west
            quad([[x0, h, z0], [x1, h, z0], [x1, h, back], [x0, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]])        // roof
        ];
        const pos: number[] = [], st: number[] = [], idx: number[] = [], ref: number[] = [], nrm: number[] = [];
        for (const f of faces) {
            const b = pos.length / 3;
            f.p.forEach((q, k) => { pos.push(...q); st.push(...f.uv[k]); ref.push(-2); nrm.push(0, 1, 0); });
            idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
        const node: MassingNode = { name: 'scan', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array(pos), normals: new Float32Array(nrm), ref: new Int32Array(ref), st: new Float32Array(st), indices: new Uint32Array(idx) };
        const tileGlb = writeMassingTexturedGlb({
            nodes: [node], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }),
            textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(W, H, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0
        }).glb;
        const tile = path.join(dir, 'tile.glb');
        fs.writeFileSync(tile, tileGlb);
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'p', baseY: 0, topY: 9, loops: [[[0, 0], [12, 0], [12, -9], [0, -9]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const r = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'out'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 2, snapMinSupport: 0.1, sections: 0 } }), path.join(dir, 'out'));
        const snap = r.report.snap.find(s => s.edge === 0)!;
        expect(snap.applied).toBe(true);
        expect(snap.offsetM).toBeCloseTo(1.0, 1);
        const southFace = r.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        expect(southFace.coverage).toBeGreaterThan(0.9);
        const o = readFaceOrtho(r.dir, southFace)!;
        shot('ortho_bake_south_face.png', o.width, o.height, o.rgba);
        // left half red, right half blue (s grows to the right as seen from outside: +x)
        const px = (s: number, t: number) => { const x = Math.floor((s - southFace.orthoSMin) / southFace.pixel), y = Math.floor((southFace.orthoTMax - t) / southFace.pixel); return Array.from(o.rgba.subarray((y * o.width + x) * 4, (y * o.width + x) * 4 + 3)); };
        const sAt = (x: number) => (x - southFace.origin[0]) * southFace.axisS[0];
        expect(px(sAt(3), 4)[0]).toBeGreaterThan(180);
        expect(px(sAt(3), 4)[2]).toBeLessThan(80);
        expect(px(sAt(9), 4)[2]).toBeGreaterThan(180);
        // nothing proud or cut: the clean solid explains the scan
        expect(r.report.residual.proud + r.report.residual.cut).toBe(0);
    });
});

/** A repeated facade: wall colour, a lattice of windows with frames, deterministic noise. */
function facade(W: number, H: number, cols: number, rows: number, noise: number, seed = 7): { tex: FaceTexture; truth: Uint8Array; openings: Array<Array<{ x0: number; x1: number; y0: number; y1: number }>> } {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
    const truth = new Uint8Array(W * H * 4), rgba = new Uint8Array(W * H * 4);
    const openings: Array<Array<{ x0: number; x1: number; y0: number; y1: number }>> = [];
    const bw = W / cols, bh = H / rows;
    for (let r = 0; r < rows; r++) {
        const tier: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
        for (let c = 0; c < cols; c++) tier.push({ x0: c * bw + bw * 0.3, x1: c * bw + bw * 0.7, y0: r * bh + bh * 0.2, y1: r * bh + bh * 0.8 });
        openings.push(tier);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const lx = (x % bw) / bw, ly = (y % bh) / bh;
        let c = [180, 120, 90];
        if (lx >= 0.3 && lx < 0.7 && ly >= 0.2 && ly < 0.8) c = lx < 0.5 ? [40, 50, 70] : [70, 80, 100];
        if ((lx >= 0.25 && lx < 0.3) || (lx >= 0.7 && lx < 0.75)) if (ly >= 0.15 && ly < 0.85) c = [230, 225, 215];
        const i = (y * W + x) * 4;
        truth.set([...c, 255], i);
        rgba.set([...c.map(v => Math.max(0, Math.min(255, Math.round(v + noise * rnd())))), 255], i);
    }
    return { tex: { width: W, height: H, rgba, source: new Uint8Array(W * H) }, truth, openings };
}

const rmse = (a: Uint8Array, b: Uint8Array, keep?: (i: number) => boolean) => {
    let s = 0, n = 0;
    for (let i = 0; i < a.length / 4; i++) { if (keep && !keep(i)) continue; for (let c = 0; c < 3; c++) s += (a[i * 4 + c] - b[i * 4 + c]) ** 2; n += 3; }
    return Math.sqrt(s / Math.max(1, n));
};

describe('bay averaging', () => {
    it('recovers the clean bay from noisy repeats and fills an occluded bay with real pixels', () => {
        const W = 400, H = 160;
        const { tex, truth, openings } = facade(W, H, 10, 2, 70);
        // an occluder over one bay: a dark green blob, masked
        const clean = new Uint8Array(W * H).fill(1);
        for (let y = 90; y < 150; y++) for (let x = 126; x < 154; x++) { tex.rgba.set([30, 90, 30, 255], (y * W + x) * 4); clean[y * W + x] = 0; }
        const before = rmse(tex.rgba, truth);
        const beforeOcc = rmse(tex.rgba, truth, i => !clean[i]);
        const r = averageBays(tex, bayGroups(openings), clean, 9);
        shot('bay_average_after.png', W, H, tex.rgba);
        expect(r.groups.every(g => g.accepted)).toBe(true);
        const after = rmse(tex.rgba, truth), afterOcc = rmse(tex.rgba, truth, i => !clean[i]);
        expect(after).toBeLessThan(0.7 * before);
        expect(afterOcc).toBeLessThan(0.35 * beforeOcc);
        expect(r.texelsReplaced).toBeGreaterThan(0.5 * W * H * 0.5);
    });

    it('refuses bays that do not repeat', () => {
        const W = 400, H = 80;
        const { tex, openings } = facade(W, H, 10, 1, 0);
        // every bay different: random content per bay
        let s = 3;
        for (let i = 0; i < W * H; i++) { s = (s * 69069 + 1) >>> 0; tex.rgba.set([s & 255, (s >> 8) & 255, (s >> 16) & 255, 255], i * 4); }
        const r = averageBays(tex, bayGroups(openings), new Uint8Array(W * H).fill(1), 9);
        expect(r.groups.every(g => !g.accepted)).toBe(true);
        expect(r.texelsReplaced).toBe(0);
    });
});

describe('straightened texture', () => {
    it('warps edges onto the lattice lines when they are off, and keeps the warp only when it helps', () => {
        const W = 300, H = 100;
        const { tex, openings } = facade(W, H, 6, 1, 0);
        // the photo's windows sit 4 px right of the lattice
        const shifted = new Uint8Array(tex.rgba.length);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) shifted.set(tex.rgba.subarray((y * W + Math.max(0, x - 4)) * 4, (y * W + Math.max(0, x - 4)) * 4 + 4), (y * W + x) * 4);
        const lines = { xs: openings[0].flatMap(o => [{ at: o.x0, y0: o.y0, y1: o.y1 }, { at: o.x1, y0: o.y0, y1: o.y1 }]), ys: [{ at: openings[0][0].y0, x0: 0, x1: W }, { at: openings[0][0].y1, x0: 0, x1: W }] };
        const r = straighten({ ...tex, rgba: shifted }, lines, 0.05);
        expect(r.accepted).toBe(true);
        expect(r.after).toBeLessThan(r.before * 0.5);
    });
});

describe('tree separation', () => {
    it('masks the facade behind a measured crown and refills it from the facade itself, not the tree', () => {
        // a wall facing +z at z = 0 from x 0..20, 8 m tall; 5 cm texels
        const W = 400, H = 160;
        const { tex, truth, openings } = facade(W, H, 10, 2, 0);
        const face = { index: 0, key: 'w', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1] as [number, number, number], axisS: [1, 0, 0] as [number, number, number], axisT: [0, 1, 0] as [number, number, number], origin: [0, 0, 0] as [number, number, number], sMin: 0, sMax: 20, tMin: 0, tMax: 8, tBottom: 0, area: 160, pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: W, height: H, coverage: 1, openings: [], top: [] };
        // the strip's crown: a tree 3 m in front of the wall at x = 7, crown radius 1.5 m, 1 to 7 m
        const crowns = crownsFromStrip({ crowns: [{ id: 1, status: 'tree', apex: [7, 7, 3], stem: [7, 3], supportY: 1, sectorRadii: [1.5, 1.4, 1.5] }, { id: 2, status: 'tree', apex: [7, 7, -6], stem: [7, -6], supportY: 1, sectorRadii: [1.5] }] });
        // the photogrammetric texture baked the tree onto the wall
        const cm = crownMask(face, crowns);
        expect(cm.crowns).toEqual([1]);  // the tree behind the wall hides nothing
        for (let i = 0; i < W * H; i++) if (cm.mask[i]) tex.rgba.set([40, 110, 35, 255], i * 4);
        const masked = Uint8Array.from(cm.mask);
        const maskedCount = masked.reduce((a, b) => a + b, 0);
        expect(maskedCount).toBeGreaterThan(1000);
        const clean = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) clean[i] = masked[i] ? 0 : 1;
        const greenBefore = rmse(tex.rgba, truth, i => cm.mask[i] === 1);
        const bays = averageBays(tex, bayGroups(openings), clean, 9);
        for (let i = 0; i < W * H; i++) if (tex.source[i] === 9) masked[i] = 0;
        const textures = new Map([[0, tex]]), cleanOf = new Map([[0, clean]]);
        fillFromOtherFacades(0, [face], textures, cleanOf, masked, 10, { pitchPx: W / 10 });
        shot('tree_separation_after.png', W, H, tex.rgba);
        expect(bays.texelsReplaced).toBeGreaterThan(0);
        const greenAfter = rmse(tex.rgba, truth, i => cm.mask[i] === 1);
        expect(greenAfter).toBeLessThan(0.2 * greenBefore);
        // nothing green is left where the crown stood
        let green = 0;
        for (let i = 0; i < W * H; i++) if (cm.mask[i] && tex.rgba[i * 4 + 1] > tex.rgba[i * 4] + 30) green++;
        expect(green).toBe(0);
    });
});

describe('enhanced mode (alignment, reported, and plate prompt)', () => {
    it('corrects a sharper redraw a few pixels off and reports how far a redraw\'s openings moved (the identity gate decides)', async () => {
        const { alignPlate } = await import('../src/node/3d-engine/staged-location/pipeline-e/enhance');
        const W = 300, H = 120;
        const { tex } = facade(W, H, 6, 1, 20);
        const use = new Uint8Array(W * H).fill(1);
        // a clean redraw: the noiseless facade, 3 px to the right
        const clean = facade(W, H, 6, 1, 0).tex.rgba;
        const shifted = new Uint8Array(clean.length);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.max(0, x - 3); shifted.set(clean.subarray((y * W + sx) * 4, (y * W + sx) * 4 + 4), (y * W + x) * 4); }
        const ok = alignPlate(tex.rgba, shifted, W, H, use, 0.05);
        expect(ok.accepted).toBe(true);
        expect(Math.abs(ok.dx + 3)).toBeLessThanOrEqual(1);
        // openings moved: a facade with 5 bays instead of 6
        const moved = facade(W, H, 5, 1, 0).tex.rgba;
        const bad = alignPlate(tex.rgba, moved, W, H, use, 0.05);
        expect(bad.chamferPx).toBeGreaterThan(ok.chamferPx + 1);
        expect(bad.lostShare).toBeGreaterThan(ok.lostShare);
        expect(bad.why).toMatch(/reported/);
        const rgba = new Uint8Array(W * 3 * H * 4);
        for (let y = 0; y < H; y++) { rgba.set(tex.rgba.subarray(y * W * 4, (y + 1) * W * 4), y * W * 12); rgba.set(ok.aligned.subarray(y * W * 4, (y + 1) * W * 4), y * W * 12 + W * 4); rgba.set(bad.aligned.subarray(y * W * 4, (y + 1) * W * 4), y * W * 12 + W * 8); }
        shot('enhance_alignment_gate.png', W * 3, H, rgba);
    });

    it('builds the texture-plate prompt without changing the Beautify template', async () => {
        const svc = await import('../src/browser/generative-canvas/services/location-beautify-service');
        const { preserveClause } = await import('../src/node/3d-engine/staged-location/pipeline-e/enhance');
        const p = svc.buildTexturePlatePrompt({ locationName: 'X', widthM: 20, heightM: 10, widthPx: 400, heightPx: 200, preserveClause: preserveClause(400, 200), withReference: true });
        expect(p).toMatch(/flat orthographic elevation/);
        expect(p).toMatch(/Keep every object, edge, letter and ornament exactly where it is/);
        expect(p).toMatch(/no depth of field, no haze/);
        expect(p).toMatch(/adjacent wall/);
        expect(svc.buildBeautifyPrompt({ locationName: 'X', coords: '1.000000, 2.000000', heading: 0, aspectRatio: '16:9', earthUrl: 'u' })).toMatch(/^Transform this malformed 3D photogrammetry render of X/);
    });
});
