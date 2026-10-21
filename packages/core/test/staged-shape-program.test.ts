/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shape program trial on synthetic inputs (no network, no model): program validation, the native build of every
 * operator (closed solids, triangle counts, volumes), height-map tiers of a two-tier scan, the fit recovering known
 * parameters from a perturbed program, and the tree measurement and split round trip. Screenshots under
 * test-results/screenshots/shape_program/tests/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { applyHandles, elementHandles, programSpecText, readF32, runShapeTool, stagedShapeProgram, validateProgram, type ScanTargets, type ShapeProgram, type UV } from '../src/node/3d-engine/staged-location/pipeline-e/shape-program';
import { contactSheet, fitOverlay, measureTrees } from '../src/node/3d-engine/staged-location/pipeline-e/shape-stage';
import { massingSpecText } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/shape_program/tests');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shape-program-'));
const BOUNDS = { minU: -30, maxU: 30, minV: -30, maxV: 30, maxH: 50 };

/** A triangle soup (9 floats per triangle) as a GLB. */
function soupGlb(file: string, soup: Float32Array): void {
    fs.writeFileSync(file, writeStagedGlb([{ name: 'scan', positions: soup }]));
}

/** Signed volume of a soup of closed solids (divergence theorem). */
function soupVolume(p: Float32Array): number {
    let v = 0;
    for (let i = 0; i < p.length; i += 9) {
        v += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
    }
    return v;
}

/** Builds a program with no targets (frame at the origin, theta 0): its soup in the tile frame. */
async function buildSoup(prog: ShapeProgram, dir: string, measured: UV[] = []): Promise<{ soup: Float32Array; elem: Int32Array; geometry: any }> {
    const scan: ScanTargets = { dir, frame: { ox: 0, oz: 0, theta: 0, groundY: 0 }, grid: { u0: 0, v0: 0, cell: 1, nu: 0, nv: 0 }, cameras: [], buildingH: 10 };
    const text = programSpecText(prog, { outDir: dir, measuredOutline: measured, scan, fit: null }).split('\n').filter(l => !l.startsWith('target_height')).join('\n');
    await runShapeTool(text, dir);
    const e = fs.readFileSync(path.join(dir, 'soup_elem.i32'));
    return { soup: readF32(path.join(dir, 'soup.f32')), elem: new Int32Array(e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength)), geometry: JSON.parse(fs.readFileSync(path.join(dir, 'geometry.json'), 'utf8')) };
}

describe('shape program flag', () => {
    it('is off unless SCRATCHBOX_STAGED_SHAPE_PROGRAM is set', () => {
        expect(stagedShapeProgram({} as NodeJS.ProcessEnv)).toBeUndefined();
        expect(stagedShapeProgram({ SCRATCHBOX_STAGED_SHAPE_PROGRAM: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
        expect(stagedShapeProgram({ SCRATCHBOX_STAGED_SHAPE_PROGRAM: '1' } as NodeJS.ProcessEnv)).toBe('program');
        expect(stagedShapeProgram({ SCRATCHBOX_STAGED_SHAPE_PROGRAM: 'tiers' } as NodeJS.ProcessEnv)).toBe('tiers');
    });
});

describe('program validation', () => {
    it('keeps well-formed elements, drops those with two operators or impossible numbers, and renumbers relief targets', () => {
        const raw = {
            summary: 'test',
            elements: [
                { label: 'two operators', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 10, widthV: 8 } }, baseM: 0, topM: 10 }, revolve: { centerU: 0, centerV: 0, baseM: 0, profile: [[0, 1], [5, 0]] } },
                { label: 'body', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 20, widthV: 12 } }, baseM: 0, topM: 12, roofRiseM: 4, roofRidgeAngleDeg: 0, roofHipShare: 0 } },
                { label: 'upside down', prism: { outline: { polygon: [[0, 0], [1, 0], [1, 1]] }, baseM: 10, topM: 5 } },
                { label: 'band', relief: { targetElement: 1, fromM: 10, toM: 11, outM: 0.4 } },
                { label: 'spire', revolve: { centerU: 8, centerV: 0, baseM: 12, profile: [[0, 2], [15, 0]], sides: 8 }, repeat: { count: 0 } }
            ]
        };
        const { program, problems } = validateProgram(raw, BOUNDS);
        expect(program!.elements.map(e => e.label)).toEqual(['body', 'band', 'spire']);
        expect(program!.elements[1].relief!.targetElement).toBe(0);
        expect(program!.elements[2].repeat).toBeUndefined();
        expect(problems.some(p => p.includes('2 operators'))).toBe(true);
        expect(problems.some(p => p.includes('not usable'))).toBe(true);
        expect(problems.some(p => p.includes('repeat count'))).toBe(true);
        expect(validateProgram({ elements: [] }, BOUNDS).program).toBeUndefined();
        expect(validateProgram('nonsense', BOUNDS).problems[0]).toMatch(/no elements/);
    });
});

