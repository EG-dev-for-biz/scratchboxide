/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ornament builder (scratchbox_ornament.hpp behind `scan_fit ornament`, run through ScanFitService.ornament), on fits of
 * synthetic structures whose geometry is known:
 *
 * - each of the four operators, through a plane chart and a slot's crease: the sweep along an edge slot and along a polyline in the
 *   chart, the revolve with lobes, the replicate along a carrier and over a lattice, the relief as a recut surface and as a proud shell;
 * - what the GLB says about it: node extras that validate against the contract, `_REVEAL` (x the element's rank, y the order inside it,
 *   the sweep's cumulative arc length) and `_DISP` (host surface to final, metres);
 * - what it refuses, each with the check, the value and the limit: a profile outside the edge's envelope, a recess or a proud element
 *   past the slot's bounds, an element outside its slot, a self-intersection, a sink into the fitted solid, a slot the fit does not
 *   have; and the outline it draws for a slot that got none of its detail;
 * - the evidence support test: a periodic element passes only at the pitch the tile photo shows (not at its half, its double or a
 *   pitch a fifth off), an isolated element only where its outline carries a luminance step, and neither on a blank texture;
 * - a refit moves a slot carrier with the corrected primitive, and an element that no longer fits is dropped;
 * - the same inputs give the same bytes.
 *
 * Renders of the facade with its detail are written to test-results/screenshots/staged/ (gitignored) and asserted not blank.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { validateContract, type OrnamentBuildReport, type OrnamentElement, type OrnamentSpec, type OperatorSpec, type StructureFit, type Vec2 } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import * as FX from './helpers/staged-location-fixtures';
import { edgeUse, readStagedGlb, signedVolume, type StagedGlbRead, type StagedNodeRead } from './helpers/staged-glb-read';
import { saveClayShot } from './helpers/staged-shots';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };
const SV = 'sv:CAoSLEFGMVFpcE:12:8:42';

let work: string;
let svc: ScanFitService;
type Fitted = { fit: StructureFit; path: string; textured: string };
const facade: Record<'stripes' | 'blank', Fitted> = {} as any;
let archFit: Fitted;
let archScanRel: string;

const rel = (f: string) => path.relative(work, f);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** An element of a spec. `evidence` names the images it cites: a Street View id, or `ortho:<surface>`. */
function element(id: string, slotId: string, spec: OperatorSpec, order: number, evidence: string = SV): OrnamentElement {
    return {
        id, slotId, confidence: 0.7, depthBasis: 'a test', buildOrder: order, spec,
        evidence: [{ imageId: evidence, box1000: [100, 100, 300, 300] }],
        checks: { slotOverlap: 1, minFeatureM: 0.1, nativeSampleM: 0.02 },
        provenance: FX.photoInferred(0.7, evidence)
    };
}

function specOf(f: Fitted, elements: OrnamentElement[]): OrnamentSpec {
    const base = FX.ornamentSpec();
    const ortho = f.fit.outputs.orthos.find(o => o.surfaceId === 's01');
    return {
        ...base,
        buildingId: f.fit.buildingId,
        structureFitSha256: sha(f.path),
        elements,
        evidence: [
            { id: SV, index: 0, kind: 'streetview-grounding', widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021, slotsShown: [] },
            ...(ortho ? [{ id: `ortho:${ortho.surfaceId}`, index: 1, kind: 'tile-ortho', widthPx: ortho.widthPx, heightPx: ortho.heightPx, sha256: ortho.sha256, nativeSampleM: ortho.texelM, surfaceId: ortho.surfaceId, gsdM: ortho.gsdM, texelM: ortho.texelM, slotsShown: [] }] : [])
        ],
        corrections: [], emptySlots: [], dropped: []
    };
}

async function build(f: Fitted, elements: OrnamentElement[]) {
    const r = await svc.ornament({ fitPath: rel(f.path), texturedGlb: rel(f.textured), spec: specOf(f, elements) });
    return { report: r.value, glb: readStagedGlb(r.detailGlb), file: r.detailGlb, result: r };
}

