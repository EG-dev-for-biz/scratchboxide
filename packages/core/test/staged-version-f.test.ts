/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment) on synthetic inputs, no network and no model: the parameter reader's parsing, the facade program
 * built by the native solid builder (vertex counts, no scan triangles, provenance labels, party walls left blank, hidden
 * walls labelled generated), the program's offset map against the rendered model, and the adjustment recovering a known
 * lattice from a synthetic wall photo. Screenshot: test-results/screenshots/version_f/synthetic_generator.png.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing, type MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { DEFAULT_PARAMETERS, parseFacadeParameters, storeyLines, facadeParametersPrompt, type BuildingParameters } from '../src/node/3d-engine/staged-location/version-f/facade-parameters';
import { facadeProgram, chains, wallLoops, archHalfWidth, openingRects, LABEL, type ProgramInput } from '../src/node/3d-engine/staged-location/version-f/facade-program';
import { comparisonCameras, compareSilhouette, nodesToSoup, programWallOffset, renderedWallOffset, soupBounds, wallEvidence, type WallTile } from '../src/node/3d-engine/staged-location/version-f/render-compare';
import { adjustParameters } from '../src/node/3d-engine/staged-location/version-f/adjust';
import { versionFProvenance, VERSION_F_NATIVE_PARAMS } from '../src/node/3d-engine/staged-location/version-f/version-f';
import { composeGrid } from '../src/node/3d-engine/staged-location/photo-match-eval';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_f');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'version-f-'));

const REPLY = `Here are the measurements:
{"groundStoreyM": 4.5, "upperStoreysM": [3.4, "3.2"], "bayWidthM": 3.0, "edgeMarginM": 1.0,
 "window": {"widthM": 1.4, "heightM": 9, "sillM": 0.9, "recessM": 0.25},
 "groundOpening": {"widthM": 2.4, "heightM": 3.6, "sillM": 0.2},
 "plinth": {"heightM": 0.6, "projectionM": 0.1},
 "bands": [{"heightM": 4.5, "thicknessM": 0.35, "projectionM": 0.2}, {"heightM": 8, "projectionM": 0}],
 "cornice": {"thicknessM": 0.8, "projectionM": 0.6}, "parapet": {"heightM": 1.0},
 "piers": {"widthM": 0.5, "projectionM": 0.12},
 "roof": {"pitchDeg": 0, "ridgeAzimuthDeg": 200, "hipped": "true"},
 "rooftopVolumes": [{"box": [400, 400, 600, 600], "heightM": 3}, {"box": [1, 2], "heightM": 3}],
 "materials": {"wall": {"linearRgb": [180, 90, 70], "roughness": 0.8}, "glazing": {"linearRgb": [0.03, 0.04, 0.05], "roughness": 0.1}},
 "features": ["cast-iron columns between the bays", 7, "a fire escape on the side street"], "confidence": 72}
That is all.`;

