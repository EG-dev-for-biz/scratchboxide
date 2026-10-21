/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 3 on synthetic inputs, no network and no model: the native render-compare kernel against the JavaScript
 * reference, the batched adjustment recovering a known lattice, the per-wall reading's parsing, arcade piers between grouped
 * bays, raised volumes kept, the local identity gate, the must-keep feature guard, best-of-3 selection and the scheduling order.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing, type MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { DEFAULT_PARAMETERS, parseFacadeParameters, facadeParametersPrompt, type BuildingParameters } from '../src/node/3d-engine/staged-location/version-f/facade-parameters';
import { facadeProgram } from '../src/node/3d-engine/staged-location/version-f/facade-program';
import { programWallOffset, wallEvidence, compareWall, type WallEvidence, type WallTile } from '../src/node/3d-engine/staged-location/version-f/render-compare';
import { adjustParameters, adjustParametersNative, refineWallsNative } from '../src/node/3d-engine/staged-location/version-f/adjust';
import { NativeCompare, scoreRectsJs, wallRects, type OffsetRect } from '../src/node/3d-engine/staged-location/version-f/native-compare';
import { VERSION_F_NATIVE_PARAMS } from '../src/node/3d-engine/staged-location/version-f/version-f';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'version-f3-'));
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_f3');

/** A 24 x 12 m box, 14 m tall, standing on y = 0, with a lower 8 x 12 m wing against its west side (as staged-version-f.test.ts). */
const MASSING: Pick<Massing, 'parts' | 'meshes' | 'check'> = {
    parts: [
        { id: 'main', baseY: 0, topY: 14, loops: [[[0, 0], [24, 0], [24, -12], [0, -12]]], planes: [], heightSource: 'vector', heights: {} },
        { id: 'wing', baseY: 0, topY: 6, loops: [[[-8, 0], [0, 0], [0, -12], [-8, -12]]], planes: [], heightSource: 'scan', heights: {} }
    ],
    meshes: [],
    check: { iou: 0.9, heightErrMedianM: 0.4, heightErrP90M: 1, massingCells: 0, scanCells: 0, ok: true } as Massing['check']
};

const PARAMS: BuildingParameters = {
    ...DEFAULT_PARAMETERS, groundStoreyM: 4, upperStoreysM: [3.0], bayWidthM: 3, edgeMarginM: 1,
    window: { widthM: 1.4, heightM: 2, sillM: 0.8, recessM: 0.25 }, groundOpening: { widthM: 2.2, heightM: 3, sillM: 0.2, recessM: 0.3 },
    plinth: { heightM: 0.6, projectionM: 0.12 }, bands: [{ heightM: 4, thicknessM: 0.3, projectionM: 0.2 }], cornice: { thicknessM: 0.6, projectionM: 0.5 },
    parapet: { heightM: 1 }, piers: { widthM: 0.4, projectionM: 0.1 }, confidence: 0.8
};

async function baseFaces(): Promise<MassingFace[]> {
    const dir = tmp();
    const r = await runMassing(massingSpecText(MASSING, { outDir: dir, params: { ...VERSION_F_NATIVE_PARAMS, topdown: 0 } }), dir);
    return r.report.faces.map(f => {
        if (f.kind !== 'wall') return f;
        const pixel = 0.1, w = Math.ceil((f.sMax - f.sMin) / pixel), h = Math.ceil((f.tMax - f.tBottom) / pixel);
        const seen = f.normal[2] > 0.9 || f.normal[0] > 0.9;
        return { ...f, pixel, width: w, height: h, orthoSMin: f.sMin, orthoTMax: f.tMax, coverage: seen ? 0.9 : 0.05 };
    });
}

/** A synthetic "photo" of a wall: light wall, dark windows on the lattice `truth` places, with a little noise; the depth is the offset. */
function syntheticEvidence(faces: MassingFace[], f: MassingFace, truth: BuildingParameters): { ev: WallEvidence; inside: Uint8Array; off: Float32Array } {
    const W = f.width, H = f.height;
    const tprog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: truth });
    const off = programWallOffset(f, tprog.openings, [], []);
    const luma = new Float32Array(W * H), depth = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { luma[i] = Number.isFinite(off[i]) ? (off[i] < -0.05 ? 50 : 190) + 10 * Math.sin(i * 12.9898) : NaN; depth[i] = Number.isFinite(off[i]) ? off[i] : NaN; }
    const tile: WallTile = { face: f, luma, depth };
    return { ev: wallEvidence(tile), inside: Uint8Array.from(off, v => (Number.isFinite(v) ? 1 : 0)), off };
}