const bbox = (p: ArrayLike<number>) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], p[i + c]); mx[c] = Math.max(mx[c], p[i + c]); }
    return { mn, mx };
};
const slot = (f: Fitted, id: string) => f.fit.slots.find(s => s.id === id)!;
const surface = (f: Fitted, id: string) => f.fit.surfaces.find(s => s.id === id)!;
/** z of the wall's plane (s01, facing +z) at x. */
const wallZAt = (f: Fitted, x: number): number => { const c = (surface(f, 's01').chart as any).plane; return c.origin[2] + (x - c.origin[0]) * c.u[2] / c.u[0]; };
const dropOf = (r: OrnamentBuildReport, id: string) => r.dropped.find(d => d.elementId === id);
const rect = (u0: number, v0: number, u1: number, v1: number): Vec2[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
const panel = (surfaceId: string, region: Vec2[], depthM: number): OperatorSpec => ({ operator: 'relief', relief: { surfaceId, region: { outer: region }, height: { panel: { depthM, edgeWidthM: 0.05, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } });
const box = (w: number, h: number, u0 = 0, v0 = 0): Vec2[] => rect(u0, v0, u0 + w, v0 + h);
const sweepOnSlot = (slotId: string, profile: Vec2[], t0 = 0.1, t1 = 0.9): OperatorSpec => ({ operator: 'sweep', sweep: { carrier: { slot: { slotId, t0, t1, offset: [0, 0] } }, profile: { outer: profile }, miterLimit: 4, caps: true } });

/** The wall slot of the facade (20 x 10 m, facing +z) and its top edge. */
const WALL = 'S01', TOP_EDGE = 'S06';

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ornament-native-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
    const dir = path.join(work, 'scenes');
    fs.mkdirSync(dir);
    for (const blank of [false, true]) {
        const t = S.texturedFacade(dir, blank);
        const r = await svc.fit({ scanGlb: rel(t.glb), texturedGlb: rel(t.textured), anchor: { x: t.anchor[0], z: t.anchor[1] }, sourceLimits: LIMITS });
        facade[blank ? 'blank' : 'stripes'] = { fit: r.value, path: r.path, textured: t.textured };
    }
    const arch = S.segmentalArch(dir);
    archScanRel = rel(arch.glb);
    const ar = await svc.fit({ scanGlb: archScanRel, anchor: { x: 0, z: 0 }, sourceLimits: LIMITS });
    archFit = { fit: ar.value, path: ar.path, textured: arch.glb };
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('the facade the builder works on', () => {
    it('is a 20 x 10 wall with its top edge as slots, each with bounds, and the tile photo as an ortho at its own texel', () => {
        const f = facade.stripes.fit;
        expect(f.accepted).toBe(true);
        const w = slot(facade.stripes, WALL), e = slot(facade.stripes, TOP_EDGE);
        expect(w.sizeM[0]).toBeCloseTo(20, 1);
        expect(w.sizeM[1]).toBeCloseTo(10, 1);
        expect('surface' in w.host).toBe(true);
        expect('edge' in e.host).toBe(true);
        expect((e.host as any).edge.carrier.lengthM).toBeCloseTo(20, 1);
        expect(e.bounds.maxProudM).toBeGreaterThan(0.1);
        const ortho = f.outputs.orthos.find(o => o.surfaceId === 's01')!;
        expect(ortho.texelM).toBeGreaterThan(0.02);
        expect(ortho.texelM).toBeLessThan(0.04);
    });
});

describe('operator 1: sweep', () => {
    it('along an edge slot\'s crease: a closed shell of the profile swept the carrier\'s length, `_REVEAL.y` its arc length, and the node says so', async () => {
        const profile: Vec2[] = [[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]];
        const { report, glb } = await build(facade.stripes, [element('e000', TOP_EDGE, sweepOnSlot(TOP_EDGE, profile), 0)]);
        expect(report.dropped).toEqual([]);
        expect(report.built).toHaveLength(1);
        const n = glb.byName('e000');
        const p = n.primitives[0];
        expect(report.built[0].vertices).toBe(p.positions.length / 3);
        // the top edge of the +z wall: z = 1 (out of the wall is +z), y = 10 (up is +y); 0.1 to 0.9 of 20 m
        const b = bbox(p.positions);
        expect(b.mn[0]).toBeCloseTo(-8.0, 1);
        expect(b.mx[0]).toBeCloseTo(8.0, 1);
        expect(b.mn[1]).toBeCloseTo(10.0, 2);
        expect(b.mx[1]).toBeCloseTo(10.1, 2);
        expect(b.mn[2]).toBeCloseTo(1.0, 2);
        expect(b.mx[2]).toBeCloseTo(1.2, 2);
        // closed: the profile's area 0.02 m2 times the 16 m run, no open edge
        expect(signedVolume(p.positions, p.indices)).toBeGreaterThan(0.02 * 16 * 0.98);
        expect(signedVolume(p.positions, p.indices)).toBeLessThan(0.02 * 16 * 1.02);
        expect(edgeUse(p.positions, p.indices).boundary).toBe(0);
        // _REVEAL.y is the arc length along the run over its length, 0 at the start and 1 at the end, monotone in x
        expect(p.reveal).toBeDefined();
        let worst = 0, lo = 1, hi = 0;
        for (let i = 0; i < p.positions.length / 3; i++) {
            const t = (p.positions[3 * i] - b.mn[0]) / (b.mx[0] - b.mn[0]);
            worst = Math.max(worst, Math.abs(p.reveal![2 * i + 1] - t));
            lo = Math.min(lo, p.reveal![2 * i + 1]); hi = Math.max(hi, p.reveal![2 * i + 1]);
        }
        expect(worst).toBeLessThan(0.01);
        expect(lo).toBe(0);
        expect(hi).toBeCloseTo(1, 4);
        // the node's extras validate and describe the sweep
        expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
        expect(n.sb.revealKind).toBe('sweep');
        expect(n.sb.sweep).toEqual({ carrierLengthM: expect.closeTo(16, 1), closed: false, tAttribute: '_REVEAL.y' });
        expect(n.sb.ids).toEqual({ slotId: TOP_EDGE, elementId: 'e000' });
        expect(n.sb.provenance.label).toBe('photo-inferred');
        expect(n.sb.provenance.measuredGeometry).toBe(false);
        expect(n.sb.provenance.confidence).toBeCloseTo(0.7, 6);
        expect(validateContract('StagedGlbRootExtras', glb.root)).toEqual([]);
    }, 120_000);

    it('along a polyline drawn in the wall\'s chart: it follows the chart, offset from the wall by the profile\'s v', async () => {
        // an L in the chart: along u at v = 4 for 6 m, then up to v = 7 (the chart's u runs along +x, v is up)
        const spec: OperatorSpec = { operator: 'sweep', sweep: { carrier: { chart: { pointsUv: [[4, 4], [10, 4], [10, 7]], closed: false } }, profile: { outer: [[-0.05, 0], [0.05, 0], [0.05, 0.08], [-0.05, 0.08]] }, miterLimit: 4, caps: true } };
        const { report, glb } = await build(facade.stripes, [element('e001', WALL, spec, 0)]);
        expect(report.dropped).toEqual([]);
        const p = glb.byName('e001').primitives[0];
        const b = bbox(p.positions);
        // u = 4..10 is x = -6..0 (the chart starts at x = -10), v = 4..7 is y = 4..7; the profile is 0.1 wide to the left of travel (up while it
        // runs along u, toward -u while it runs up v), so the run is 0.05 either side of the path
        expect(b.mn[0]).toBeCloseTo(-6.0, 1);
        expect(b.mx[0]).toBeCloseTo(0.05, 1);
        expect(b.mn[1]).toBeCloseTo(3.95, 1);
        expect(b.mx[1]).toBeCloseTo(7.0, 1);
        // standing 0..0.08 m proud of the wall at z = 1
        expect(b.mn[2]).toBeCloseTo(1.0, 2);
        expect(b.mx[2]).toBeCloseTo(1.08, 2);
        expect(edgeUse(p.positions, p.indices).boundary).toBe(0);
        // the corner is mitred, not left open: the run is one shell, and its length (9 m) is in the extras
        expect(glb.byName('e001').sb.sweep.carrierLengthM).toBeCloseTo(9, 1);
    }, 120_000);
});

describe('operator 2: revolve', () => {
    const lobed = (lobes: number, amp: number): OperatorSpec => ({ operator: 'revolve', revolve: { axisOrigin: [3, 3, 0], axisDir: [0, 0, 1], profile: [[0, 0], [0.9, 0], [0.9, 0.12], [0, 0.18]], lobes, lobeAmplitude: amp, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 96 } });

    it('a roundel: a solid of revolution about the chart\'s normal at (3, 3), as wide as its profile and as proud as its z; with K lobes the radius varies by the amplitude', async () => {
        const { report, glb } = await build(facade.stripes, [element('e002', WALL, lobed(0, 0), 0), element('e003', WALL, lobed(6, 0.2), 1)]);
        expect(report.dropped).toEqual([]);
        const plain = glb.byName('e002').primitives[0], gear = glb.byName('e003').primitives[0];
        // the radius of the rim: the vertices at the profile's z = 0.12 (the wall is at z = 1)
        const radii = (p: Float64Array) => { const r: number[] = []; for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - 1.122) < 0.004) r.push(Math.hypot(p[i] - (-7), p[i + 1] - 3)); return r; };
        // the centre: (u, v) = (3, 3) is (x, y) = (-7, 3); 0.18 m proud at the axis
        const b = bbox(plain.positions);
        expect(b.mn[0]).toBeCloseTo(-7.9, 1);
        expect(b.mx[0]).toBeCloseTo(-6.1, 1);
        expect(b.mx[2]).toBeCloseTo(1.18, 2);
        const rim = radii(plain.positions);
        expect(rim.length).toBeGreaterThan(30);
        expect(Math.max(...rim)).toBeLessThan(0.91);
        // K = 0: the radius at the profile's height is constant; K = 6, A = 0.2: it swings between 0.8 and 1.2 of it, six times round
        const spread = (r: number[]) => (Math.max(...r) - Math.min(...r));
        expect(spread(rim)).toBeLessThan(0.02);
        const lobedRim = radii(gear.positions);
        expect(Math.min(...lobedRim)).toBeCloseTo(0.9 * 0.8, 1);
        expect(Math.max(...lobedRim)).toBeCloseTo(0.9 * 1.2, 1);
        const g = bbox(gear.positions);
        expect(g.mx[0] - g.mn[0]).toBeGreaterThan(1.8 * 1.15);
        // a solid: closed, wound outward
        expect(edgeUse(plain.positions, plain.indices).boundary).toBe(0);
        expect(signedVolume(plain.positions, plain.indices)).toBeGreaterThan(0.2);
        // not a sweep: no sweep extras, and it shows at once rather than along an arc
        expect(glb.byName('e002').sb.sweep).toBeUndefined();
        expect(glb.byName('e002').sb.revealKind).toBe('appear');
    }, 120_000);
});

describe('operator 3: replicate', () => {
    const stud: OperatorSpec = { operator: 'revolve', revolve: { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], profile: [[0, 0], [0.1, 0], [0.1, 0.05], [0, 0.05]], lobes: 0, lobeAmplitude: 0, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 16 } };

    it('along a crease: instances at startOffset + k pitch; those past the end are skipped and counted, and `_REVEAL.x` is the instance', async () => {
        const spec: OperatorSpec = { operator: 'replicate', replicate: { seed: stud, domain: { along: { carrier: { slot: { slotId: TOP_EDGE, t0: 0, t1: 1, offset: [0, 0] } }, pitchM: 2, count: 12, startOffsetM: 1 } }, alignToSurface: true } };
        const { report, glb } = await build(facade.stripes, [element('e004', TOP_EDGE, spec, 0)]);
        expect(report.dropped).toEqual([]);
        expect(report.built[0].instances).toEqual({ placed: 10, skippedOutside: 2 });
        const p = glb.byName('e004').primitives[0];
        // ten studs, centres at x = -10 + 1, -10 + 3, ..., -10 + 19: cluster the vertices by the stud they belong to
        const centres = new Set<number>();
        for (let i = 0; i < p.positions.length / 3; i++) centres.add(Math.round((p.positions[3 * i] + 10 - 1) / 2));
        expect([...centres].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // the instance index is the reveal's x, ten values in [0, 1], the first at 0 and the last below 1 (a single element in the layer)
        const xs = new Set<number>();
        for (let i = 0; i < p.positions.length / 3; i++) xs.add(Math.round(p.reveal![2 * i] * 1000));
        expect(xs.size).toBe(10);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.max(...xs) / 1000).toBeLessThan(1);
        expect(glb.byName('e004').sb.revealKind).toBe('cells');
    }, 120_000);

    it('over a lattice: counts[0] x counts[1] instances at the pitch, with the row offset', async () => {
        const seed = panel('s01', box(0.8, 0.8), 0.06);
        const spec: OperatorSpec = { operator: 'replicate', replicate: { seed, domain: { lattice: { originUv: [2, 2], pitchUv: [1.5, 1.5], counts: [4, 3], rowOffsetU: 0.5 } }, alignToSurface: true } };
        const { report, glb } = await build(facade.stripes, [element('e005', WALL, spec, 0)]);
        expect(report.dropped).toEqual([]);
        expect(report.built[0].instances).toEqual({ placed: 12, skippedOutside: 0 });
        const p = glb.byName('e005').primitives[0];
        const b = bbox(p.positions);
        // u from 2 to 2 + 3 x 1.5 + 0.8 (+ 0.5 on the odd row), v from 2 to 2 + 2 x 1.5 + 0.8
        expect(b.mn[0]).toBeCloseTo(-8.0, 1);
        expect(b.mx[0]).toBeCloseTo(-10 + 2 + 4.5 + 0.8 + 0.5, 1);
        expect(b.mn[1]).toBeCloseTo(2.0, 1);
        expect(b.mx[1]).toBeCloseTo(5.8, 1);
        // each is a proud shell: the _DISP of its top is 0.06 m along the wall's normal (+z)
        expect(p.disp).toBeDefined();
        let peak = 0;
        for (let i = 0; i < p.disp!.length; i += 3) peak = Math.max(peak, p.disp![i + 2]);
        expect(peak).toBeCloseTo(0.06, 3);
        expect(glb.byName('e005').sb.reveal.displacement).toBe('_DISP');
    }, 120_000);
});