describe('native build of the four operators', () => {
    it('builds closed solids with the volumes their numbers give', async () => {
        const dir = tmp();
        const box: ShapeProgram = { elements: [{ label: 'box', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 20, widthV: 10 } }, baseM: 0, topM: 12 } }] };
        const b = await buildSoup(box, path.join(dir, 'box'));
        expect(b.soup.length / 9).toBeGreaterThanOrEqual(12);
        expect(soupVolume(b.soup)).toBeCloseTo(20 * 10 * 12, 1);
        // a gable roof adds half the rise over the plan: 20 x 10 x 4 / 2
        const gable: ShapeProgram = { elements: [{ label: 'g', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 20, widthV: 10 } }, baseM: 0, topM: 12, roofRiseM: 4, roofRidgeAngleDeg: 0, roofHipShare: 0 } }] };
        const g = await buildSoup(gable, path.join(dir, 'gable'));
        expect(soupVolume(g.soup)).toBeCloseTo(20 * 10 * 12 + 20 * 10 * 4 / 2, 0);
        expect(g.geometry.parts[0].planes.length).toBe(2);
        // a square pyramid (hip share 1 on a square): the roof adds a third of base x rise
        const pyr: ShapeProgram = { elements: [{ label: 'p', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 10, widthV: 10 } }, baseM: 0, topM: 5, roofRiseM: 6, roofRidgeAngleDeg: 0, roofHipShare: 1 } }] };
        const p = await buildSoup(pyr, path.join(dir, 'pyr'));
        expect(soupVolume(p.soup)).toBeCloseTo(500 + 100 * 6 / 3, 0);
        // revolve: a cone of radius 2 and height 6, 64 sides ~ pi r^2 h / 3
        const cone: ShapeProgram = { elements: [{ label: 'c', revolve: { centerU: 0, centerV: 0, baseM: 0, profile: [[0, 2], [6, 0]], sides: 64 } }] };
        const c = await buildSoup(cone, path.join(dir, 'cone'));
        expect(soupVolume(c.soup)).toBeGreaterThan(0.98 * Math.PI * 4 * 6 / 3);
        expect(soupVolume(c.soup)).toBeLessThan(1.001 * Math.PI * 4 * 6 / 3);
        expect(c.geometry.meshes.length).toBe(1);
        // sweep: a 1 x 2 profile along a 10 m straight path = 20 m^3; an arch (semicircle of radius 4) about pi 4 x 2
        const bar: ShapeProgram = { elements: [{ label: 's', sweep: { path: [[0, 0, 0], [10, 0, 0]], profile: [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 2, 0], [-0.5, 2, 0]] } }] };
        const s = await buildSoup(bar, path.join(dir, 'bar'));
        expect(soupVolume(s.soup)).toBeCloseTo(20, 3);
        const arc: Array<[number, number, number]> = Array.from({ length: 25 }, (_, k) => { const a = Math.PI * k / 24; return [4 * Math.cos(a), 0, 4 * Math.sin(a)]; });
        const arch: ShapeProgram = { elements: [{ label: 'arch', sweep: { path: arc, profile: [[-0.5, -1, 0], [0.5, -1, 0], [0.5, 1, 0], [-0.5, 1, 0]] } }] };
        const a = await buildSoup(arch, path.join(dir, 'arch'));
        expect(soupVolume(a.soup)).toBeGreaterThan(0.97 * Math.PI * 4 * 2);
        expect(soupVolume(a.soup)).toBeLessThan(1.03 * Math.PI * 4 * 2);
        // a bulged profile: a 2 x 1 rectangle with a semicircular top (bulge 1 from its top-right to top-left corner)
        const round: ShapeProgram = { elements: [{ label: 'r', sweep: { path: [[0, 0, 0], [10, 0, 0]], profile: [[-1, 0, 0], [1, 0, 0], [1, 1, 1], [-1, 1, 0]] } }] };
        const rr = await buildSoup(round, path.join(dir, 'round'));
        expect(soupVolume(rr.soup)).toBeGreaterThan(0.98 * 10 * (2 + Math.PI / 2));
        expect(soupVolume(rr.soup)).toBeLessThan(1.001 * 10 * (2 + Math.PI / 2));
        // relief band on the box and a repeated column row
        const banded: ShapeProgram = { elements: [box.elements[0], { label: 'band', relief: { targetElement: 0, fromM: 10, toM: 11, outM: 0.5 } }, { label: 'cols', revolve: { centerU: -8, centerV: 7, baseM: 0, profile: [[0, 0.4], [6, 0.4]], sides: 16 }, repeat: { count: 5, stepU: 4 } }] };
        const bb = await buildSoup(banded, path.join(dir, 'banded'));
        const perElem = [0, 1, 2].map(k => bb.elem.filter(x => x === k).length);
        expect(perElem.every(n => n > 0)).toBe(true);
        expect(perElem[2]).toBe(5 * (16 * 2 + 16 * 2));
        expect(bb.geometry.parts.length).toBe(2);  // the box and the band as prisms
        // each solid is closed on its own: the box, the whole band ring (21 x 11 x 1, overlapping the box) and five 16-gon columns
        expect(soupVolume(bb.soup)).toBeCloseTo(2400 + 21 * 11 + 5 * 6 * 0.5 * 16 * 0.16 * Math.sin(2 * Math.PI / 16), 0);
        const total = bb.soup.length / 9;
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'operators_counts.json'), JSON.stringify({ box: b.soup.length / 9, gable: g.soup.length / 9, cone: c.soup.length / 9, arch: a.soup.length / 9, banded: total }, null, 1));
    }, 120_000);
});