const TRUTH: BuildingParameters = { ...PARAMS, groundStoreyM: 4.4, upperStoreysM: [3.0], bayWidthM: 3.0, cornice: { thicknessM: 0, projectionM: 0 }, bands: [], piers: { widthM: 0, projectionM: 0 }, plinth: { heightM: 0, projectionM: 0 }, parapet: { heightM: 0 } };

describe('version F round 3: native render-compare kernel', () => {
    it('scores the same rectangles as the JavaScript reference on two walls, to float precision, with unchanged walls kept', async () => {
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!, east = faces.find(f => f.part === 'main' && f.normal[0] > 0.9)!;
        const a = syntheticEvidence(faces, south, TRUTH), b = syntheticEvidence(faces, east, TRUTH);
        const inside = new Map([[south.index, a.inside], [east.index, b.inside]]);
        const nc = await NativeCompare.open(tmp(), [a.ev, b.ev], inside, 4);
        try {
            const prog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: PARAMS });
            const rs = wallRects(south, prog.openings, prog.sweeps, prog.faceSweeps), re = wallRects(east, prog.openings, prog.sweeps, prog.faceSweeps);
            expect(rs.length).toBeGreaterThan(20);
            expect(rs.some(r => r.mode === 1)).toBe(true);                 // bands and piers raise the offset
            // the rectangles drawn in JavaScript equal programWallOffset's map
            const jsRef = scoreRectsJs(a.ev, a.inside, rs), direct = compareWall(a.ev, programWallOffset(south, prog.openings, prog.sweeps, prog.faceSweeps, a.inside));
            expect(jsRef.windowNcc).toBeCloseTo(direct.windowNcc, 9);
            expect(jsRef.edgeDistM).toBeCloseTo(direct.edgeDistM, 9);
            expect(jsRef.depthMaeM).toBeCloseTo(direct.depthMaeM, 9);
            // the kernel: the same numbers, several candidates in one batch, some of them repeats
            const shifted: OffsetRect[] = rs.map(r => ({ ...r, x0: r.x0 + 3, x1: r.x1 + 3 }));
            const jobs = [{ face: south.index, rects: rs }, { face: east.index, rects: re }, { face: south.index, rects: shifted }, { face: south.index, rects: rs }, { face: east.index, rects: [] }];
            const scores = await nc.score(jobs);
            const refs = [scoreRectsJs(a.ev, a.inside, rs), scoreRectsJs(b.ev, b.inside, re), scoreRectsJs(a.ev, a.inside, shifted), scoreRectsJs(a.ev, a.inside, rs), scoreRectsJs(b.ev, b.inside, [])];
            scores.forEach((s, k) => {
                expect(s.ncc).toBeCloseTo(refs[k].windowNcc, 4);
                if (Number.isFinite(refs[k].edgeDistM)) expect(s.edgeDistM).toBeCloseTo(refs[k].edgeDistM, 4); else expect(Number.isNaN(s.edgeDistM)).toBe(true);
                expect(s.depthMaeM).toBeCloseTo(refs[k].depthMaeM, 4);
                expect(s.depthWithin015).toBeCloseTo(refs[k].depthWithin015, 4);
                expect(s.openingShare).toBeCloseTo(refs[k].openingShare, 4);
            });
            expect(scores[0].ncc).not.toBeCloseTo(scores[2].ncc, 2);         // a shifted lattice scores differently
            expect(nc.counts.sent).toBe(4);                                   // the repeat was answered from memory
            // a second batch with the same wall unchanged sends nothing for it
            const again = await nc.score([{ face: south.index, rects: rs }, { face: east.index, rects: re }]);
            expect(again[0].ncc).toBe(scores[0].ncc);
            expect(nc.counts.sent).toBe(4);
            expect(nc.counts.kept).toBe(3);                                   // the in-batch repeat and the two of the second batch
            // a wall the session does not hold scores NaN (never a made-up number)
            const none = await nc.score([{ face: 9999, rects: rs }]);
            expect(Number.isNaN(none[0].ncc)).toBe(true);
        } finally { nc.close(); }
    }, 60_000);

    it('adjusts a misread lattice back to the one the synthetic wall photo shows, like the JavaScript search, in batches', async () => {
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!, east = faces.find(f => f.part === 'main' && f.normal[0] > 0.9)!;
        const a = syntheticEvidence(faces, south, TRUTH), b = syntheticEvidence(faces, east, TRUTH);
        const inside = new Map([[south.index, a.inside], [east.index, b.inside]]);
        const start: BuildingParameters = { ...TRUTH, groundStoreyM: 3.9, upperStoreysM: [3.25], bayWidthM: 3.15 };
        const base = { faces, parts: MASSING.parts, groundY: 0, params: start };
        const t0 = Date.now();
        const nc = await NativeCompare.open(tmp(), [a.ev, b.ev], inside);
        let res;
        try { res = await adjustParametersNative(base, [a.ev, b.ev], nc, 3, { shapes: true }); } finally { nc.close(); }
        const nativeMs = Date.now() - t0;
        const first = res.rounds[0], last = res.rounds[res.rounds.length - 1];
        expect(last.objective).toBeLessThan(first.objective - 0.1);
        expect(last.windowNcc).toBeGreaterThan(0.8);
        expect(Math.abs(res.params.groundStoreyM - 4.4)).toBeLessThan(0.25);
        expect(Math.abs(res.params.upperStoreysM[0] - 3.0)).toBeLessThan(0.1);
        expect(res.batches).toBeGreaterThan(3);
        expect(res.keptJobs).toBeGreaterThan(0);                              // unchanged walls were not re-rendered
        // the JavaScript search on the same evidence lands in the same place
        const t1 = Date.now();
        const js = adjustParameters(base, [a.ev, b.ev], inside, 3, { shapes: true });
        const jsMs = Date.now() - t1;
        expect(Math.abs(js.params.groundStoreyM - res.params.groundStoreyM)).toBeLessThan(0.3);
        expect(js.rounds[js.rounds.length - 1].windowNcc).toBeGreaterThan(0.8);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'adjust_timing.txt'), `native adjust ${nativeMs} ms (${res.evaluations} evaluations, ${res.sentJobs} wall jobs sent, ${res.keptJobs} kept), JavaScript ${jsMs} ms (${js.evaluations} evaluations)\n`);
        // the Street View refinement: evidence of one wall shifted a third of a bay moves that wall's lattice only
        const shiftedPx = Math.round(1.0 / south.pixel);
        const luma2 = new Float32Array(south.width * south.height).fill(NaN), depth2 = new Float32Array(south.width * south.height).fill(NaN);
        for (let y = 0; y < south.height; y++) for (let x = shiftedPx; x < south.width; x++) { luma2[y * south.width + x] = a.ev.tile.luma[y * south.width + x - shiftedPx]; depth2[y * south.width + x] = a.ev.tile.depth[y * south.width + x - shiftedPx]; }
        const ev2 = wallEvidence({ face: south, luma: luma2, depth: depth2 });
        const nc2 = await NativeCompare.open(tmp(), [ev2], new Map([[south.index, a.inside]]));
        try {
            const ref = await refineWallsNative(base, res.params, res.perWall, [ev2], nc2);
            expect(ref.moved).toHaveLength(1);
            expect(ref.moved[0].face).toBe(south.index);
            expect(ref.moved[0].after).toBeLessThan(ref.moved[0].before - 0.05);
            expect(Math.abs((ref.perWall.get(south.index)!.phaseM ?? 0) - (res.perWall.get(south.index)?.phaseM ?? 0) - 1.0)).toBeLessThan(0.3);
            expect(ref.perWall.get(east.index)).toEqual(res.perWall.get(east.index));
        } finally { nc2.close(); }
    }, 120_000);
});