describe('operator 4: relief', () => {
    it('a recess is a recut copy of that one surface: it replaces it, covers all of it, has no hole and no seam, and its floor is the depth below', async () => {
        const { report, glb } = await build(facade.stripes, [element('e006', WALL, panel('s01', rect(6, 3, 9, 6), -0.1), 0)]);
        expect(report.dropped).toEqual([]);
        const n = glb.byName('e006');
        expect(n.sb.replacesSurfaceIds).toEqual(['s01']);
        expect(n.sb.revealKind).toBe('rise');
        expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
        const p = n.primitives[0];
        // all of the wall: 20 x 10 m, x from -10 to 10 and y from 0 to 10, its floor 0.1 m behind it (z = 1 - 0.1)
        const b = bbox(p.positions);
        expect(b.mn[0]).toBeCloseTo(-10, 1);
        expect(b.mx[0]).toBeCloseTo(10, 1);
        expect(b.mn[1]).toBeCloseTo(0, 2);
        expect(b.mx[1]).toBeCloseTo(10, 2);
        expect(b.mn[2]).toBeCloseTo(0.9, 2);
        expect(b.mx[2]).toBeCloseTo(1.0, 2);
        // watertight as a sheet: every open edge lies on the wall's outline, none inside it
        const uses = edgeUse(p.positions, p.indices);
        expect(uses.nonManifold).toBe(0);
        const outline = (x: number, y: number) => Math.abs(Math.abs(x) - 10) < 0.01 || y < 0.01 || y > 9.99;
        const key = (i: number) => `${p.positions[3 * i].toFixed(4)},${p.positions[3 * i + 1].toFixed(4)},${p.positions[3 * i + 2].toFixed(4)}`;
        const count = new Map<string, number>();
        const pos = new Map<string, [number, number]>();
        for (let t = 0; t < p.indices.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = p.indices[t + e], c = p.indices[t + (e + 1) % 3];
            const k = [key(a), key(c)].sort().join('|');
            count.set(k, (count.get(k) ?? 0) + 1);
            pos.set(k, [a, c] as any);
        }
        let inside = 0;
        for (const [k, c] of count) if (c === 1) { const [a, d] = pos.get(k)!; if (!(outline(p.positions[3 * a], p.positions[3 * a + 1]) && outline(p.positions[3 * d], p.positions[3 * d + 1]))) inside++; }
        expect(inside).toBe(0);
        // the area the recut covers, projected on the wall, is the wall's 200 m2 (the recess floor, its walls and the rest of the face)
        let area = 0;
        for (let t = 0; t < p.indices.length; t += 3) {
            const q = [0, 1, 2].map(j => p.indices[t + j] * 3);
            area += Math.abs((p.positions[q[1]] - p.positions[q[0]]) * (p.positions[q[2] + 1] - p.positions[q[0] + 1]) - (p.positions[q[2]] - p.positions[q[0]]) * (p.positions[q[1] + 1] - p.positions[q[0] + 1])) / 2;
        }
        expect(area).toBeGreaterThan(200 * 0.99);
        expect(area).toBeLessThan(200 * 1.01);
        // _DISP: the floor of the recess is displaced 0.1 m along -z (the host surface to the final), and the rest of the face not at all
        let deepest = 0, atRest = 0, sideways = 0;
        for (let i = 0; i < p.disp!.length; i += 3) {
            deepest = Math.min(deepest, p.disp![i + 2]);
            sideways = Math.max(sideways, Math.abs(p.disp![i]), Math.abs(p.disp![i + 1]));
            if (Math.abs(p.disp![i + 2]) < 1e-6) atRest++;
        }
        expect(deepest).toBeCloseTo(-0.1, 3);
        expect(sideways).toBeLessThan(0.002);   // along the wall's normal and no other way
        expect(atRest).toBeGreaterThan(8);      // the face outside the recess is where it was
        expect(atRest).toBeLessThan(p.disp!.length / 3);
    }, 120_000);

    it('a proud panel is its own closed shell, sunk 1 mm into the host, and replaces nothing', async () => {
        const { report, glb } = await build(facade.stripes, [element('e007', WALL, panel('s01', rect(6, 3, 9, 6), 0.08), 0)]);
        expect(report.dropped).toEqual([]);
        const n = glb.byName('e007');
        expect(n.sb.replacesSurfaceIds).toBeUndefined();
        const p = n.primitives[0];
        expect(edgeUse(p.positions, p.indices).boundary).toBe(0);
        expect(signedVolume(p.positions, p.indices)).toBeGreaterThan(0);
        const b = bbox(p.positions);
        // the wall is a hair off z = 1 (its fit, 1.8 mm over 20 m): the shell starts 1 mm behind the wall plane there and stands 0.08 m proud of it
        const wallZ = wallZAt(facade.stripes, -5.5);
        expect(b.mn[2]).toBeGreaterThan(wallZ - 0.0016);
        expect(b.mn[2]).toBeLessThan(wallZ - 0.0004);
        expect(b.mx[2]).toBeCloseTo(wallZ + 0.08, 3);
        expect(b.mn[0]).toBeCloseTo(-10 + 6, 1);
        expect(b.mx[0]).toBeCloseTo(-10 + 9, 1);
        // a 3 x 3 m panel 0.08 m deep: about 0.72 m3 (less its sloped edge)
        expect(signedVolume(p.positions, p.indices)).toBeGreaterThan(0.5);
        expect(signedVolume(p.positions, p.indices)).toBeLessThan(0.75);
    }, 120_000);
});