/** A synthetic two-tier scan with a pitched roof: body 30 x 18, 10 m to the eaves, a 5 m gable; a 8 x 8 tower to 26 m. */
const TRUTH: ShapeProgram = {
    elements: [
        { label: 'body', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 30, widthV: 18 } }, baseM: 0, topM: 10, roofRiseM: 5, roofRidgeAngleDeg: 0, roofHipShare: 0 } },
        { label: 'tower', prism: { outline: { rect: { centerU: 11, centerV: 0, lengthU: 8, widthV: 8 } }, baseM: 0, topM: 26 } }
    ]
};

describe('fit handles keep every element', () => {
    it('never lets a prism\'s sides cross or its height vanish, nor a band', async () => {
        const dir = tmp();
        const prog: ShapeProgram = { elements: [
            { label: 'thin', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 10, widthV: 1 } }, baseM: 5, topM: 8 } },
            { label: 'band', relief: { targetElement: 0, fromM: 6, toM: 7, outM: 0.3 } }
        ] };
        // handles pushed past each other: the v sides cross by 2 m, the top below the base, the band inverted
        const handles = [elementHandles(prog.elements[0], false), elementHandles(prog.elements[1], false)];
        handles[0][2].value = 1.5; handles[0][3].value = -1.5; handles[0][5].value = 4;
        handles[1][1].value = 5;
        const scan: ScanTargets = { dir, frame: { ox: 0, oz: 0, theta: 0, groundY: 0 }, grid: { u0: 0, v0: 0, cell: 1, nu: 0, nv: 0 }, cameras: [], buildingH: 10 };
        const text = programSpecText(prog, { outDir: dir, measuredOutline: [], scan, fit: null, handles }).split('\n').filter(l => !l.startsWith('target_height')).join('\n');
        await runShapeTool(text, dir);
        const g = JSON.parse(fs.readFileSync(path.join(dir, 'geometry.json'), 'utf8'));
        expect(g.parts.length).toBe(2);
        const loop = g.parts[0].loops[0] as Array<[number, number]>;
        const zs = loop.map(p => p[1]);
        expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.3, 3);
        expect(g.parts[0].topY - g.parts[0].baseY).toBeCloseTo(0.5, 3);
        expect(g.parts[1].topY - g.parts[1].baseY).toBeCloseTo(0.1, 3);
        const { program } = applyHandles(prog, handles.map(hs => hs.map(h => [h.value, h.value] as [number, number])), handles.map(hs => hs.map(() => true)), []);
        const vs = program.elements[0].prism!.outline.polygon!.map(q => q[1]);
        expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(0.3, 3);
        expect(program.elements[0].prism!.topM).toBeCloseTo(5.5, 3);
    }, 60_000);
});