describe('version F round 3: per-wall reading and the program', () => {
    it('parses a wall reading with its own bays, families, arcade pier width and feature regions with open type codes', () => {
        const { params: p } = parseFacadeParameters(JSON.stringify({
            groundStoreyM: 5, upperStoreysM: [4], bayWidthM: 3.5,
            facadeBands: [{ bottomM: 5, topM: 13, opening: { widthM: 9, heightM: 7, sillM: 0.3, archRiseRatio: 1 }, bayGroup: 3, storeyGroup: 2, pierWidthM: 0.6 }],
            wallStoreys: [{ picture: 2, groundStoreyM: 6, upperStoreysM: [3.6], bayWidthM: 4.2, window: { widthM: 2, heightM: 3, sillM: 0.4 }, facadeBands: [{ bottomM: 0, topM: 6, opening: { widthM: 3, heightM: 5, sillM: 0.1 }, bayGroup: 1, storeyGroup: 1 }] }],
            featureRegions: [{ label: 'street clock on a post', types: ['SB_FEATURE_TYPE_FACADE_ELEMENT', 'sb_feature_type_facade_element_clock'], picture: 2, box: [120, 700, 180, 990], confidence: 80 }, { label: 'no box', picture: 2 }, { label: 'sign', picture: 3, box: [0, 0, 1, 1] }]
        }));
        expect(p.facadeBands[0].pierWidthM).toBe(0.6);
        expect(p.wallStoreys[0].bayWidthM).toBe(4.2);
        expect(p.wallStoreys[0].window?.widthM).toBe(2);
        expect(p.wallStoreys[0].facadeBands).toHaveLength(1);
        expect(p.featureRegions).toHaveLength(1);                             // no box, or a box under 2 per-mille, is dropped
        expect(p.featureRegions![0].types).toEqual(['SB_FEATURE_TYPE_FACADE_ELEMENT', 'SB_FEATURE_TYPE_FACADE_ELEMENT_CLOCK']);  // an unknown code is kept as a label
        expect(p.featureRegions![0].confidence).toBeCloseTo(0.8, 6);
        const t = facadeParametersPrompt('Somewhere', [{ role: 'top-down', caption: 'Top.' }, { role: 'wall', caption: 'A wall.' }], { shapes: true, wall: { picture: 2 } });
        expect(t).toContain('ONE wall: picture 2');
        expect(t).toContain('"featureRegions"');
        expect(t).not.toMatch(/"style":|"type":/);
    });

    it('builds an arcade as one arch per bay between piers over the band only, and keeps a wall\'s own families', async () => {
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!, east = faces.find(f => f.part === 'main' && f.normal[0] > 0.9)!;
        const params: BuildingParameters = { ...PARAMS, cornice: { thicknessM: 0, projectionM: 0 }, piers: { widthM: 0, projectionM: 0 }, facadeBands: [{ bottomM: 6.5, topM: 13.5, opening: { widthM: 8.4, heightM: 5, sillM: 0.3, recessM: 0.3, archRiseRatio: 1 }, bayGroup: 3, storeyGroup: 2, pierWidthM: 0.5 }], wallStoreys: [{ picture: 1, faceKey: east.key, groundStoreyM: 6, upperStoreysM: [3], bayWidthM: 4, window: { widthM: 2.4, heightM: 2.2, sillM: 0.6, recessM: 0.2 }, facadeBands: [] }] };
        const prog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params });
        const main = prog.openings.filter(o => o.face === south.key && !/_h\d+$/.test(o.id) && o.t0 > 7);
        // 7 bays at 3 m: two groups of 3 bays, each three arches (6 openings), each under (8.4 - 2 x 0.5) / 3 = 2.47 m wide
        expect(main).toHaveLength(6);
        for (const o of main) expect(o.s1 - o.s0).toBeLessThan(2.5);
        const plan = prog.walls.find(w => w.face === south.index)!;
        expect(plan.arcadePiers).toHaveLength(4);                              // two piers inside each group
        expect(plan.arcadePiers!.every(p => p.widthM === 0.5 && p.t0 > 7 && p.t1 < 13.5)).toBe(true);
        const pier = prog.faceSweeps.find(s => s.face === south.key)!;
        expect(pier.placements).toHaveLength(4);
        expect(pier.placements.every(([a0, a1]) => a1 - a0 < 6 && a0 > 6)).toBe(true);  // over the band, not the whole wall
        // the round-2 program (no pier width, legacy off) made one slot per group: the arcade piers are new
        const slot = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: { ...params, facadeBands: [{ ...params.facadeBands[0], bayGroup: 1 }] } });
        expect(slot.walls.find(w => w.face === south.index)!.arcadePiers).toBeUndefined();
        // the east wall uses its own bay width and window: 12 m at 4 m pitch -> 3 bays of 2.4 m windows, the building's are 7 at 1.4 m
        const eastUpper = prog.openings.filter(o => o.face === east.key && o.t0 > 6.5 && !/_h\d+$/.test(o.id) && o.t0 < 9);
        expect(eastUpper).toHaveLength(3);
        expect(eastUpper[0].s1 - eastUpper[0].s0).toBeCloseTo(2.4, 6);
        expect(prog.walls.find(w => w.face === east.index)!.readingFrom).toBe('picture 1');
        expect(prog.walls.find(w => w.face === south.index)!.readingFrom).toBe('building');
    });

    it('keeps a raised volume that does not fit its roof (shrunk across, or the smallest box, with the reason) and takes the audit\'s cluster footprint', async () => {
        const faces = await baseFaces();
        const W = 360, H = 160, height = new Float32Array(W * H).fill(NaN);
        for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const x = -10 + (c + 0.5) * 0.1, z = -14 + (r + 0.5) * 0.1; if (x > 0 && x < 24 && z < 0 && z > -12) height[r * W + c] = 16; }
        const td = { x0: -10, z0: -14, pixel: 0.1, width: W, rows: H, height };
        // a box across the whole block and past it (x -2..26), hugging the north edge (z -1..0.4): its centre is within 0.4 m
        // of the roof's edge, so no uniform shrink fits it (what round 2 dropped)
        const box: [number, number, number, number] = [Math.round((8 / 36) * 1000), Math.round((13 / 16) * 1000), 1000, Math.round((14.4 / 16) * 1000)];
        const params = { ...PARAMS, rooftopVolumes: [{ box, heightM: 2 }] };
        const now = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params, topdown: td });
        const was = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params, topdown: td, legacy: true });
        expect(was.volumeParts).toHaveLength(0);                               // round 2 dropped it
        expect(now.volumeParts).toHaveLength(1);
        expect(now.notes.some(n => /raised volume 0: .*(shrunk|kept)/.test(n))).toBe(true);
        const v = now.parts.find(p => p.id === now.volumeParts[0])!;
        const xs = v.loops[0].map(q => q[0]), zs = v.loops[0].map(q => q[1]);
        expect(Math.min(...xs)).toBeGreaterThan(0.3); expect(Math.max(...xs)).toBeLessThan(23.7);
        expect(Math.min(...zs)).toBeGreaterThan(-11.7); expect(Math.max(...zs)).toBeLessThanOrEqual(-0.4 + 1e-6);
        expect(v.heightSource).toBe('scan');                                   // the scan's height there (16 m)
        const wide: [number, number, number, number] = [Math.round((5 / 36) * 1000), Math.round((6 / 16) * 1000), Math.round((39 / 36) * 1000), Math.round((10 / 16) * 1000)];
        // the audit found a real object on the roof under the read box: the volume takes its footprint, labelled measured
        const withCluster = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: { ...PARAMS, rooftopVolumes: [{ box: wide, heightM: 2 }] }, topdown: td, roofClusters: [{ lo: [8, 14, -9], hi: [12, 17, -6] }] });
        const vc = withCluster.parts.find(p => p.id === withCluster.volumeParts[0])!;
        expect(Math.min(...vc.loops[0].map(q => q[0]))).toBeCloseTo(8, 6);
        expect(Math.max(...vc.loops[0].map(q => q[1]))).toBeCloseTo(-6, 6);
        expect(vc.provenance).toBe('measured');
        expect(withCluster.notes.some(n => /residual cluster/.test(n))).toBe(true);
    });
});