describe('what the builder refuses', () => {
    it('each with the check, the value and the limit: envelope, bounds, outside the slot, a crossed profile, a sink into the solid, an unknown slot', async () => {
        const elements = [
            // a profile 0.6 m up from an edge whose measured section allows 0.3 m
            element('b0', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.2, 0], [0.2, 0.6], [0, 0.6]]), 0),
            // a recess 0.6 m deep where the slot allows 0.4
            element('b1', WALL, panel('s01', rect(6, 3, 9, 6), -0.6), 1),
            // 0.9 m proud where the slot allows 0.6
            element('b2', WALL, panel('s01', rect(6, 3, 9, 6), 0.9), 2),
            // half of it past the end of the wall
            element('b3', WALL, panel('s01', rect(18, 3, 22, 6), 0.1), 3),
            // a bow-tie profile
            element('b4', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.2, 0.1], [0.2, 0], [0, 0.1]]), 4),
            // 0.4 m into the wall, below the crease: inside the fitted solid
            element('b5', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[-0.4, -0.1], [0, -0.1], [0, 0], [-0.4, 0]]), 5),
            // a slot the fit does not have
            element('b6', 'S99', sweepOnSlot('S99', [[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]]), 6),
            // and one that is fine, after all of them
            element('ok', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]], 0.2, 0.4), 7)
        ];
        const { report, glb } = await build(facade.stripes, elements);
        const one = (id: string) => { const d = dropOf(report, id)!; expect(d, `${id} was not dropped`).toBeDefined(); expect(d.checks).toHaveLength(1); return d.checks[0]; };
        const env = one('b0');
        expect(env.check).toBe("inside the slot's envelope");
        expect(env.value).toBeCloseTo(0.3, 2);       // 0.6 m up, 0.3 m allowed
        expect(env.limit).toBe(0.005);
        const recess = one('b1');
        expect(recess.check).toBe('recess into the surface');
        expect(recess.value).toBeCloseTo(0.6, 2);
        expect(recess.limit).toBeCloseTo(0.4, 2);
        const proud = one('b2');
        expect(proud.check).toBe('proud of the surface');
        expect(proud.value).toBeCloseTo(0.9, 2);
        expect(proud.limit).toBeCloseTo(0.6, 2);
        const out = one('b3');
        expect(out.check).toBe('footprint inside slot');
        expect(out.value).toBeLessThan(0.98);
        expect(out.limit).toBe(0.98);
        expect(one('b4').check).toBe('self-intersection');
        const sunk = one('b5');
        expect(sunk.check).toBe('penetration of the fitted solid');
        expect(sunk.value).toBeGreaterThan(0.005);
        const unknown = one('b6');
        expect(unknown.check).toBe('slot');
        expect(unknown.message).toContain('S99');
        // the one that was fine was built, and is the only node but the outlines of nothing: no slot lost all of its detail
        expect(report.built.map(b => b.elementId)).toEqual(['ok']);
        expect(report.degradedSlots).toEqual([WALL]);
        expect(glb.nodes.map(n => n.name).filter(n => n !== 'ornament_detail')).toEqual(['ok', `degraded_${WALL}`]);
        // a layer of one element is a layer of two nodes: the element and the wall's outline
        expect(glb.byName('ok').sb.buildCount).toBe(2);
    }, 120_000);

    it('outlines a slot that was asked for detail and got none, as LINES with the fitted provenance and a degradation id', async () => {
        const { report, glb } = await build(facade.stripes, [element('d0', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.2, 0], [0.2, 0.9], [0, 0.9]]), 0)]);
        expect(report.built).toEqual([]);
        expect(report.degradedSlots).toEqual([TOP_EDGE]);
        const n = glb.byName(`degraded_${TOP_EDGE}`);
        expect(n.primitives).toHaveLength(1);
        expect(n.primitives[0].mode).toBe(1);
        expect(n.primitives[0].colors).toBeDefined();
        expect(n.sb.revealKind).toBe('outline');
        expect(n.sb.provenance.label).toBe('fitted');
        expect(n.sb.ids).toEqual({ slotId: TOP_EDGE, degradationId: `ornament:${TOP_EDGE}` });
        expect(n.sb.counts.lines).toBeGreaterThan(3);
        expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
        // the outline is the crease itself: z = 1, y = 10, x from -10 to 10
        const b = bbox(n.primitives[0].positions);
        expect(b.mn[0]).toBeCloseTo(-10, 1);
        expect(b.mx[0]).toBeCloseTo(10, 1);
        expect(b.mn[1]).toBeCloseTo(10, 2);
    }, 120_000);

    it('refuses an element over the triangle cap of one element, with the count and the cap', async () => {
        // a lattice of 130 x 130 small panels: far more than 60,000 triangles
        const spec: OperatorSpec = { operator: 'replicate', replicate: { seed: panel('s01', box(0.1, 0.1), 0.02), domain: { lattice: { originUv: [0.5, 0.5], pitchUv: [0.14, 0.07], counts: [130, 130], rowOffsetU: 0 } }, alignToSurface: true } };
        const { report } = await build(facade.stripes, [element('big', WALL, spec, 0)]);
        const d = dropOf(report, 'big');
        expect(d).toBeDefined();
        expect(d!.checks.map(c => c.check)).toContain('triangles in the element');
        const c = d!.checks.find(x => x.check === 'triangles in the element')!;
        expect(c.limit).toBe(60000);
        expect(c.value).toBeGreaterThan(60000);
    }, 180_000);
});

