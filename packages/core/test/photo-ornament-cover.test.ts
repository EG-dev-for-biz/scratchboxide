/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The "sinks into the fitted solid" fault, on the real Washington Square Arch fit and the real native builder.
 *
 * Root cause: the fit stacks prisms. A slot is a face or an edge of ONE primitive, measured over the whole of it, but a neighbouring
 * primitive fills the space in front of it over part of it (a plinth against the foot of a pier wall, an upper prism standing on the
 * top edge of a band). An element built there has vertices inside the neighbour's shell and the builder rejects it. The reading was
 * never told. slot-cover.ts finds the covered parts from the fitted solid; the prompt names them; the anchoring clips an edge sweep or
 * a repeat into the free stretch and sends back what cannot be moved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import type { OrnamentElement, OperatorSpec, StructureFit, Vec2 } from '../src/common/spatial/staged-location-contracts';
import * as FX from './helpers/staged-location-fixtures';
import { archRealData } from './helpers/staged-real-data';
import { readFittedShells } from '../src/node/3d-engine/staged-location/fitted-solid';
import { computeSlotCover, coveredBoxes, describeCover, openStretches, type EdgeCover, type SurfaceCover } from '../src/node/3d-engine/staged-location/slot-cover';
import { sunkBelowSurface } from '../src/node/3d-engine/staged-location/ornament-vision';
import { anchorElements } from '../src/node/3d-engine/staged-location/ornament-anchor';
import type { ExpandedElement } from '../src/node/3d-engine/staged-location/ornament-expand';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };
const SV = 'sv:CAoSLEFGMVFpcE:12:8:42';
let work: string;
let svc: ScanFitService;
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const element = (id: string, slotId: string, spec: OperatorSpec, order: number): OrnamentElement => ({
    id, slotId, confidence: 0.7, depthBasis: 'a test', buildOrder: order, spec,
    evidence: [{ imageId: SV, box1000: [100, 100, 300, 300] }],
    checks: { slotOverlap: 1, minFeatureM: 0.1, nativeSampleM: 0.02 }, provenance: FX.photoInferred(0.7, SV)
});
const archData = archRealData();

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ornament-cover-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);
afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

