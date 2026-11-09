/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMeasuredTwin, GENERATED_REVEAL_M, measuredTwinSpec, rebasePath, type KRunRecords } from '../src/node/3d-engine/staged-location/measured-twin/measured-twin';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { fileReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { enuOffset } from '../src/node/3d-engine/staged-location/measured-twin/infer';

const frame = (id: number, w: number, h: number) => ({ facadeId: id, centroid: [0, 50, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], axisS: [1, 0, 0] as [number, number, number], axisT: [0, 1, 0] as [number, number, number], orthoSMin: -10, orthoTMax: 50, pixel: 0.1, width: w, height: h });

function records(): KRunRecords {
    return {
        runDir: '/runs/x', orthosDir: '/o', isolate: '/o/clay.glb', textured: '/o/textured.glb', groundY: 0.25,
        loops: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
        planes: [frame(1, 200, 1000), frame(2, 50, 50)],
        windowFit: [
            { facadeId: 1, width: 200, height: 1000, rects: [[10, 10, 20, 30], [30, 10, 40, 30]], panes: [[10, 10, 20, 30]], generated: [[30, 10, 40, 30]] },
            { facadeId: 2, width: 60, height: 50, rects: [[1, 1, 5, 5]] },
            { facadeId: 3, rects: [[1, 1, 5, 5]] }
        ],
        classes: [{ index: 0, meanLab: [70, 3, 6], set: 'Tiles039', finish: { roughness: 0.6, metallic: 0, drawn: { roughness: 0.55, metallic: 0 } } }, { index: 1, meanLab: [40, 1, 1], openings: true }],
        photos: { 1: { image: '/o/facade_1.png', mask: '/o/facade_1_uncovered.png' }, 9: { image: '/o/none.png' } },
        reveal: { depthM: GENERATED_REVEAL_M, label: 'generated', source: 'no reading' }
    };
}

describe('measuredTwinSpec', () => {
    const spec = measuredTwinSpec(records(), { glb: '/out/t.glb', report: '/out/r.json' }, [{ normal: '/m/n.png', orm: '/m/o.png', tileM: 1.8 }, undefined]);
    const lines = spec.trim().split('\n');
    it('carries every kept window box, flagging the ones the window fit generated', () => {
        expect(lines.filter(l => l.startsWith('win 1 '))).toEqual(['win 1 10 10 20 30 0', 'win 1 30 10 40 30 1']);
        expect(lines.filter(l => l.startsWith('pane 1 '))).toEqual(['pane 1 10 10 20 30 0']);
    });
    it('leaves out boxes whose plane photo is not the one framed, or has no frame', () => {
        expect(lines.some(l => l.startsWith('win 2 '))).toBe(false);
        expect(lines.some(l => l.startsWith('win 3 '))).toBe(false);
    });
    it('writes the classes with their drawn finish, maps and tile size, the reveal with its label, and the footprint', () => {
        expect(lines).toContain('class Tiles039 70 3 6 0.55 0 1.8 0');
        expect(lines).toContain('class class1 40 1 1 0.8 0 2 1');
        expect(lines).toContain('classnormal 0 /m/n.png');
        expect(lines).toContain('classorm 0 /m/o.png');
        expect(lines).toContain(`reveal ${GENERATED_REVEAL_M} generated no reading`);
        expect(lines).toContain('footprint 4 0 0 10 0 10 10 0 10');
        expect(lines).toContain('plane 1 0 50 0 1 0 0 0 1 0 0 0 1 -10 50 0.1 200 1000');
        // a plane's photo and mask, only for a framed plane
        expect(lines).toContain('planeimage 1 /o/facade_1.png');
        expect(lines).toContain('planemask 1 /o/facade_1_uncovered.png');
        expect(lines.some(l => l.startsWith('planeimage 9 '))).toBe(false);
        // fully procedural unless a scan-detail threshold is given
        expect(lines.some(l => l.startsWith('param scanDetailM'))).toBe(false);
        expect(measuredTwinSpec(records(), { glb: '/out/t.glb', report: '/out/r.json' }, [], { scanDetailM: 0.3 }).split('\n')).toContain('param scanDetailM 0.3');
        expect(measuredTwinSpec(records(), { glb: '/out/t.glb', report: '/out/r.json' }, [], { reliefM: 0.3 }).split('\n')).toContain('param reliefM 0.3');
    });
});

describe('rebasePath', () => {
    it('finds a recorded path under another cache root by its cache folders', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mtwin-'));
        const f = path.join(root, 'tile_refine', 'abc', 'clay.glb');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, 'x');
        expect(rebasePath('/elsewhere/.scratchbox/cache/tile_refine/abc/clay.glb', root)).toBe(f);
        expect(rebasePath('/elsewhere/missing.glb', root)).toBe('/elsewhere/missing.glb');
    });
});

