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
import { buildMeasuredTwin, ensureMeasuredTwinBinary, GENERATED_REVEAL_M, measuredTwinSpec, rebasePath, type KRunRecords } from '../src/node/3d-engine/staged-location/measured-twin/measured-twin';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { execFileSync } from 'child_process';
import { fileReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { enuOffset } from '../src/node/3d-engine/staged-location/measured-twin/infer';
import { applyGlbExposure } from '../src/node/3d-engine/staged-location/measured-twin/exposure';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

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

describe('the twin stands at the street level it is given', () => {
    // a box 20 x 16 m and 40 m tall on a street at `ground`, its walls, roof and the street round it meshed at 1 m
    function boxOnStreet(ground: number): Buffer {
        const pos: number[] = [], idx: number[] = [];
        const grid = (o: number[], u: number[], v: number[], nu: number, nv: number) => {
            const base = pos.length / 3;
            for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) for (let c = 0; c < 3; c++) pos.push(o[c] + u[c] * i / nu + v[c] * j / nv);
            for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i; idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1); }
        };
        const [x0, x1, z0, z1, h] = [-10, 10, -8, 8, 40];
        grid([x0, ground, z0], [x1 - x0, 0, 0], [0, h, 0], 20, 40); grid([x1, ground, z0], [0, 0, z1 - z0], [0, h, 0], 16, 40);
        grid([x1, ground, z1], [x0 - x1, 0, 0], [0, h, 0], 20, 40); grid([x0, ground, z1], [0, 0, z0 - z1], [0, h, 0], 16, 40);
        grid([x0, ground + h, z0], [0, 0, z1 - z0], [x1 - x0, 0, 0], 16, 20); grid([-30, ground, -30], [0, 0, 60], [60, 0, 0], 30, 30);
        const P = new Float32Array(pos), I = new Uint32Array(idx), bin = new Uint8Array(P.byteLength + I.byteLength);
        bin.set(new Uint8Array(P.buffer), 0); bin.set(new Uint8Array(I.buffer), P.byteLength);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
        return assembleGlb({
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: lo, max: hi }, { bufferView: 1, componentType: 5125, count: I.length, type: 'SCALAR' }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }], buffers: [{ byteLength: bin.byteLength }]
        }, bin);
    }

    it('puts the base on the street and the top at the scan\'s top, whatever the level (once it stood a street level too high)', async () => {
        const bin = await ensureMeasuredTwinBinary();
        for (const ground of [0, 7, -4]) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-ground-'));
            const isolate = path.join(dir, 'box.glb'), glb = path.join(dir, 'twin.glb'), report = path.join(dir, 'report.json'), spec = path.join(dir, 'spec.txt');
            fs.writeFileSync(isolate, boxOnStreet(ground));
            fs.writeFileSync(spec, measuredTwinSpec({ runDir: dir, orthosDir: dir, isolate, groundY: ground, loops: [], planes: [], windowFit: [], classes: [], photos: {}, reveal: { depthM: GENERATED_REVEAL_M, label: 'generated', source: 'test' } }, { glb, report }));
            const answer = JSON.parse(execFileSync(bin, [spec], { maxBuffer: 16 * 1024 * 1024 }).toString().trim().split('\n').pop()!) as { ok: boolean; topM: number; tiers: number };
            expect(answer.ok).toBe(true);
            expect(answer.topM).toBeCloseTo(40, 0);
            const json = parseGlbBytes(fs.readFileSync(glb)).json as any;
            let lo = Infinity, hi = -Infinity;
            for (const m of json.meshes) for (const p of m.primitives) { const a = json.accessors[p.attributes.POSITION]; lo = Math.min(lo, a.min[1]); hi = Math.max(hi, a.max[1]); }
            expect(lo, `base at ground ${ground}`).toBeCloseTo(ground, 0);
            expect(hi, `top at ground ${ground}`).toBeCloseTo(ground + 40, 0);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 600_000);
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
        // the ESB's arches are carved ornament over flat-topped windows: the opening reader finds one head type there (11
        // windows, a 0.16 m rise, just over headMinM) and draws at most one of them. With the twin one street level too
        // high (0.29 m here) none of the 11 landed on a wall and none was drawn; at the right height one does
        expect(rep.heads.types).toBeLessThanOrEqual(1);
        expect(rep.heads.drawn).toBeLessThanOrEqual(1);
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
        const r = await buildMeasuredTwin({ runDir: RUN, cacheRoot: CACHE, outDir, options: { infer: true, foldScan: true } });
        const i = r.infer!;
        // the folded scan: every wall with windows read (inside against the ring around them, on the unflattened scan),
        // and the ESB's mesh measured as holding no bay-scale relief (its steps within a few cm of zero, almost none
        // standing three standard errors clear)
        const fp = r.report.piers as unknown as { revealWalls: number; revealMeasured: number; foldReads: Array<[number, number, number, number, number, number]> };
        expect(fp.revealWalls).toBeGreaterThan(10);
        expect(fp.foldReads.length).toBeGreaterThan(10);
        const steps = fp.foldReads.map(f => Math.abs(f[2])).sort((a, b) => a - b);
        expect(steps[Math.floor(steps.length / 2)]).toBeLessThan(0.03);
        expect(fp.revealMeasured).toBeLessThan(fp.revealWalls / 4);
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
        for (const l of ['param selfFill 1', 'param slenderTex 1', 'param residualGate 1', 'param scanDetailStepM 0.6', 'param atlasJpeg 1', 'param roofRows 768']) expect(spec).toContain(l);
        expect(spec.some(l => l.startsWith('win '))).toBe(true);
        // no model: the window fit and arrays alone (with the reader and system, cold, 4,418 on the twin)
        expect(r.report.windows.placed).toBeGreaterThan(1000);
        // the residual gate: the walls drawn from the storey median, the wall's own photo kept only where it departs from
        // it in regions with detail of their own (a small share), smears refused
        const g = r.report.piers!.gate!;
        expect(g.seen).toBeGreaterThan(1_000_000);
        expect(g.texels).toBeGreaterThan(10_000);
        expect(g.texels / g.seen).toBeLessThan(0.3);
        expect(g.refused).toBeGreaterThan(0);
        expect(r.report.piers!.selfFilled).toBeGreaterThan(0);
        // the mast's panels carry the scan's photo, not one colour each
        expect(r.report.piers!.slenderTexels).toBeGreaterThan(100_000);
        expect(r.report.detail.faces).toBeGreaterThan(100);
        // the roofs drawn from the scan's photo seen from above, in 4 m cells only where a cap is seen, near the walls' texel
        expect(r.report.roofPatches).toBeGreaterThan(500);
        expect(r.report.roofTexels).toBeGreaterThan(1_000_000);
        expect(r.report.roofTexelM).toBeLessThan(0.1);
        // the scan kept only where it steps out (ornament), the lips still drawn
        expect(r.report.scanDetail.pieces).toBeGreaterThan(0);
        expect(r.report.profiles.lips).toBeGreaterThan(0);
        const glb = fs.readFileSync(r.glb);
        const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { images: Array<{ mimeType: string }> };
        expect(json.images[0].mimeType).toBe('image/jpeg');
        // pipeline K's symmetry on the same orthos: the mirror fill ran (native, no model) and the twin's masks count
        // its texels covered
        expect(h.symmetry && 'fill' in h.symmetry).toBe(true);
        if (h.symmetry && 'fill' in h.symmetry) expect(h.symmetry.textureTexels).toBeGreaterThanOrEqual(0);
        // no model, no finish read: the photos keep their level, and the twin says why
        expect(r.exposure && 'reason' in r.exposure).toBe(true);
        // the exposure pass on the real twin: every base-colour texel raised in linear light, the GLB labelled
        const copy = path.join(outDir, 'exposed.glb');
        fs.copyFileSync(r.glb, copy);
        const ex = applyGlbExposure(copy, { gain: 1.5, classes: [], fitted: 1.5, clipCap: 4, why: 'test', label: 'photo-inferred' })!;
        expect(ex.images).toBeGreaterThan(0);
        const before = parseGlbBytes(fs.readFileSync(r.glb)), after = parseGlbBytes(fs.readFileSync(copy));
        expect(after.json.asset.extras.sbExposure).toMatchObject({ gain: 1.5, label: 'photo-inferred' });
        const atlasOf = (g: ReturnType<typeof parseGlbBytes>) => { const v = g.json.bufferViews[g.json.images[0].bufferView]; return decodeImageInMemory(g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); };
        const a = atlasOf(before), b = atlasOf(after);
        expect([b.width, b.height]).toEqual([a.width, a.height]);
        const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        let sa = 0, sb = 0;
        for (let i = 0; i < a.rgba.length; i += 4 * 97) { const g = a.rgba[i + 1]; if (g > 20 && g < 150) { sa += lin(g); sb += lin(b.rgba[i + 1]); } }
        expect(sb / sa).toBeGreaterThan(1.4);
        expect(sb / sa).toBeLessThan(1.6);
        // the geometry is untouched
        const pos = (g: ReturnType<typeof parseGlbBytes>) => readAccessor(g, g.json.meshes[0].primitives[0].attributes.POSITION).data;
        expect(Array.from(pos(after).slice(0, 30))).toEqual(Array.from(pos(before).slice(0, 30)));
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