describe('version F round 3: local gates, best of n, the image-call governor', () => {
    /** A synthetic wall texture: light wall, dark openings where `off` is an opening, with an optional dark "clock" blob. */
    const paint = (W: number, H: number, off: Float32Array, extras: Array<{ x0: number; y0: number; x1: number; y1: number; rgb: [number, number, number] }> = [], wallRgb: [number, number, number] = [185, 170, 150]) => {
        const rgba = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) { const open = Number.isFinite(off[i]) && off[i] < -0.05; const n = 6 * Math.sin(i * 12.9898); rgba.set(open ? [40 + n, 45 + n, 50 + n, 255] : [wallRgb[0] + n, wallRgb[1] + n, wallRgb[2] + n, 255], i * 4); }
        for (const e of extras) for (let y = e.y0; y < e.y1; y++) for (let x = e.x0; x < e.x1; x++) rgba.set([...e.rgb, 255], (y * W + x) * 4);
        return rgba;
    };

    it('reads a plate\'s storeys and bays against F\'s lattice: the same lattice passes, a plate with an extra storey or missing bays fails', async () => {
        const { latticeIdentity, profileCount } = await import('../src/node/3d-engine/staged-location/version-f/local-gate');
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!;
        const W = south.width, H = south.height;
        const prog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: TRUTH });
        const planned = programWallOffset(south, prog.openings, [], []);
        const use = new Uint8Array(W * H).fill(1);
        const same = latticeIdentity(paint(W, H, planned), south, use, planned, 0.5);
        expect(same.passed).toBe(true);
        expect(same.latticeNcc).toBeGreaterThan(0.8);
        expect(same.storeys.planned).toBe(4); expect(same.storeys.shown).toBe(4); expect(same.storeys.extra).toBe(0);
        expect(same.bays.planned).toBe(7); expect(same.bays.shown).toBe(7);
        // a plate that paints the openings over (no lattice at all) fails on the NCC
        const blank = latticeIdentity(paint(W, H, new Float32Array(W * H).fill(0)), south, use, planned, 0.5);
        expect(blank.passed).toBe(false);
        expect(blank.storeys.shown).toBe(0);
        // a plate with storeys at a different rhythm (5 where F plans 4): an extra dark row between planned storeys
        const other = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: { ...TRUTH, groundStoreyM: 3.2, upperStoreysM: [2.5] } });
        const extra = latticeIdentity(paint(W, H, programWallOffset(south, other.openings, [], [])), south, use, planned, 0.5);
        expect(extra.storeys.extra + (extra.storeys.planned - extra.storeys.shown)).toBeGreaterThan(0);
        expect(extra.passed).toBe(false);
        // a plate with half the bays painted over fails the bay count, not the storey count
        const halfOff = planned.slice();
        for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) if (halfOff[y * W + x] < -0.05) halfOff[y * W + x] = 0;
        const half = latticeIdentity(paint(W, H, halfOff), south, use, planned, 0.5);
        expect(half.bays.shown).toBeLessThan(half.bays.planned - 1);
        expect(half.passed).toBe(false);
        // the profile reader on its own
        const open = new Float32Array(40), dark = new Float32Array(40);
        for (let i = 0; i < 40; i++) { open[i] = (i >= 5 && i < 10) || (i >= 20 && i < 25) ? 1 : 0; dark[i] = open[i] ? 20 : 2; }
        expect(profileCount(open, dark)).toEqual({ planned: 2, shown: 2, extra: 0, passed: true });
        for (let i = 13; i < 17; i++) dark[i] = 19;   // a dark run in the gap: an extra band
        expect(profileCount(open, dark).extra).toBe(1);
    });

    it('rejects a plate that turns a must-keep feature into something else and keeps one that redraws it; Street View may vouch', async () => {
        const { featureGuard, featureRegionsOnWall } = await import('../src/node/3d-engine/staged-location/version-f/local-gate');
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!;
        const W = south.width, H = south.height;
        const prog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: TRUTH });
        const planned = programWallOffset(south, prog.openings, [], []);
        const use = new Uint8Array(W * H).fill(1);
        // the tile shows a dark round-ish "clock" on a post in the first bay at street level (a 1.2 m disc over a 0.3 m post)
        // (in the wall's 1 m edge margin, beside the first opening, not over it)
        const clock = [{ x0: 3, y0: H - 30, x1: 15, y1: H - 18, rgb: [30, 30, 35] as [number, number, number] }, { x0: 8, y0: H - 18, x1: 11, y1: H - 2, rgb: [60, 60, 60] as [number, number, number] }];
        const tile = paint(W, H, planned, clock);
        const regions = featureRegionsOnWall([{ picture: 2, faceKey: south.key, label: 'street clock on a post', types: ['SB_FEATURE_TYPE_FACADE_ELEMENT', 'SB_FEATURE_TYPE_FACADE_ELEMENT_CLOCK'], box: [Math.round(((3 + 56 - 2) / (W + 56)) * 1000), Math.round(((H - 32) / H) * 1000), Math.round(((15 + 56 + 2) / (W + 56)) * 1000), 1000], confidence: 0.8 }], south);
        expect(regions).toHaveLength(1);
        expect(regions[0].x0).toBeLessThanOrEqual(3); expect(regions[0].x1).toBeGreaterThanOrEqual(15);
        // a plate that keeps the clock (the same wall, a little lighter)
        const kept = featureGuard(tile, paint(W, H, planned, clock, [195, 180, 160]), W, H, use, south.pixel, regions);
        expect(kept.kept).toBe(true);
        expect(kept.regions[0].ncc).toBeGreaterThan(0.5);
        // a plate that paints a lamp post there instead: a thin bright post with a small head, the disc gone
        const lamp = [{ x0: 8, y0: H - 30, x1: 11, y1: H - 2, rgb: [150, 150, 140] as [number, number, number] }, { x0: 6, y0: H - 33, x1: 13, y1: H - 29, rgb: [240, 230, 180] as [number, number, number] }];
        const lost = featureGuard(tile, paint(W, H, planned, lamp), W, H, use, south.pixel, regions);
        expect(lost.kept).toBe(false);
        expect(lost.why).toMatch(/street clock/);
        expect(lost.regions[0].kept).toBe(false);
        // a plate that paints plain wall over it: erased
        const erased = featureGuard(tile, paint(W, H, planned), W, H, use, south.pixel, regions);
        expect(erased.kept).toBe(false);
        // Street View that shows the lamp post (the tile was wrong there) vouches for the lamp plate
        const valid = new Uint8Array(W * H);
        for (let y = H - 40; y < H; y++) for (let x = 0; x < W; x++) valid[y * W + x] = 1;
        const vouched = featureGuard(tile, paint(W, H, planned, lamp), W, H, use, south.pixel, regions, { rgba: paint(W, H, planned, lamp), valid });
        expect(vouched.kept).toBe(true);
        expect(vouched.regions[0].nccPhoto).toBeGreaterThan(0.5);
        // no region on another wall
        expect(featureRegionsOnWall([{ picture: 2, faceKey: 'elsewhere', label: 'x', types: [], box: [0, 0, 500, 500], confidence: 1 }], south)).toHaveLength(0);
    });

    it('picks the best eligible candidate by the local numbers, never an ineligible one', async () => {
        const { pickCandidate, candidateRank } = await import('../src/node/3d-engine/staged-location/version-f/local-gate');
        const r = pickCandidate([
            { sample: 0, eligible: true, why: 'eligible', latticeNcc: 0.3, flaggedShare: 0.1, chamferPx: 4 },
            { sample: 1, eligible: false, why: 'not the same wall', latticeNcc: 0.9 },
            { sample: 2, eligible: true, why: 'eligible', latticeNcc: 0.35, photoSupport: 0.4, flaggedShare: 0.05, chamferPx: 3 }
        ]);
        expect(r.chosen?.sample).toBe(2);
        expect(r.ranked.map(x => x.sample)).toEqual([2, 0, 1]);
        expect(r.ranked[2].rank).toBe(-Infinity);
        expect(candidateRank({ sample: 0, eligible: true, why: '', latticeNcc: 0.5 })).toBeCloseTo(0.5, 6);
        expect(pickCandidate([{ sample: 0, eligible: false, why: 'x' }]).chosen).toBeUndefined();
    });

    it('paces the image calls: a slot limit, a shared doubling pause after a 429, retries, and a plain error passes through', async () => {
        const { ImageCallGovernor } = await import('../src/node/3d-engine/staged-location/version-f/f3-redraw');
        let clock = 0;
        const slept: number[] = [];
        const g = new ImageCallGovernor({ maxInFlight: 2, pauseMs: 1000, maxPauseMs: 4000, retries: 3, sleep: async ms => { slept.push(ms); clock += ms; }, now: () => clock });
        // the slot limit: 5 calls, at most 2 in flight
        let inFlight = 0, peak = 0;
        const call = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return 'ok'; };
        await Promise.all([1, 2, 3, 4, 5].map(() => g.run(call)));
        expect(peak).toBe(2);
        expect(g.counts.peakInFlight).toBe(2);
        // a 429 twice, then an answer: the pause doubles (1 s, 2 s) and the call is retried
        let n = 0;
        const limited = async () => { n++; if (n <= 2) throw Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 }); return 'answered'; };
        expect(await g.run(limited)).toBe('answered');
        expect(g.counts.rateLimited).toBe(2);
        expect(slept.filter(ms => ms >= 1000)).toEqual([1000, 2000]);
        // a transient 503 is retried after 1 s; a plain error is not retried
        let m = 0;
        expect(await g.run(async () => { m++; if (m === 1) throw Object.assign(new Error('503 deadline expired'), { status: 503 }); return 'late'; })).toBe('late');
        expect(g.counts.transient).toBe(1);
        await expect(g.run(async () => { throw new Error('safety filter blocked prompt'); })).rejects.toThrow(/safety/);
        // more 429s than retries: the error comes back
        await expect(g.run(async () => { throw Object.assign(new Error('quota'), { mediaError: { code: 'quota' } }); })).rejects.toThrow(/quota/);
    });
});