describe('height-map tiers and the fit (native, synthetic scan)', () => {
    it('finds the tower and body tiers, then fits a perturbed program back to the scan', async () => {
        const dir = tmp();
        const truth = await buildSoup(TRUTH, path.join(dir, 'truth'));
        // the scan as a tile would carry it: rotated 20 degrees and moved, plus a street apron
        const th = (20 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
        const P = new Float32Array(truth.soup.length + 18);
        for (let i = 0; i < truth.soup.length; i += 3) { const x = truth.soup[i], z = truth.soup[i + 2]; P[i] = 100 + c * x - s * z; P[i + 1] = truth.soup[i + 1] + 5; P[i + 2] = -40 + s * x + c * z; }
        P.set([60, 5, -80, 140, 5, -80, 140, 5, 0, 60, 5, -80, 140, 5, 0, 60, 5, 0], truth.soup.length);
        const glb = path.join(dir, 'scan.glb');
        soupGlb(glb, P);
        const scanDir = path.join(dir, 'scan');
        await runShapeTool(`mode scan\nout ${scanDir}\nisolate ${glb}\nground 5\n`, scanDir);
        const scan = JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8'));
        // the frame follows the walls (20 degrees mod 90)
        const deg = ((scan.frame.theta * 180) / Math.PI + 360) % 90;
        expect(Math.min(Math.abs(deg - 20), Math.abs(deg - 110 + 90))).toBeLessThan(1.0);
        expect(scan.classes.ground.triangles).toBe(6);  // the street apron and the solids' bottoms
        // levels: the eaves-to-ridge roof spreads over 10..15 m; the tower's top at 26 m is a level
        const heights = scan.levels.map((l: any) => l.h);
        expect(heights.some((h: number) => Math.abs(h - 26) < 0.3)).toBe(true);
        const top = scan.tiers[scan.tiers.length - 1];
        expect(top.topY - 5).toBeCloseTo(26, 0);
        expect(top.areaM2).toBeGreaterThan(55);
        expect(top.areaM2).toBeLessThan(75);
        expect(top.loopsUV[0].length).toBe(4);  // squared: a rectangle
        // the fit: a program 15% too big, 3 m too low, the roof flat, the tower 2 m off
        const guess: ShapeProgram = {
            elements: [
                { label: 'body', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 34, widthV: 21 } }, baseM: 0, topM: 8, roofRiseM: 2, roofRidgeAngleDeg: 0, roofHipShare: 0 } },
                { label: 'tower', prism: { outline: { rect: { centerU: 13, centerV: 1.5, lengthU: 8, widthV: 8 } }, baseM: 0, topM: 22 } }
            ]
        };
        // in the scan's frame the truth is centred where the frame's origin lies: express the guess there
        const fr = scan.frame;
        const toUV = (x: number, z: number): UV => { const cc = Math.cos(fr.theta), ss = Math.sin(fr.theta), dx = x - fr.ox, dz = z - fr.oz; return [cc * dx + ss * dz, -ss * dx + cc * dz]; };
        const world = (u: number, v: number) => [100 + c * u - s * v, -40 + s * u + c * v];
        for (const e of guess.elements) { const r = e.prism!.outline.rect!; const [x, z] = world(r.centerU, r.centerV); const [u, v] = toUV(x, z); r.centerU = u; r.centerV = v; }
        // the frame may be turned by 90 degrees against the truth: swap the rectangle's sides when it is
        const turned = Math.abs(Math.cos(fr.theta - th)) < 0.5;
        if (turned) for (const e of guess.elements) { const r = e.prism!.outline.rect!; [r.lengthU, r.widthV] = [r.widthV, r.lengthU]; e.prism!.roofRidgeAngleDeg = 90; }
        const targets: ScanTargets = { dir: scanDir, frame: scan.frame, grid: scan.grid, cameras: scan.cameras, buildingH: 26 };
        const fitDir = path.join(dir, 'fit');
        await runShapeTool(programSpecText(guess, { outDir: fitDir, measuredOutline: [], scan: targets, fit: { passes: 6, maxEvals: 4000 } }), fitDir);
        const fit = JSON.parse(fs.readFileSync(path.join(fitDir, 'fit.json'), 'utf8'));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'synthetic_fit_overlay.png'), fitOverlay(scanDir, fitDir, scan, ['before', 'after']));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_fit_raw.json'), JSON.stringify({ fit, scanFrame: scan.frame, turned }, null, 1));
        expect(fit.after.total).toBeLessThan(fit.before.total * 0.5);
        const free = guess.elements.map(e => elementHandles(e, true).map(h => h.step > 0));
        const { program, parameters } = applyHandles(guess, fit.handles, free, []);
        const body = program.elements[0].prism!, tower = program.elements[1].prism!;
        expect(body.topM).toBeGreaterThan(9); expect(body.topM).toBeLessThan(11);
        expect(body.roofRiseM!).toBeGreaterThan(3.5); expect(body.roofRiseM!).toBeLessThan(6.5);
        expect(tower.topM).toBeGreaterThan(25); expect(tower.topM).toBeLessThan(27);
        const span = (poly: UV[], k: 0 | 1) => Math.max(...poly.map(q => q[k])) - Math.min(...poly.map(q => q[k]));
        const L = turned ? 1 : 0;
        expect(Math.abs(span(body.outline.polygon!, L as 0 | 1) - 30)).toBeLessThan(1.5);
        expect(Math.abs(span(body.outline.polygon!, (1 - L) as 0 | 1) - 18)).toBeLessThan(1.5);
        expect(parameters.filter(p => p.provenance === 'measured').length).toBeGreaterThan(8);
        fs.mkdirSync(SHOTS, { recursive: true });
        const outline = (scan.outlineUV[0] ?? []) as UV[];
        fs.writeFileSync(path.join(SHOTS, 'synthetic_contact_sheet.png'), contactSheet(scanDir, scan, outline, []));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_fit_overlay.png'), fitOverlay(scanDir, fitDir, scan, ['before', 'after']));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_fit.json'), JSON.stringify({ before: fit.before, after: fit.after, evals: fit.evals, fitted: program }, null, 1));
    }, 180_000);

    it('hands the fitted prisms and solids to the massing kernel as a closed solid', async () => {
        const dir = tmp();
        const prog: ShapeProgram = { elements: [TRUTH.elements[0], { label: 'drum', revolve: { centerU: -8, centerV: 0, baseM: 15, profile: [[0, 2], [4, 2], [6, 0]], sides: 16 } }] };
        const b = await buildSoup(prog, path.join(dir, 'p'));
        const g = b.geometry;
        const text = massingSpecText({ parts: g.parts.map((p: any) => ({ id: p.id, baseY: p.baseY, topY: p.topY, loops: p.loops, planes: p.planes.map((q: any) => ({ ...q, tag: 'program' })), heightSource: 'shape-program', heights: {}, provenance: 'shape-program-inferred' })), meshes: g.meshes.map((m: any) => ({ id: m.id, vertices: m.vertices, indices: m.indices, provenance: 'shape-program-inferred' })) }, { outDir: path.join(dir, 'massing') });
        const run = await runMassing(text, path.join(dir, 'massing'));
        expect(run.report.signedVolumeM3).toBeGreaterThan(30 * 18 * 10 + 30 * 18 * 5 / 2 - 5);
        expect(run.nodes.every(n => n.provenance === 'shape-program-inferred' || n.kind === 'residual')).toBe(true);
    }, 180_000);
});