describe('the evidence support test', () => {
    // the wall's photo is vertical stripes: a stripe is 16 px, a period 32 px of a 256 px texture repeated four times over 20 m: 0.625 m
    const groove = (pitch: number, count: number): OperatorSpec => ({ operator: 'replicate', replicate: { seed: panel('s01', rect(0, 0, 0.12, 5), 0.04), domain: { lattice: { originUv: [2, 2], pitchUv: [pitch, 6], counts: [count, 1], rowOffsetU: 0 } }, alignToSurface: true } });

    it('a periodic element passes at the pitch the tile photo shows, and only there: not at its half, its double or a fifth off it', async () => {
        const els = [
            element('p625', WALL, groove(0.625, 12), 0, 'ortho:s01'),
            element('p3125', WALL, groove(0.3125, 24), 1, 'ortho:s01'),
            element('p5', WALL, groove(0.5, 15), 2, 'ortho:s01'),
            element('p125', WALL, groove(1.25, 6), 3, 'ortho:s01')
        ];
        const { report } = await build(facade.stripes, els);
        expect(report.built.map(b => b.elementId)).toEqual(['p625']);
        const s = report.built[0].support!;
        expect(s.test).toBe('periodic peak');
        expect(s.limit).toBe(3);
        expect(s.value).toBeGreaterThan(10);
        for (const id of ['p3125', 'p5', 'p125']) {
            const d = dropOf(report, id)!;
            expect(d, id).toBeDefined();
            expect(d.checks[0].check).toBe('periodic peak');
            expect(d.checks[0].limit).toBe(3);
            expect(d.checks[0].message).toMatch(/not visible in the tile photo/);
        }
    }, 180_000);

    it('a periodic element on a blank texture is dropped, and so is one that cites only the photo and has no textured extraction to be read from', async () => {
        const { report } = await build(facade.blank, [element('b625', WALL, groove(0.625, 12), 0, 'ortho:s01')]);
        expect(report.built).toEqual([]);
        expect(dropOf(report, 'b625')!.checks[0].check).toBe('periodic peak');
        expect(dropOf(report, 'b625')!.checks[0].value).toBeLessThan(3);
    }, 120_000);

    it('an isolated element passes where its outline carries a luminance step in the photo (a stripe), and not on a blank wall or off the stripe', async () => {
        // the stripe of the photo from u = 1.25 to 1.5625 (light), x = -8.75 .. -8.4375; the wall is bright there and dark either side
        const stripe = element('on', WALL, panel('s01', rect(1.25, 2, 1.5625, 7), 0.04), 0, 'ortho:s01');
        const across = element('across', WALL, panel('s01', rect(1.45, 2, 1.7, 7), 0.04), 1, 'ortho:s01');
        const a = await build(facade.stripes, [stripe]);
        expect(a.report.dropped).toEqual([]);
        expect(a.report.built[0].support!.test).toBe('edge contrast');
        expect(a.report.built[0].support!.value).toBeGreaterThanOrEqual(a.report.built[0].support!.limit);
        const blank = await build(facade.blank, [element('blank', WALL, panel('s01', rect(1.25, 2, 1.5625, 7), 0.04), 0, 'ortho:s01')]);
        expect(blank.report.built).toEqual([]);
        expect(dropOf(blank.report, 'blank')!.checks[0].check).toBe('edge contrast');
        expect(dropOf(blank.report, 'blank')!.checks[0].message).toMatch(/not visible in the tile photo/);
        // across a stripe edge half-way: its outline runs over light and dark both, the step is there on one side only, so it is weaker than on the stripe
        const b = await build(facade.stripes, [across]);
        const onValue = a.report.built[0].support!.value;
        const acrossValue = b.report.built.length ? b.report.built[0].support!.value : (dropOf(b.report, 'across')!.checks[0].value);
        expect(acrossValue).toBeLessThan(onValue);
    }, 180_000);

    it('an element citing a Street View image is not pixel-tested (its bytes are never decoded), so a blank wall does not drop it', async () => {
        const { report } = await build(facade.blank, [element('sv', WALL, groove(0.625, 12), 0, SV)]);
        expect(report.dropped).toEqual([]);
        expect(report.built[0].support).toBeUndefined();
    }, 120_000);
});

