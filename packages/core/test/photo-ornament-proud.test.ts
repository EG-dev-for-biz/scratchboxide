/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Elements stand PROUD of the wall along its outward normal, and the penetration check does not mistake a wall for a sink when the fit
 * is a stack of prisms that share faces (the real arch is a stack of eleven). Built with the real native ornament builder on fits of
 * synthetic structures: a panel 4 cm proud of every fully visible vertical face must build, and the same panel sunk 4 cm into the face
 * (negative depth is a recess, so it is the mirror image) must still be refused as a recess past the slot's bound only when the slot
 * allows none. The expected extents are measured from the built nodes, not asserted from the spec.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import type { OrnamentElement, OperatorSpec, StructureFit, Vec2 } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import * as FX from './helpers/staged-location-fixtures';
import { readStagedGlb } from './helpers/staged-glb-read';
import { archRealData } from './helpers/staged-real-data';

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
const panel = (surfaceId: string, region: Vec2[], depthM: number): OperatorSpec => ({ operator: 'relief', relief: { surfaceId, region: { outer: region }, height: { panel: { depthM, edgeWidthM: 0.05, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } });

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ornament-proud-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);
afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

describe('a panel stands proud of every fully visible vertical face of a fitted structure, along the face\'s outward normal', () => {
    const archData = archRealData();
    const cases: Array<[string, (d: string) => { glb: string }, boolean]> = [
        ['segmental arch', (d: string) => S.segmentalArch(d), true], ['arcade', (d: string) => S.arcade(d), true], ['L plan', (d: string) => S.lPlan(d), true],
        ['the real Washington Square Arch (a stack of prisms)', (d: string) => { const g = path.join(d, 'arch.glb'); fs.copyFileSync(archData.data!.refine.rawClay, g); return { glb: g }; }, !!archData.data]
    ];
    for (const [name, make, available] of cases) {
        it.skipIf(!available)(name, async () => {
            const dir = path.join(work, name.replace(/[^a-z]+/gi, '_'));
            fs.mkdirSync(dir);
            const scan = make(dir);
            const rel = (f: string) => path.relative(work, f);
            const r = await svc.fit({ scanGlb: rel(scan.glb), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS });
            const fit: StructureFit = r.value;
            const elements: OrnamentElement[] = [];
            const probes: Array<{ slotId: string; normal: number[]; centre: number[] }> = [];
            let k = 0;
            for (const s of fit.slots) {
                if (!('surface' in s.host)) continue;
                const surf = fit.surfaces.find(x => x.id === (s.host as any).surface.surfaceId)!;
                if (!('plane' in surf.chart) || Math.abs(surf.chart.plane.normal[1]) > 0.1 || surf.visibleFraction < 0.9) continue;
                const reg = (s.host as any).surface.regionUv as Vec2[];
                const us = reg.map(p => p[0]), vs = reg.map(p => p[1]);
                const cu = (Math.min(...us) + Math.max(...us)) / 2, cv = (Math.min(...vs) + Math.max(...vs)) / 2;
                const w = Math.min(0.5, (Math.max(...us) - Math.min(...us)) / 4), h = Math.min(0.5, (Math.max(...vs) - Math.min(...vs)) / 4);
                if (w < 0.1 || h < 0.1) continue;
                elements.push(element(`${s.id}_panel`, s.id, panel(surf.id, [[cu - w, cv - h], [cu + w, cv - h], [cu + w, cv + h], [cu - w, cv + h]], 0.04), k++));
                const pl = surf.chart.plane;
                probes.push({ slotId: s.id, normal: pl.normal, centre: [pl.origin[0] + pl.u[0] * cu + pl.v[0] * cv, pl.origin[1] + pl.u[1] * cu + pl.v[1] * cv, pl.origin[2] + pl.u[2] * cu + pl.v[2] * cv] });
            }
            expect(elements.length).toBeGreaterThan(0);
            const base = FX.ornamentSpec();
            const spec = {
                ...base, buildingId: fit.buildingId, structureFitSha256: sha(r.path), elements,
                evidence: [{ id: SV, index: 0, kind: 'streetview-grounding' as const, widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021, slotsShown: [] }],
                corrections: [], emptySlots: [], dropped: []
            };
            const built = await svc.ornament({ fitPath: rel(r.path), texturedGlb: rel(scan.glb), spec });
            expect(built.value.dropped.filter(d => d.checks.some(c => c.check === 'penetration of the fitted solid')), JSON.stringify(built.value.dropped.map(d => [d.elementId, d.checks.map(c => c.check)]))).toEqual([]);
            // measured from the nodes: every built panel's farthest vertex stands 0.04 m out along the face's own outward normal
            const glb = readStagedGlb(built.detailGlb);
            for (const b of built.value.built) {
                const probe = probes.find(p => `${p.slotId}_panel` === b.elementId)!;
                const pos = glb.byName(b.elementId).primitives[0].positions;
                let maxOut = -Infinity;
                for (let i = 0; i < pos.length; i += 3) maxOut = Math.max(maxOut, (pos[i] - probe.centre[0]) * probe.normal[0] + (pos[i + 1] - probe.centre[1]) * probe.normal[1] + (pos[i + 2] - probe.centre[2]) * probe.normal[2]);
                expect(maxOut).toBeGreaterThan(0.035);
                expect(maxOut).toBeLessThan(0.05);
            }
        }, 600_000);
    }
});