// A finished pipeline K build of the Empire State Building, kept from the 2026-11-07 window-array benchmark (main at b2a41010).
const BENCH = process.env.SCRATCHBOX_MEASURED_TWIN_BENCH || '/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-07-window-array-main';
const CACHE = path.join(BENCH, 'main-b2a41010-ownreadings', 'esb', 'cache');
const RUN = path.join(CACHE, 'staged_location', 'runs', '493d1ee7');

describe.skipIf(!fs.existsSync(RUN))('the measured twin of a real pipeline K build (ESB)', () => {
    it('generates the building from its records: tiers, a revolved top, the kept windows, photo colours, provenance per node', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtwin-esb-'));
        const r = await buildMeasuredTwin({ runDir: RUN, cacheRoot: CACHE, outDir, store: fileReadingStore(path.join(BENCH, 'model_readings', 'main-own')) });
        const rep = r.report;
        // the setbacks are tiers; the mast above the 86th-floor block is one slender revolved top to the antenna tip (443 m above the street)
        expect(rep.tiers).toBeGreaterThanOrEqual(10);
        expect(rep.slender.fromM).toBeGreaterThan(315);
        expect(rep.slender.fromM).toBeLessThan(340);
        expect(rep.topM).toBeGreaterThan(430);
        // one axis from many slices' circle fits, and the top in a few tapered steps (not one band per noisy slice)
        expect(rep.slender.axisFits).toBeGreaterThan(20);
        expect(rep.slender.bands).toBeGreaterThan(5);
        expect(rep.slender.bands).toBeLessThan(40);
        // the mast's ribs: the angular profile stacked over each step, folded by the rib count above the ring's harmonics
        expect(rep.slender.finBands).toBeGreaterThan(2);
        expect(rep.slender.fins).toBeGreaterThan(20);
        // the mast's overhang at 388 m: the scan's texels under it are black (never photographed); it takes its wall's colour
        expect(rep.colour.undersideFills).toBeGreaterThan(0);
        // the ESB's arches are carved ornament over flat-topped windows: the opening reader draws no shaped head there
        expect(rep.heads.drawn).toBe(0);
        // most kept boxes are punched; the rest were duplicates of overlapping photos or off every wall, and are counted
        expect(rep.windows.given).toBeGreaterThan(7000);
        expect(rep.windows.placed).toBeGreaterThan(5000);
        const d = rep.windows.dropped;
        expect(rep.windows.placed + d.noWall + d.clipped + d.overlap + d.small + d.noFrame).toBe(rep.windows.given + rep.windows.continued);
        // the reading that put neighbouring columns half a storey apart is put back on its walls' rhythm
        expect(rep.windows.rephased).toBeGreaterThan(100);
        expect(rep.windows.generated).toBeGreaterThanOrEqual(rep.windows.rephased + rep.windows.continued);
        // colour comes from the photo for most elements
        expect(rep.colour.elements).toBeGreaterThan(3 * rep.colour.uncoloured);
        expect(rep.revealLabel).toBe('generated');
        expect(r.mapsMissing).toEqual([]);
        // the GLB: three provenance-labelled nodes, colours per vertex, library maps embedded
        const glb = parseGlbBytes(new Uint8Array(fs.readFileSync(r.glb)));
        const json = glb.json as { nodes: Array<{ name: string; extras?: { sb?: { provenance?: string; depthProvenance?: string } }; mesh: number }>; meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices: number }> }>; images?: unknown[] };
        expect(json.nodes.map(n => n.name)).toEqual(['massing', 'openings', 'slender_top', 'ledge_profiles', 'roof_detail']);
        expect(json.nodes.map(n => n.extras?.sb?.provenance)).toEqual(['measured', 'photo-inferred', 'measured', 'measured', 'measured']);
        // what the scan has above the twin's roofs, rebuilt as blocks: a few pieces on the ESB's terraces, none of them a missed tier
        expect(rep.roofDetail.pieces).toBeGreaterThan(0);
        expect(rep.roofDetail.medianM).toBeLessThan(5);
        // the setback parapets and lips, from the scan's sections stacked along each wall: the ESB's setbacks carry parapets of a metre or two
        expect(rep.profiles.parapets).toBeGreaterThan(20);
        expect(rep.profiles.medianParapetM).toBeGreaterThan(0.5);
        expect(rep.profiles.medianParapetM).toBeLessThan(2.6);
        expect(json.nodes[1].extras?.sb?.depthProvenance).toBe('generated');
        // one image: the atlas every element samples (renderers that ignore vertex colours still draw every colour)
        expect((json.images ?? []).length).toBe(1);
        expect(rep.detail.paletteColours).toBeGreaterThan(1000);
        // the walls' detail textures: most walls with windows carry one, in one atlas
        expect(rep.detail.faces).toBeGreaterThan(rep.facesWithWindows / 2);
        expect(rep.detail.atlas[0]).toBe(4096);
        const mats = (glb.json as { materials: Array<{ name: string; pbrMetallicRoughness: { baseColorTexture?: unknown } }> }).materials;
        const used = new Set(json.meshes.flatMap(m => m.primitives.map(p => (p as { material: number }).material)));
        expect([...used].every(i => mats[i].pbrMetallicRoughness.baseColorTexture)).toBe(true);
        let tris = 0;
        for (const m of json.meshes) for (const p of m.primitives) {
            const col = readAccessor(glb, p.attributes.COLOR_0);
            expect(col.comps).toBe(3);
            expect(Math.max(...Array.from(col.data.slice(0, 3000)))).toBeLessThanOrEqual(1);
            tris += readAccessor(glb, p.indices).count / 3;
        }
        expect(tris).toBe(rep.triangles);
        // the slender top's walls face away from its axis (a viewer drawing front faces only shows them solid)
        const top = json.nodes.findIndex(n => n.name === 'slender_top');
        let outward = 0, vertical = 0;
        for (const p of json.meshes[json.nodes[top].mesh].primitives) {
            const P = readAccessor(glb, p.attributes.POSITION).data, I = readAccessor(glb, p.indices).data;
            const cx: number[] = [], cz: number[] = [];
            for (let k = 0; k < P.length; k += 3) { cx.push(P[k]); cz.push(P[k + 2]); }
            const mx = cx.reduce((a, b) => a + b, 0) / cx.length, mz = cz.reduce((a, b) => a + b, 0) / cz.length;
            for (let t = 0; t < I.length; t += 3) {
                const v = [0, 1, 2].map(j => [P[I[t + j] * 3], P[I[t + j] * 3 + 1], P[I[t + j] * 3 + 2]]);
                const e1 = v[1].map((x, j) => x - v[0][j]), e2 = v[2].map((x, j) => x - v[0][j]);
                const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const len = Math.hypot(n[0], n[1], n[2]);
                if (!len || Math.abs(n[1] / len) > 0.3) continue;
                const c = [0, 2].map(j => (v[0][j] + v[1][j] + v[2][j]) / 3);
                const rx = c[0] - mx, rz = c[1] - mz, rl = Math.hypot(rx, rz), hl = Math.hypot(n[0], n[2]);
                const radial = (n[0] * rx + n[2] * rz) / (rl * hl || 1);
                if (Math.abs(radial) < 0.7) continue;  // a fin's side faces sideways round the axis, not in or out
                vertical++;
                if (radial > 0) outward++;
            }
        }
        expect(vertical).toBeGreaterThan(100);
        expect(outward / vertical).toBeGreaterThan(0.95);
        expect(tris).toBeLessThan(400_000);
    }, 600_000);

    it('builds the twin K-free: from the cut-out scan and its texture alone, its own wall photos and windows', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtwin-esb-kfree-'));
        const r = await buildMeasuredTwin({ runDir: RUN, cacheRoot: CACHE, outDir, options: { kFree: true } });
        const rep = r.report;
        const spec = fs.readFileSync(r.specFile, 'utf8').split('\n');
        // nothing of K in the spec: no plane frames, window boxes, classes or footprint; the street level estimated
        expect(spec.some(l => /^(plane|win|pane|class|footprint|planeimage) /.test(l))).toBe(false);
        expect(spec).toContain('ground auto');
        expect(spec).toContain('param selfRead 1');
        expect(rep.tiers).toBeGreaterThanOrEqual(10);
        expect(rep.slender.fromM).toBeGreaterThan(315);
        expect(rep.heads.selfWalls).toBeGreaterThan(50);
        expect(rep.heads.selfWindows).toBeGreaterThan(500);
        expect(rep.detail.faces).toBeGreaterThan(50);
    }, 600_000);

    it('infers a second pass from its own wall photos with no model: window arrays, congruent copies, piers, round thin sections', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtwin-esb-infer-'));
        const r = await buildMeasuredTwin({ runDir: RUN, cacheRoot: CACHE, outDir, options: { infer: true } });
        const i = r.infer!;
        // the first pass wrote each wall's photo as an orthos folder in K's frame
        const facades = JSON.parse(fs.readFileSync(path.join(outDir, 'self_orthos', 'facades.json'), 'utf8')) as { facades: Array<{ facadeId: number; image: string; width: number; height: number }> };
        expect(facades.facades.length).toBeGreaterThan(50);
        const png = fs.readFileSync(path.join(outDir, 'self_orthos', facades.facades[0].image));
        expect(png.readUInt32BE(16)).toBe(facades.facades[0].width);
        // no model: the steps that need one say so, the rest ran on the photos and the scan
        expect(i.system).toEqual({ reason: 'no vision model' });
        expect(i.relief).toEqual({ reason: 'no image model' });
        expect(i.windows.arrayed).toBeGreaterThan(1000);
        expect(i.windows.copied).toBeGreaterThan(0);
        const spec = fs.readFileSync(r.specFile, 'utf8').split('\n');
        expect(spec).toContain('param piers 1');
        expect(spec.filter(l => l.startsWith('plane ')).length).toBe(facades.facades.length);
        expect(r.report.windows.placed).toBeGreaterThan(2000);
        expect(r.report.piers!.walls).toBeGreaterThan(10);
        expect(r.report.piers!.turnedBands).toBeGreaterThan(0);
        expect(r.report.detail.faces).toBeGreaterThan(100);
        // the scan's photos corrected first: roof shadow lifted, the photos' seams closer than before
        expect(r.photometry && 'glb' in r.photometry && fs.existsSync(r.photometry.glb)).toBe(true);
        const ph = r.photometry as { harmonize?: string; roofShadow?: string };
        expect(ph.roofShadow).toMatch(/lifted/);
        const m = /seams ([0-9.]+) -> ([0-9.]+)/.exec(ph.harmonize ?? '');
        expect(m && Number(m[2]) < Number(m[1])).toBe(true);
    }, 600_000);
});