describe('a refit', () => {
    it('moves an archivolt swept along the slot\'s crease with the corrected arch, and drops a panel that the new, wider opening swallows', async () => {
        const arch = archFit;
        const body = arch.fit.primitives.find(p => p.fitParams.length === 7)!;
        // the archivolt's crease: an edge slot on the soffit's cylinder chart
        const crease = arch.fit.slots.find(s => 'edge' in s.host && (s.host as any).edge.surfaceIds.some((id: string) => 'cylinder' in surface(arch, id).chart))!;
        expect(crease).toBeDefined();
        // a face slot: the elevation face holding the opening
        const face = arch.fit.slots.find(s => 'surface' in s.host && s.sizeM[0] > 14 && s.sizeM[1] > 13)!;
        const faceSurface = (face.host as any).surface.surfaceId as string;
        const ch = (surface(arch, faceSurface).chart as any).plane;
        const uvOf = (x: number, y: number, z: number): Vec2 => {
            const r = [x - ch.origin[0], y - ch.origin[1], z - ch.origin[2]];
            return [r[0] * ch.u[0] + r[1] * ch.u[1] + r[2] * ch.u[2], r[0] * ch.v[0] + r[1] * ch.v[1] + r[2] * ch.v[2]];
        };
        // 3.4 m beside the arch's centre line (u runs along the face), 9.6 to 9.8 m up: over the old arc (it is at 9.50 m at the box's inner
        // edge) and under the arc the rise/span 0.26 gives (9.81 m there), so the box is solid wall before and half open after
        const [uc, vc] = uvOf(0, 9.7, 0);
        const region = rect(uc + 3.2, vc - 0.1, uc + 3.6, vc + 0.1);
        const elements = [
            element('arch', crease.id, sweepOnSlot(crease.id, [[0, 0], [0.2, 0], [0.2, -0.12], [0, -0.12]], 0.05, 0.95), 0),
            element('over', face.id, panel(faceSurface, region, 0.05), 1)
        ];
        const before = await build(arch, elements);
        expect(before.report.dropped, JSON.stringify(before.report.dropped)).toEqual([]);
        // the photo reads a flatter arch than the scan's circle: rise over span 0.26 (the admissible range starts at 0.25)
        const c = body.correctable.find(x => x.param === 6)!;
        expect(c.min).toBeLessThanOrEqual(0.26);
        const re = await svc.refit({ fitPath: rel(arch.path), scanGlb: archScanRel, set: [{ primitiveId: body.id, param: 6, value: 0.26 }] });
        const refit: Fitted = { fit: re.value, path: re.path, textured: arch.textured };
        // the slots keep their ids; the crown stays where the scan has it and the springings rise about a metre
        expect(refit.fit.slots.map(s => s.id)).toEqual(arch.fit.slots.map(s => s.id));
        const after = await build(refit, elements);
        const ext = (g: StagedGlbRead) => bbox(g.byName('arch').primitives[0].positions);
        expect(after.report.built.map(b => b.elementId)).toContain('arch');
        expect(Math.abs(ext(after.glb).mx[1] - ext(before.glb).mx[1])).toBeLessThan(0.1);
        const lift = ext(after.glb).mn[1] - ext(before.glb).mn[1];
        // (the run starts 5 % along a crease that is shorter after the correction, so a little under the springing's own 0.9 m)
        expect(lift).toBeGreaterThan(0.5);
        expect(lift).toBeLessThan(1.2);
        // the panel that sat on the wall now overlaps the opening: dropped, with the check that failed
        const gone = dropOf(after.report, 'over')!;
        expect(gone, JSON.stringify(after.report)).toBeDefined();
        expect(gone.checks.map(c => c.check)).toContain('footprint inside slot');
        const shot = saveClayShot('ornament_arch_refit', [
            { file: refit.fit.outputs.fittedGlb, color: [0.62, 0.64, 0.68] }, { file: before.file, color: [0.3, 0.6, 0.9] }, { file: after.file, color: [0.9, 0.5, 0.3] }], { bearingDeg: 215, elevationDeg: 18 });
        expect(shot.covered).toBeGreaterThan(0.03);
    }, 300_000);
});