describe('version F parameter reading', () => {
    it('parses the reply into clamped continuous parameters, defaults the missing ones and records the free text', () => {
        const { params: p, defaulted } = parseFacadeParameters(REPLY);
        expect(p.groundStoreyM).toBe(4.5);
        expect(p.upperStoreysM).toEqual([3.4, 3.2]);
        // a window can never be taller than the lowest upper storey (9 m read)
        expect(p.window.heightM).toBeCloseTo(3.0, 6);
        expect(p.groundOpening.recessM).toBe(DEFAULT_PARAMETERS.groundOpening.recessM);
        expect(p.bands).toHaveLength(1);                    // a band with no projection is dropped
        expect(p.roof.ridgeAzimuthDeg).toBe(20);            // a direction, folded into 0..180
        expect(p.roof.hipped).toBe(true);
        expect(p.rooftopVolumes).toHaveLength(1);          // a malformed box is dropped
        expect(p.materials.wall.linearRgb[0]).toBeGreaterThan(0.4);  // 0..255 read as sRGB and linearised
        expect(p.materials.wall.linearRgb[0]).toBeLessThan(0.5);
        expect(p.materials.trim).toEqual(DEFAULT_PARAMETERS.materials.trim);
        expect(p.features).toEqual(['cast-iron columns between the bays', 'a fire escape on the side street']);
        expect(p.confidence).toBeCloseTo(0.72, 6);
        expect(defaulted).toEqual([]);
        expect(() => parseFacadeParameters('no json here')).toThrow(/no JSON/);
        const sparse = parseFacadeParameters('{"bayWidthM": 99}');
        expect(sparse.params.bayWidthM).toBe(12);
        expect(sparse.defaulted).toEqual(expect.arrayContaining(['groundStoreyM', 'upperStoreysM', 'window', 'materials']));
    });

    it('lays storey lines from the ground storey and the repeating upper storeys', () => {
        const lines = storeyLines({ groundStoreyM: 4.5, upperStoreysM: [3.4, 3.2] }, 15);
        [0, 4.5, 7.9, 11.1, 14.3].forEach((v, i) => expect(lines[i]).toBeCloseTo(v, 6));
        expect(lines).toHaveLength(5);
        expect(storeyLines({ groundStoreyM: 4, upperStoreysM: [3] }, 13.4)).toEqual([0, 4, 7, 10]);
    });

    it('names each picture in the prompt and asks for dimensions, not categories', () => {
        const t = facadeParametersPrompt('Somewhere', [{ role: 'wall', caption: 'A wall, 20 m wide.' }, { role: 'oblique', caption: 'An oblique.' }]);
        expect(t).toContain('1. A wall, 20 m wide.');
        expect(t).toContain('2. An oblique.');
        expect(t).toContain('"bayWidthM"');
        expect(t).not.toMatch(/style":|"type":/);
    });
});

/** A 24 x 12 m box, 14 m tall, standing on y = 0, with a lower 8 x 12 m wing against its west side. */
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
    // no tile: give the walls ortho frames at 0.1 m and say which the tile "sees" (the south front and the east side)
    return r.report.faces.map(f => {
        if (f.kind !== 'wall') return f;
        const pixel = 0.1, w = Math.ceil((f.sMax - f.sMin) / pixel), h = Math.ceil((f.tMax - f.tBottom) / pixel);
        const seen = f.normal[2] > 0.9 || f.normal[0] > 0.9;
        return { ...f, pixel, width: w, height: h, orthoSMin: f.sMin, orthoTMax: f.tMax, coverage: seen ? 0.9 : 0.05 };
    });
}