describe.skipIf(!fs.existsSync(RUN))('the hybrid twin of a real staged run (ESB)', () => {
    it('runs pipeline K\'s detail stages on the cut-out\'s own facade photos with no model, and builds the twin from them', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtwin-esb-hybrid-'));
        const r = await buildMeasuredTwin({ runDir: RUN, cacheRoot: CACHE, outDir, options: { hybrid: true } });
        const h = r.hybrid!;
        // a fresh copy of the orthos straightened, its windows fitted and arrayed; the reader and system need a model
        expect(h.orthos.rectified).toBeGreaterThan(50);
        expect(h.windowFit.windows).toBeGreaterThan(1000);
        expect(h.reader).toEqual({ reason: 'no vision model' });
        expect(h.array.windows).toBeGreaterThan(h.windowFit.windows);
        expect(fs.existsSync(path.join(outDir, 'hybrid', 'relief_orthos'))).toBe(true);
        const spec = fs.readFileSync(r.specFile, 'utf8').split('\n');
        for (const l of ['param selfFill 1', 'param slenderTex 1', 'param orthoBlend 0.6', 'param scanDetailStepM 0.6', 'param atlasJpeg 1']) expect(spec).toContain(l);
        expect(spec.some(l => l.startsWith('win '))).toBe(true);
        // no model: the window fit and arrays alone (with the reader and system, cold, 4,418 on the twin)
        expect(r.report.windows.placed).toBeGreaterThan(1000);
        // every wall textured: K's photo blended in where one stands on it, its own scan photo elsewhere
        expect(r.report.piers!.orthoTexels).toBeGreaterThan(1_000_000);
        expect(r.report.piers!.selfFilled).toBeGreaterThan(0);
        // the mast's panels carry the scan's photo, not one colour each
        expect(r.report.piers!.slenderTexels).toBeGreaterThan(100_000);
        expect(r.report.detail.faces).toBeGreaterThan(100);
        // the scan kept only where it steps out (ornament), the lips still drawn
        expect(r.report.scanDetail.pieces).toBeGreaterThan(0);
        expect(r.report.profiles.lips).toBeGreaterThan(0);
        const glb = fs.readFileSync(r.glb);
        const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { images: Array<{ mimeType: string }> };
        expect(json.images[0].mimeType).toBe('image/jpeg');
    }, 1_200_000);
});

describe('enuOffset', () => {
    it('measures east, up and south between two places', () => {
        // 0.0001 degrees of latitude north at 40.75 N is about 11.1 m; of longitude east about 8.4 m
        const o = enuOffset({ lat: 40.748545, lng: -73.985763, h: -18.66 }, { lat: 40.7484405, lng: -73.9856644, h: -30 });
        expect(o[0]).toBeCloseTo(8.33, 1);
        expect(o[1]).toBeCloseTo(-11.34, 2);
        expect(o[2]).toBeCloseTo(11.6, 1);
    });
});