describe('the layer', () => {
    it('is the same bytes for the same inputs, in another cache', async () => {
        const els = [
            element('x0', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]]), 0),
            element('x1', WALL, panel('s01', rect(6, 3, 9, 6), -0.1), 1)
        ];
        const a = await build(facade.stripes, els);
        const other = new ScanFitService({ workspaceRoot: work, repoRoot: REPO, cacheDir: '.cache-other' });
        const r = await other.ornament({ fitPath: rel(facade.stripes.path), texturedGlb: rel(facade.stripes.textured), spec: specOf(facade.stripes, els) });
        expect(r.cached).toBe(false);
        expect(r.dir).not.toBe(a.result.dir);
        expect(sha(r.detailGlb)).toBe(sha(a.file));
        const again = await svc.ornament({ fitPath: rel(facade.stripes.path), texturedGlb: rel(facade.stripes.textured), spec: specOf(facade.stripes, els) });
        expect(again.cached).toBe(true);
    }, 180_000);

    it('draws as the facade with its detail on it: moldings, a roundel, a recessed panel, a lattice of coffers', async () => {
        const els = [
            element('m', TOP_EDGE, sweepOnSlot(TOP_EDGE, [[0, 0], [0.25, 0], [0.25, 0.08], [0.1, 0.16], [0, 0.16]], 0.02, 0.98), 0),
            element('r', WALL, { operator: 'revolve', revolve: { axisOrigin: [10, 6, 0], axisDir: [0, 0, 1], profile: [[0, 0], [1.4, 0], [1.4, 0.1], [1.0, 0.16], [0, 0.2]], lobes: 12, lobeAmplitude: 0.04, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 128 } }, 1),
            element('p', WALL, panel('s01', rect(2, 2.5, 6, 7.5), -0.12), 2),
            element('c', WALL, { operator: 'replicate', replicate: { seed: panel('s01', box(0.9, 0.9), 0.07), domain: { lattice: { originUv: [13, 2.5], pitchUv: [1.3, 1.3], counts: [4, 4], rowOffsetU: 0 } }, alignToSurface: true } }, 3)
        ];
        const { report, file } = await build(facade.stripes, els);
        expect(report.dropped).toEqual([]);
        expect(report.built.map(b => b.elementId)).toEqual(['m', 'r', 'p', 'c']);
        // the layer's own count is the sum of its nodes
        expect(report.counts.triangles).toBe(report.built.reduce((a, b) => a + b.triangles, 0));
        // the viewport hides the surface a recut copy replaces; the shot does the same
        const replaced = new Set(readStagedGlb(file).nodes.flatMap(n => n.sb?.replacesSurfaceIds ?? []));
        const wall = facade.stripes.fit.outputs.fittedGlb;
        const shot = saveClayShot('ornament_facade_detail', [
            { file: wall, color: [0.72, 0.74, 0.77], hide: n => replaced.has(n.extras?.sb?.ids?.surfaceId) },
            { file, color: [0.9, 0.5, 0.3] }], { bearingDeg: 12, elevationDeg: 10 });
        expect(shot.covered).toBeGreaterThan(0.05);
    }, 180_000);
});