describe('trees out first (measurement and split round trip)', () => {
    it('reads each crown\'s base from the removed triangles and splits the isolate into building, ground and tree', async () => {
        const dir = tmp();
        // a crown 6 m across, support at 0, base at 3 m, apex at 9 m, beside a 10 x 10 x 8 building
        const crown = { id: 7, status: 'tree', stem: [14, 0], apex: [14, 9, 0], supportY: 0, apexAboveSupport: 9, sectorRadii: Array(16).fill(3), footprint: Array.from({ length: 16 }, (_, k) => [14 + 3 * Math.cos(k * Math.PI / 8), 3 * Math.sin(k * Math.PI / 8)]) };
        fs.writeFileSync(path.join(dir, 'crowns.json'), JSON.stringify({ version: 1, crowns: [crown] }));
        const blob: number[] = [];
        for (let k = 0; k < 40; k++) { const a = (k * Math.PI) / 20, y = 3 + (k % 7); blob.push(14 + 2 * Math.cos(a), y, 2 * Math.sin(a), 14 + 2 * Math.cos(a + 0.1), y, 2 * Math.sin(a + 0.1), 14, y + 0.5, 0); }
        soupGlb(path.join(dir, 'removed.glb'), Float32Array.from(blob));
        const t = measureTrees(path.join(dir, 'crowns.json'), path.join(dir, 'removed.glb'), () => true, (x) => x < 5);
        expect(t.report.crowns[0].heightM).toBe(9);
        expect(t.report.crowns[0].crownBaseM).toBeCloseTo(3, 0);
        expect(t.report.crowns[0].crownBaseSource).toBe('removed-triangles');
        expect(t.report.crowns[0].crownWidthM).toBeCloseTo(6, 5);
        expect(t.report.stripRemovedNear.triangles).toBe(40);
        expect(t.report.stripRemovedInsideFootprint.triangles).toBe(0);
        expect(t.crownLines.length).toBe(1);
        // the isolate: the building, 30 tree triangles left in the crown (outside the footprint), 4 inside the footprint's
        // corner that the crown overlaps (kept and counted), and ground
        const bldg = await buildSoup({ elements: [{ label: 'b', prism: { outline: { rect: { centerU: 0, centerV: 0, lengthU: 10, widthV: 10 } }, baseM: 0, topM: 8 } }] }, path.join(dir, 'b'));
        const tree: number[] = [];
        for (let k = 0; k < 30; k++) { const y = 4 + (k % 4); tree.push(14 + (k % 5) * 0.3, y, -1 + (k % 3) * 0.5, 14.5 + (k % 5) * 0.3, y + 0.4, -1 + (k % 3) * 0.5, 14.2, y + 0.2, -0.5); }
        const isoSoup = new Float32Array(bldg.soup.length + tree.length + 9);
        isoSoup.set(bldg.soup); isoSoup.set(tree, bldg.soup.length);
        isoSoup.set([-20, 0.1, -20, 20, 0.1, -20, 20, 0.1, 20], bldg.soup.length + tree.length);
        const glb = path.join(dir, 'iso.glb');
        soupGlb(glb, isoSoup);
        const crownWide = `crown 7 3 9 4 4 -6 30 -6 30 6 4 6`;  // a crown polygon reaching 1 m into the building (x >= 4)
        const fp = 'footprint 4 -5 -5 5 -5 5 5 -5 5';
        const scanDir = path.join(dir, 'scan');
        await runShapeTool(`mode scan\nout ${scanDir}\nisolate ${glb}\nground 0\n${fp}\n${crownWide}\n`, scanDir);
        const scan = JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8'));
        expect(scan.classes.tree.triangles).toBe(30);
        expect(scan.classes.ground.triangles).toBe(3);  // the apron and the building's bottom
        expect(scan.classes.treeInsideFootprintKept.triangles).toBeGreaterThan(0);  // building wall triangles in the crown's plan are kept, not deleted
        expect(scan.classes.building.triangles + scan.classes.tree.triangles + scan.classes.ground.triangles).toBe(scan.classes.total);
        expect(scan.tiers[0].topY).toBeCloseTo(8, 0);
    }, 120_000);
});
