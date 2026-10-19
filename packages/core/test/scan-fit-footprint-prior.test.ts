/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan fitter on an ordinary city building (scratchbox_scan_fit.hpp through ScanFitService, compiled with clang++): a
 * flat-roofed block with a setback, a 12 m neighbour against one side (a party wall the scan cannot see), the scan arriving in
 * two tile pieces 2 cm apart, turned 29 degrees off east, with the footprint prior the vector data would give (its plan 0.6 m
 * off the scanned facades, the neighbour's plan and height).
 *
 * - With the prior the fit is accepted: both tile pieces are fitted, the plan's walls move onto the scan's measured walls, the
 *   roof levels are measured (15 m and 21 m), and the faces against the neighbour are labelled party walls and kept out of the
 *   unobserved share.
 * - Without the prior the same scan is rejected: the party wall counts as unobserved.
 * - The gates stay honest: with a large rounded mass on the roof that no plan explains, the prior does not get the fit accepted.
 *
 * Clay renders of each fit over its scan go to test-results/screenshots/fit_ordinary/ (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { validateContract, type StructureFit } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { saveClayShot } from './helpers/staged-shots';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };
const SHOTS = path.join(REPO, 'test-results', 'screenshots', 'fit_ordinary');

let work: string;
let svc: ScanFitService;
let scene: ReturnType<typeof S.partyWallSetback>;
let massed: ReturnType<typeof S.partyWallSetback>;

const rel = (f: string) => path.relative(work, f);
const param = (p: StructureFit['primitives'][number], i: number) => p.fitParams.find(f => f.index === i)!.value;

/** Shoelace area and a point-in-polygon test, for the footprint against the truth. */
const area = (poly: number[][]) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
function inside(poly: number[][], x: number, z: number): boolean {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i][1] > z) !== (poly[j][1] > z) && x < ((poly[j][0] - poly[i][0]) * (z - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
    return c;
}
/** IoU of the fitted footprint with the scanned block's true plan (24 x 16 m, turned by the yaw), on a 10 cm lattice. */
function iouWithTruth(outer: number[][], yawDeg: number): number {
    const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let i = 0, u = 0;
    for (let x = -20; x <= 20; x += 0.1) for (let z = -20; z <= 20; z += 0.1) {
        const lx = x * c - z * s, lz = x * s + z * c;   // the inverse of the scene's turn
        const t = lx >= -12 && lx <= 12 && lz >= -8 && lz <= 8, f = inside(outer, x, z);
        if (t && f) i++;
        if (t || f) u++;
    }
    return i / u;
}

function shot(name: string, scanGlb: string, f: StructureFit): void {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [view, bearing, elev] of [['oblique', 215, 25], ['back', 35, 20]] as Array<[string, number, number]>) {
        const s = saveClayShot(`../fit_ordinary/${name}_${view}`, [{ file: scanGlb, color: [0.72, 0.72, 0.74] }, { file: f.outputs.fittedGlb, color: [0.35, 0.55, 0.85] }], { bearingDeg: bearing, elevationDeg: elev });
        expect(s.covered).toBeGreaterThan(0.03);
    }
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fit-prior-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
    const dir = path.join(work, 'scenes');
    fs.mkdirSync(dir);
    scene = S.partyWallSetback(dir);
    massed = S.partyWallSetback(dir, { roofMass: true, name: 'synthetic_party_setback_mass' });
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('scan_fit on an ordinary building: a setback, a party wall and a tile seam', () => {
    it('with the vector footprint as its prior, is accepted: both tile pieces fitted, the walls moved onto the scan, the roof levels measured, the party wall labelled', async () => {
        const r = await svc.fit({ scanGlb: rel(scene.glb), anchor: { x: scene.anchor[0], z: scene.anchor[1] }, sourceLimits: LIMITS, prior: scene.prior });
        const f = r.value;
        expect(validateContract('StructureFit', f)).toEqual([]);
        expect(f.accepted).toBe(true);
        // both tile pieces: every triangle of the scan is fitted against, not the piece under the anchor alone
        expect(f.input.scanTriangles).toBe(readGlbTriangles(fs.readFileSync(scene.glb)).indices.length / 3);
        // the prior traced the plan; the levels are the scan's own, to 5 cm
        expect(f.input.footprintPrior).toMatchObject({ source: 'synthetic vector data', used: true, neighbours: 2, heightM: 21 });
        expect(f.input.footprintPrior!.roofLevelsM).toHaveLength(2);
        expect(Math.abs(f.input.footprintPrior!.roofLevelsM[0] - 15)).toBeLessThan(0.05);
        expect(Math.abs(f.input.footprintPrior!.roofLevelsM[1] - 21)).toBeLessThan(0.05);
        // two bands: 0..15 m over the whole plan (384 m2), 15..21 m over the part left by the setback (240 m2)
        const bands = f.primitives.filter(p => p.label === 'swept footprint').sort((a, b) => param(a, 0) - param(b, 0));
        expect(bands).toHaveLength(2);
        expect(Math.abs(param(bands[0], 1) - param(bands[0], 0) - 15)).toBeLessThan(0.1);
        expect(Math.abs(param(bands[0], 2) - 384)).toBeLessThan(6);
        expect(Math.abs(param(bands[1], 2) - 240)).toBeLessThan(6);
        // the plan 0.6 m off the scan: the measured walls put the footprint back on the block
        expect(Math.abs(f.footprint.areaM2 - 384)).toBeLessThan(6);
        expect(iouWithTruth(f.footprint.outer, scene.truth.yawDeg as number)).toBeGreaterThan(0.97);
        expect(f.input.footprintPrior!.fittedIoU).toBeLessThan(0.97);   // ...which the prior alone was not
        // the face against the neighbour: labelled a party wall, unobserved there, and not counted against the gate
        const party = f.surfaces.filter(s => s.partyWall);
        expect(party.length).toBeGreaterThan(0);
        for (const s of party) expect(s.provenance.note).toMatch(/party wall/);
        expect(f.metrics.partyWallAreaM2!).toBeGreaterThan(150);
        expect(f.metrics.unobservedShare!).toBeLessThan(0.1);
        // the strip of the neighbour's roof the isolate reached is the neighbour's, not this building's
        expect(f.metrics.neighbourScanAreaM2!).toBeGreaterThan(10);
        expect(f.gates.every(g => g.passed)).toBe(true);
        shot('synthetic_party_setback_prior', scene.glb, f);
    }, 300_000);

    it('without the prior, the same scan is rejected: the party wall counts as unobserved', async () => {
        const f = (await svc.fit({ scanGlb: rel(scene.glb), anchor: { x: scene.anchor[0], z: scene.anchor[1] }, sourceLimits: LIMITS })).value;
        expect(f.accepted).toBe(false);
        expect(f.input.footprintPrior).toBeUndefined();
        const unobserved = f.gates.find(g => g.gate.startsWith('unobserved share'))!;
        expect(unobserved.passed).toBe(false);
        shot('synthetic_party_setback_noprior', scene.glb, f);
    }, 300_000);

    it('keeps its gates: a large rounded mass on the roof that the plan does not explain is not accepted, prior or not', async () => {
        const f = (await svc.fit({ scanGlb: rel(massed.glb), anchor: { x: massed.anchor[0], z: massed.anchor[1] }, sourceLimits: LIMITS, prior: massed.prior })).value;
        expect(f.input.footprintPrior!.used).toBe(true);
        expect(f.accepted).toBe(false);
        expect(f.gates.filter(g => !g.passed).map(g => g.gate).join('; ')).toMatch(/kept as scanned|Hausdorff|scan→fit/);
        shot('synthetic_party_setback_roof_mass', massed.glb, f);
    }, 300_000);
});