describe('version F round 3: scheduling', () => {
    it('plans and shows the shape before the Street View survey is in, then waits for it before the redraw; the agreement is recorded with no second build', async () => {
        const { runVersionF3 } = await import('../src/node/3d-engine/staged-location/version-f/f3');
        const { writeMassingLayer, plainTextures } = await import('../src/node/3d-engine/staged-location/pipeline-e/pipeline-e');
        const dir = tmp();
        const run0 = await runMassing(massingSpecText(MASSING, { outDir: path.join(dir, 'native0'), params: { ...VERSION_F_NATIVE_PARAMS, topdown: 0 } }), path.join(dir, 'native0'));
        const { textures, legend } = plainTextures(run0);
        const files = writeMassingLayer(run0, MASSING, textures, legend, dir, 'remesh', 'test');
        const events: string[] = [];
        let surveyResolved = false;
        // the fake survey answers only after the shape layer was shown: a plan that waited for the survey would deadlock here
        let shapeShown!: () => void;
        const shown = new Promise<void>(r => { shapeShown = r; });
        const streetViews = () => shown.then(() => new Promise<never[]>(r => setTimeout(() => { surveyResolved = true; events.push('survey resolved'); r([]); }, 50)));
        const layers: string[] = [];
        const out = await runVersionF3({
            place: 'Synthetic', genai: {}, massing: MASSING as never, run: run0, textures, tilePath: files.clayGlb, isolateGlb: files.clayGlb, dir: path.join(dir, 'f3'), stage: 'grammar', stageKey: 'test',
            enhance: { client: async () => { throw new Error('no model in tests'); }, models: ['none'], locationName: 'Synthetic', guards: true, streetViews },
            reading: TRUTH,
            onLayer: (f, phase) => { layers.push(phase); events.push(`layer ${phase} (survey ${surveyResolved ? 'in' : 'not in'})`); expect(fs.existsSync(f.clayGlb)).toBe(true); if (phase === 'shape') shapeShown(); },
            onProgress: m => { if (/shape planned|survey in|redrawing/.test(m)) events.push(m.replace(/\(.*$/, '').trim()); }
        } as never);
        expect(layers).toEqual(['shape', 'final']);
        // the shape was handed over before the survey resolved, and the survey was awaited before the redraw
        expect(events.indexOf('layer shape (survey not in)')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('layer shape (survey not in)')).toBeLessThan(events.indexOf('survey resolved'));
        const s = out.schedule.map(e => e.event);
        expect(s.findIndex(e => e.startsWith('Street View survey started'))).toBe(0);
        expect(s.findIndex(e => e.startsWith('shape planned'))).toBeLessThan(s.findIndex(e => e.startsWith('Street View survey in')));
        expect(s.findIndex(e => e.startsWith('Street View survey in'))).toBeLessThan(s.findIndex(e => e.startsWith('redrawing')));
        expect(out.versionF.adjustNative.evaluations).toBeGreaterThan(0);   // no wall ortho without a tile: no evidence, the search still ran
        expect(out.agreement).toEqual([]);                                       // no plate: nothing to agree on, and no second build
        expect(out.steps.find(x => x.step === 'plate-agreement')!.notes.some(n => /no second build/.test(n))).toBe(true);
        expect(out.run.nodes.filter(n => n.kind === 'residual')).toHaveLength(0);
        expect(fs.existsSync(path.join(dir, 'f3', 'version_f3.json'))).toBe(true);
    }, 120_000);
});