describe('version F generator (native solid builder, residual off)', () => {
    it('builds the program on every wall: openings, bands, cornice, parapet, plinth and piers; no scan triangles; labelled', async () => {
        const faces = await baseFaces();
        // a neighbour 9 m tall stands against the north wall of the main block
        const inp: ProgramInput = { faces, parts: MASSING.parts, groundY: 0, params: PARAMS, neighbourTop: f => (f.normal[2] < -0.9 && f.part === 'main' ? 9 : -Infinity) };
        const prog = facadeProgram(inp);
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!;
        const north = faces.find(f => f.part === 'main' && f.normal[2] < -0.9)!;
        const west = faces.find(f => f.part === 'wing' && f.normal[0] < -0.9)!;
        const plan = (f: MassingFace) => prog.walls.find(w => w.face === f.index)!;
        // south: 24 m at a 3 m pitch with 1 m margins -> 7 bays; storeys at 0, 4, 7, 10 (13 has no room under the cornice)
        expect(plan(south).bays).toBe(7);
        expect(prog.openings.filter(o => o.face === south.key)).toHaveLength(7 * 4);
        expect(prog.openings.filter(o => o.face === south.key).every(o => o.provenance === LABEL.inferred)).toBe(true);
        // north: only the storeys above the 9 m neighbour
        const nOpen = prog.openings.filter(o => o.face === north.key);
        expect(nOpen.length).toBe(7);
        expect(Math.min(...nOpen.map(o => o.t0))).toBeGreaterThan(9);
        expect(nOpen.every(o => o.provenance === LABEL.generated)).toBe(true);  // the tile hardly sees it
        expect(prog.openings.filter(o => o.face === west.key).every(o => o.provenance === LABEL.generated)).toBe(true);
        // sweeps run round the loops: the band at 4 m round the main block's walls that reach it, the wing's cornice at 6 m
        expect(prog.sweeps.some(s => s.id.startsWith('band0') && s.faces.includes(south.key))).toBe(true);
        expect(prog.sweeps.some(s => s.id.startsWith('cornice') && s.profile.some(q => Math.abs(q[1] - 14) < 1e-6))).toBe(true);
        expect(prog.sweeps.some(s => s.id.startsWith('parapet'))).toBe(true);
        expect(prog.faceSweeps.length).toBeGreaterThan(0);

        const dir = tmp();
        const run = await runMassing(massingSpecText({ parts: prog.parts, meshes: [] }, { outDir: dir, params: { ...VERSION_F_NATIVE_PARAMS, bake: 0, topdown: 0 }, openings: prog.openings, sweeps: prog.sweeps, faceSweeps: prog.faceSweeps, provenance: LABEL.vector }), dir);
        expect(run.report.rejectedOpenings).toEqual([]);
        expect(run.nodes.filter(n => n.kind === 'residual')).toHaveLength(0);
        expect(run.report.residual.isolateTriangles).toBe(0);
        const verts = run.nodes.reduce((a, n) => a + n.positions.length / 3, 0), tris = run.nodes.reduce((a, n) => a + n.indices.length / 3, 0);
        expect(verts).toBeGreaterThan(5000);
        expect(tris).toBeGreaterThan(1500);
        expect(run.nodes.filter(n => n.kind === 'opening')).toHaveLength(prog.openings.length);
        const ctx = { pitchedParts: new Set<string>(), volumeParts: new Set<string>(), partHeightSource: new Map(prog.parts.map(p => [p.id, String(p.heightSource)])), iou: 0.9 };
        const labels = new Map<string, number>();
        for (const n of run.nodes) { const l = versionFProvenance(n, ctx).label; labels.set(l, (labels.get(l) ?? 0) + 1); }
        expect([...labels.keys()].sort()).toEqual(['generated', 'measured', 'photo-inferred', 'vector-modelled']);
        expect(labels.has('as-scanned')).toBe(false);
        // the wing's walls (height from the scan) are `measured`, the main block's `vector-modelled`
        expect(versionFProvenance(run.nodes.find(n => n.name.startsWith('w:wing'))!, ctx).label).toBe('measured');
        expect(versionFProvenance(run.nodes.find(n => n.name.startsWith('w:main'))!, ctx).label).toBe('vector-modelled');
        for (const n of run.nodes) { const r = versionFProvenance(n, ctx); if (!r.measuredGeometry) expect(r.confidence).toBeGreaterThan(0); }

        // the program's offset map agrees with the rendered model on the south wall (openings and band)
        const soup = nodesToSoup(run.nodes);
        const rendered = renderedWallOffset(soup, south), drawn = programWallOffset(south, prog.openings, prog.sweeps, prog.faceSweeps);
        let agree = 0, both = 0;
        for (let i = 0; i < rendered.length; i++) if (Number.isFinite(rendered[i]) && Number.isFinite(drawn[i])) { both++; if ((rendered[i] < -0.05) === (drawn[i] < -0.05)) agree++; }
        expect(both).toBeGreaterThan(0.9 * south.width * south.height);
        expect(agree / both).toBeGreaterThan(0.97);
        // the silhouette of a model against itself is exact
        const cam = comparisonCameras(soupBounds(soup))[0];
        expect(compareSilhouette('self', soup, soup, cam.cam).iou).toBe(1);

        // screenshot: the south wall's offset map (openings dark, band and piers light) and a top-down oblique depth
        fs.mkdirSync(SHOTS, { recursive: true });
        const toImg = (d: Float32Array, w: number, h: number) => { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { const v = Number.isFinite(d[i]) ? Math.max(0, Math.min(255, 140 + 250 * d[i])) : 30; rgba.set([v, v, v, 255], i * 4); } return { width: w, height: h, rgba }; };
        const obl = comparisonCameras(soupBounds(soup))[1].cam;
        const { rasterOrtho } = await import('../src/node/3d-engine/staged-location/version-f/render-compare');
        const od = rasterOrtho(soup, obl);
        let lo = Infinity, hi = -Infinity;
        for (const v of od) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const oimg = { width: obl.width, height: obl.height, rgba: new Uint8Array(obl.width * obl.height * 4) };
        for (let i = 0; i < od.length; i++) { const v = Number.isFinite(od[i]) ? Math.round(230 - 180 * (od[i] - lo) / (hi - lo || 1)) : 20; oimg.rgba.set([v, v, v, 255], i * 4); }
        fs.writeFileSync(path.join(SHOTS, 'synthetic_generator.png'), composeGrid([{ image: toImg(rendered, south.width, south.height), label: `south wall rendered: ${verts} vertices` }, { image: oimg, label: 'oblique depth' }], { tileWidth: 480 }));
    }, 60_000);

    it('chains consecutive walls and joins the run that wraps round the loop start', async () => {
        const faces = await baseFaces();
        const loop = wallLoops(faces).find(l => l[0].part === 'main')!;
        expect(chains(loop, () => true)).toHaveLength(1);
        const runs = chains(loop, f => f !== loop[1]);
        expect(runs).toHaveLength(1);                  // loop[2..] then loop[0], joined across the start
        expect(runs[0][runs[0].length - 1]).toBe(loop[0]);
    });

    it('adjusts a misread lattice back towards the one a synthetic wall photo shows', async () => {
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!;
        const W = south.width, H = south.height;
        // the "photo": light wall, dark windows on the true lattice (ground storey 4.4 m, upper 3.0 m, 3.0 m pitch)
        const truth: BuildingParameters = { ...PARAMS, groundStoreyM: 4.4, upperStoreysM: [3.0], bayWidthM: 3.0, cornice: { thicknessM: 0, projectionM: 0 }, bands: [], piers: { widthM: 0, projectionM: 0 }, plinth: { heightM: 0, projectionM: 0 }, parapet: { heightM: 0 } };
        const tprog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params: truth });
        const off = programWallOffset(south, tprog.openings, [], []);
        const luma = new Float32Array(W * H), depth = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) { luma[i] = Number.isFinite(off[i]) ? (off[i] < -0.05 ? 50 : 190) + 10 * Math.sin(i * 12.9898) : NaN; depth[i] = Number.isFinite(off[i]) ? off[i] : NaN; }
        const tile: WallTile = { face: south, luma, depth };
        const ev = wallEvidence(tile);
        const start: BuildingParameters = { ...truth, groundStoreyM: 3.9, upperStoreysM: [3.25], bayWidthM: 3.15 };
        const inside = new Map([[south.index, Uint8Array.from(off, v => (Number.isFinite(v) ? 1 : 0))]]);
        const res = adjustParameters({ faces, parts: MASSING.parts, groundY: 0, params: start }, [ev], inside, 3);
        const first = res.rounds[0], last = res.rounds[res.rounds.length - 1];
        expect(last.objective).toBeLessThan(first.objective - 0.1);
        expect(last.windowNcc).toBeGreaterThan(0.8);
        expect(Math.abs(res.params.groundStoreyM - 4.4)).toBeLessThan(0.25);
        expect(Math.abs(res.params.upperStoreysM[0] - 3.0)).toBeLessThan(0.1);
    }, 60_000);
});