describe('what goes below the surface', () => {
    it('is found in a sweep along a path, a revolve about the normal and a repeat of either; a relief and an edge sweep are not its business', () => {
        const rev: OperatorSpec = { operator: 'revolve', revolve: { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], profile: [[0.11, 0], [0.1, -0.07], [0.07, -0.11], [0, -0.035]], lobes: 8, lobeAmplitude: 0.012, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 32 } };
        const path: OperatorSpec = { operator: 'sweep', sweep: { carrier: { chart: { pointsUv: [[0, 0], [1, 0], [1, 1]], closed: true } }, profile: { outer: [[-0.03, 0], [-0.02, -0.025], [0.02, -0.025], [0.03, 0]] }, miterLimit: 4, caps: true } };
        const rep: OperatorSpec = { operator: 'replicate', replicate: { seed: rev as any, domain: { lattice: { originUv: [0, 0], pitchUv: [1, 1], counts: [2, 2], rowOffsetU: 0 } }, alignToSurface: true } };
        const relief: OperatorSpec = { operator: 'relief', relief: { surfaceId: 's', region: { outer: [[0, 0], [1, 0], [1, 1]] }, height: { panel: { depthM: -0.1, edgeWidthM: 0.02, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } };
        const edge: OperatorSpec = { operator: 'sweep', sweep: { carrier: { slot: { slotId: 'S', t0: 0, t1: 1, offset: [0, 0] } }, profile: { outer: [[0, -1], [0.1, 0.1]] }, miterLimit: 4, caps: true } };
        expect(sunkBelowSurface(rev)).toBeCloseTo(0.11, 6);
        expect(sunkBelowSurface(path)).toBeCloseTo(0.025, 6);
        expect(sunkBelowSurface(rep)).toBeCloseTo(0.11, 6);
        expect(sunkBelowSurface(relief)).toBe(0);
        expect(sunkBelowSurface(edge)).toBe(0);
    });
});

describe.skipIf(!archData.data)('a slot whose free space a neighbouring prism fills (the real arch fit, the real builder)', () => {
    it('the covered part of an edge slot and of a surface slot is found, an element built there sinks, and the anchored one does not', async () => {
        const scan = path.join(work, 'arch.glb');
        fs.copyFileSync(archData.data!.refine.rawClay, scan);
        const rel = (f: string) => path.relative(work, f);
        const r = await svc.fit({ scanGlb: rel(scan), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS });
        const fit: StructureFit = r.value;
        const abs = (f: string) => (path.isAbsolute(f) ? f : path.join(path.dirname(r.path), f));
        const solid = readFittedShells({ surfaces: fit.surfaces, outputs: { ...fit.outputs, fittedGlb: abs(fit.outputs.fittedGlb) } })!;
        expect(solid.shells.length).toBe(fit.primitives.length);
        const covers = new Map(fit.slots.flatMap(s => { const c = computeSlotCover(s, fit, solid); return c && c.share > 0 ? [[s.id, c] as const] : []; }));

        // an edge slot partly under a neighbouring prism, with a free stretch of at least a metre
        const edgeSlot = fit.slots.find(s => { const c = covers.get(s.id); return c?.kind === 'edge' && c.share > 0.05 && c.share < 0.9 && openStretches(c).some(([a, b]) => (b - a) * c.lengthM >= 1.0); });
        expect(edgeSlot, 'an edge slot partly covered').toBeDefined();
        const ec = covers.get(edgeSlot!.id) as EdgeCover;
        const env = (edgeSlot!.host as any).edge.envelope as Vec2[];
        const outMax = Math.max(...env.map(p => p[0])), upMax = Math.max(...env.map(p => p[1]));
        const sweep: OperatorSpec = { operator: 'sweep', sweep: { carrier: { slot: { slotId: edgeSlot!.id, t0: 0, t1: 1, offset: [0, 0] } }, profile: { outer: [[0.01, 0.01], [outMax * 0.9, 0.01], [outMax * 0.9, upMax * 0.9], [0.01, upMax * 0.9]] }, miterLimit: 4, caps: true } };
        // a surface slot partly covered (a plinth against a wall)
        const surfSlot = fit.slots.find(s => { const c = covers.get(s.id); return c?.kind === 'surface' && c.share > 0.03 && c.share < 0.6; });
        expect(surfSlot, 'a surface slot partly covered').toBeDefined();
        const sc = covers.get(surfSlot!.id) as SurfaceCover;
        const box = coveredBoxes(sc)[0];
        const surfId = (surfSlot!.host as any).surface.surfaceId as string;
        const panelAt = (b: { u0: number; u1: number; v0: number; v1: number }): OperatorSpec => ({ operator: 'relief', relief: { surfaceId: surfId, region: { outer: [[b.u0 + 0.1, b.v0 + 0.1], [b.u1 - 0.1, b.v0 + 0.1], [b.u1 - 0.1, b.v1 - 0.1], [b.u0 + 0.1, b.v1 - 0.1]] }, height: { panel: { depthM: 0.05, edgeWidthM: 0.05, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } });
        const mk = (id: string, slotId: string, spec: OperatorSpec, order: number): ExpandedElement => ({ element: element(id, slotId, JSON.parse(JSON.stringify(spec)), order), replyIndex: order });
        const build = async (els: OrnamentElement[]) => {
            const base = FX.ornamentSpec();
            const spec = { ...base, buildingId: fit.buildingId, structureFitSha256: sha(r.path), elements: els, evidence: [{ id: SV, index: 0, kind: 'streetview-grounding' as const, widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021, slotsShown: [] }], corrections: [], emptySlots: [], dropped: [] };
            return svc.ornament({ fitPath: rel(r.path), texturedGlb: rel(scan), spec });
        };

        // 1. reproduced: the unclipped sweep and the panel over the covered part sink
        const raw = await build([element('sweep_raw', edgeSlot!.id, sweep, 0), element('panel_raw', surfSlot!.id, panelAt(box), 1)]);
        const sank = raw.value.dropped.filter(d => d.checks.some(c => c.check === 'penetration of the fitted solid')).map(d => d.elementId);
        expect(sank.sort()).toEqual(['panel_raw', 'sweep_raw']);

        // 2. the prompt names the covered parts
        expect(describeCover(ec)).toMatch(/another part of the structure in the way; free at t/);
        expect(describeCover(sc)).toMatch(/covered by another part of the structure \(u /);

        // 3. anchored: the sweep is clipped into a free stretch (labelled), the panel over the covered part is sent back
        const sweepX = mk('sweep_fix', edgeSlot!.id, sweep, 0), panelX = mk('panel_fix', surfSlot!.id, panelAt(box), 1);
        const anchored = anchorElements([sweepX, panelX], fit, [], undefined, false, covers);
        const clip = anchored.notes.find(n => n.elementId === 'sweep_fix');
        expect(clip?.kind).toBe('clipped-to-open');
        expect(sweepX.element.provenance.label).toBe('photo-corrected');
        expect(anchored.problems.get(1)?.[0]).toMatch(/^cover: the element on /);
        const c = (sweepX.element.spec as any).sweep.carrier.slot;
        expect(openStretches(ec).some(([a, b]) => c.t0 >= a - 1e-6 && c.t1 <= b + 1e-6)).toBe(true);
        // a sweep that runs down the wall below the crease as well (the shape of the live sink on S71): its stretch is clipped by the whole section, not only the part above
        const lowSweep: OperatorSpec = { operator: 'sweep', sweep: { carrier: { slot: { slotId: edgeSlot!.id, t0: 0, t1: 1, offset: [0, 0] } }, profile: { outer: [[0.01, Math.min(...env.map(p => p[1])) * 0.8], [outMax * 0.9, Math.min(...env.map(p => p[1])) * 0.8], [outMax * 0.9, upMax * 0.9], [0.01, upMax * 0.9]] }, miterLimit: 4, caps: true } };
        const lowX = mk('sweep_low', edgeSlot!.id, lowSweep, 3);
        const lowAnchored = anchorElements([lowX], fit, [], undefined, false, covers);
        const built = await build([sweepX.element, ...(lowAnchored.problems.size ? [] : [lowX.element])]);
        expect(built.value.dropped.map(d => [d.elementId, d.checks.map(x => x.check)])).toEqual([]);
        expect(built.value.built.map(b => b.elementId)).toContain('sweep_fix');

        // 4. a panel in the free part of the same slot is untouched
        const free = { u0: sc.u0, u1: sc.u0 + (box.u0 - sc.u0 > 0.8 ? box.u0 - sc.u0 : 0.8), v0: Math.max(box.v1 + 0.2, sc.v0 + sc.nv * sc.dv * 0.6), v1: sc.v0 + sc.nv * sc.dv - 0.3 };
        const freeX = mk('panel_free', surfSlot!.id, panelAt(free), 2);
        const a2 = anchorElements([freeX], fit, [], undefined, false, covers);
        expect(a2.problems.size).toBe(0);
    }, 900_000);
});