describe('version F round 2: shape vocabulary (continuous)', () => {
    it('parses arch heads, bands of openings and per-wall storeys; round 1 replies keep their defaults', () => {
        const { params: p } = parseFacadeParameters(JSON.stringify({
            groundStoreyM: 5, upperStoreysM: [4], window: { widthM: 1.2, heightM: 3, sillM: 0.5, archRiseRatio: 1, apexSharpness: 3 },
            facadeBands: [{ bottomM: 9, topM: 17, opening: { widthM: 3, heightM: 6.5, sillM: 0.4, archRiseRatio: 0.5 }, bayGroup: 2.4, storeyGroup: 2 }, { bottomM: 3, topM: 3.5 }],
            wallStoreys: [{ picture: 2, groundStoreyM: 7, upperStoreysM: [3.8] }, { picture: 3 }]
        }));
        expect(p.window.archRiseRatio).toBe(1);
        expect(p.window.apexSharpness).toBe(1);                 // clamped to the equilateral pointed arch
        expect(p.facadeBands).toHaveLength(1);                  // a band under 1 m is dropped
        expect(p.facadeBands[0].bayGroup).toBeCloseTo(2.4, 6);  // a count read as a number
        expect(p.wallStoreys).toEqual([{ picture: 2, groundStoreyM: 7, upperStoreysM: [3.8] }]);
        const old = parseFacadeParameters('{"groundStoreyM": 4}').params;
        expect(old.window.archRiseRatio).toBe(0);
        expect(old.facadeBands).toEqual([]);
    });

    it('draws arch heads as stepped slices whose widths follow a round or pointed curve, a flat head as one rectangle', () => {
        expect(archHalfWidth(0, 0)).toBeCloseTo(1, 6);
        expect(archHalfWidth(1, 0)).toBeCloseTo(0, 6);
        expect(archHalfWidth(0.5, 0)).toBeCloseTo(Math.sqrt(0.75), 6);          // a semicircle
        expect(archHalfWidth(0.5, 1)).toBeLessThan(archHalfWidth(0.5, 0));      // pointed: narrower at mid-rise
        expect(openingRects({ archRiseRatio: 0 }, 0, 2, 0, 3)).toEqual([[0, 2, 0, 3]]);
        const r = openingRects({ archRiseRatio: 1, apexSharpness: 0 }, 0, 2, 0, 3);
        expect(r[0]).toEqual([0, 2, 0, 2]);                                      // body to the springing (rise = half-width 1 m)
        expect(r.length).toBeGreaterThan(4);
        for (let k = 2; k < r.length; k++) expect(r[k][1] - r[k][0]).toBeLessThanOrEqual(r[k - 1][1] - r[k - 1][0] + 1e-9);
        expect(r[r.length - 1][3]).toBeCloseTo(3, 6);
        const pointed = openingRects({ archRiseRatio: 1.5, apexSharpness: 1 }, 0, 2, 0, 4);
        expect(pointed[pointed.length - 1][1] - pointed[pointed.length - 1][0]).toBeLessThan(r[r.length - 1][1] - r[r.length - 1][0] + 0.2);
    });

    it('groups bays and storeys inside a band into arcade openings, and moves one wall\'s storeys on its own', async () => {
        const faces = await baseFaces();
        const south = faces.find(f => f.part === 'main' && f.normal[2] > 0.9)!, east = faces.find(f => f.part === 'main' && f.normal[0] > 0.9)!;
        const params: BuildingParameters = { ...PARAMS, cornice: { thicknessM: 0, projectionM: 0 }, facadeBands: [{ bottomM: 6.5, topM: 13.5, opening: { widthM: 4.2, heightM: 5, sillM: 0.3, recessM: 0.3, archRiseRatio: 1 }, bayGroup: 2, storeyGroup: 2 }], wallStoreys: [{ picture: 1, faceKey: east.key, groundStoreyM: 6, upperStoreysM: [3] }] };
        const prog = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params });
        const main = prog.openings.filter(o => o.face === south.key && !/_h\d+$/.test(o.id));
        // storeys 0 and 4 one per bay (7 + 7); the band from 7 m: a group of two bays (3 pairs) per two storeys (7 and 13 -> only
        // 7 fits); round 3 builds each group as one arch per bay between piers (6 arches under 1.9 m), where round 2 made one
        // 4.2 m slot per group (staged-version-f3.test.ts covers the piers)
        expect(main.filter(o => o.t0 > 7).length).toBe(6);
        expect(main.filter(o => o.t0 > 7).every(o => o.s1 - o.s0 < 2 && o.s1 - o.s0 > 1.5)).toBe(true);
        expect(prog.openings.some(o => o.face === south.key && /_h\d+$/.test(o.id))).toBe(true);
        // the east wall's ground storey is 6 m: its first upper openings start above 6 m, the building's at 4 m
        const eastUpper = prog.openings.filter(o => o.face === east.key && o.t0 > 1).map(o => o.t0);
        expect(Math.min(...eastUpper)).toBeGreaterThan(6);
        expect(Math.min(...main.filter(o => o.t0 > 1).map(o => o.t0))).toBeLessThan(5);
        // round 1's program ignores all of it
        const legacy = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params, legacy: true });
        expect(legacy.openings.some(o => /_h\d+$/.test(o.id))).toBe(false);
    });

    it('keeps a raised volume that straddles two parts on the part under most of it, inside that roof', async () => {
        const faces = await baseFaces();
        // top-down map 0.1 m from (-10, -14), 36 x 16 m; heights 16 m on the main block, NaN elsewhere
        const W = 360, H = 160, height = new Float32Array(W * H).fill(NaN);
        for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const x = -10 + (c + 0.5) * 0.1, z = -14 + (r + 0.5) * 0.1; if (x > 0 && x < 24 && z < 0 && z > -12) height[r * W + c] = 16; }
        const td = { x0: -10, z0: -14, pixel: 0.1, width: W, rows: H, height };
        // a box from x = -3 to 9 (a quarter over the low wing), z = -10 to -2
        const box: [number, number, number, number] = [Math.round((7 / 36) * 1000), Math.round((4 / 16) * 1000), Math.round((19 / 36) * 1000), Math.round((12 / 16) * 1000)];
        const params = { ...PARAMS, rooftopVolumes: [{ box, heightM: 2 }] };
        const now = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params, topdown: td });
        const was = facadeProgram({ faces, parts: MASSING.parts, groundY: 0, params, topdown: td, legacy: true });
        expect(now.volumeParts).toHaveLength(1);
        const v = now.parts.find(p => p.id === now.volumeParts[0])!;
        expect(Math.min(...v.loops[0].map(q => q[0]))).toBeGreaterThan(0.3);   // inside the main block
        expect(v.topY).toBeCloseTo(16, 6);                                      // the scan's height there
        expect(was.volumeParts.length).toBeLessThanOrEqual(now.volumeParts.length);
    });
});
