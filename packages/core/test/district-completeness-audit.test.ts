/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';
import { auditDistrict, type AuditLayer, type SurfaceAudit } from '../src/node/3d-engine/staged-location/district-completeness-audit';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { box, quad, testGlb, type TestNode, type TestPrim } from './helpers/test-glb';

const square = (cx: number, cz: number, half: number): Vec2[][] => [[[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]]];
const layer = (id: string, nodes: TestNode[], extra: Partial<AuditLayer> = {}): AuditLayer => { const glb = testGlb(nodes); return { id, read: () => glb, label: 'remeshed', ...extra }; };
const surface = (audit: { surfaces: SurfaceAudit[] }, id: string) => audit.surfaces.find(s => s.id === id)!;
const checks = (s: SurfaceAudit) => s.failures.map(f => f.check);
/** The checks other than the texture's: the geometric fixtures here are clay. */
const geometric = (s: SurfaceAudit) => checks(s).filter(c => c !== 'untextured');

describe('district completeness audit', () => {
    it('reads each footprint against the grown edge: wholly in, wholly out, or straddling it', async () => {
        const buildings = [
            { id: 'in', loops: square(0, 0, 5) },
            { id: 'out', loops: square(200, 0, 5) },
            { id: 'straddles', loops: square(100, 0, 5) },
            // past the radius, but the plan keeps it whole: the edge grows around it
            { id: 'grown', loops: square(0, 100, 5) }
        ];
        const audit = await auditDistrict({ layers: [], buildings, edge: { radiusM: 100, grownBy: [buildings[0], buildings[3]] } });
        expect(surface(audit, 'in').edge!.state).toBe('inside');
        expect(surface(audit, 'out').edge!.state).toBe('outside');
        expect(surface(audit, 'grown').edge!.state).toBe('inside');
        const s = surface(audit, 'straddles');
        expect(s.edge!.state).toBe('straddles');
        expect(s.edge!.insideShare).toBeGreaterThan(0.35);
        expect(s.edge!.insideShare).toBeLessThan(0.65);
        expect(checks(s)).toContain('edge-straddle');
        // a building inside the edge with no geometry at all is missing
        expect(checks(surface(audit, 'in'))).toContain('missing');
        expect(checks(surface(audit, 'out'))).not.toContain('missing');
    });

    it('measures the cut a building shows where the edge runs through it', async () => {
        const buildings = [{ id: 'cut', loops: square(97.5, 0, 5) }, { id: 'whole', loops: square(0, 0, 5) }];
        // the building's east side is missing where the district stops at 100 m; the other stands closed
        const audit = await auditDistrict({
            layers: [layer('scan', [{ prims: [box(95, 0, -5, 100, 12, 5, ['east', 'bottom']), box(-5, 0, -5, 5, 12, 5, ['bottom'])] }])],
            buildings, edge: { radiusM: 100, grownBy: [buildings[1]] }
        });
        const cut = surface(audit, 'cut');
        expect(cut.cutAtEdgeM).toBeCloseTo(2 * (10 + 12), 1);
        expect(checks(cut)).toContain('edge-cut');
        expect(cut.holes).toBe(0);
        const whole = surface(audit, 'whole');
        expect(whole.cutAtEdgeM).toBe(0);
        expect(geometric(whole)).toEqual([]);
    });

    it('finds open edges and holes, and tells a hole from the base standing on the ground', async () => {
        const buildings = [{ id: 'roofless', loops: square(0, 0, 5) }, { id: 'standing', loops: square(30, 0, 5) }, { id: 'closed', loops: square(60, 0, 5) }];
        const audit = await auditDistrict({
            layers: [layer('scan', [{ prims: [box(-5, 0, -5, 5, 10, 5, ['top']), box(25, 0, -5, 35, 10, 5, ['bottom']), box(55, 0, -5, 65, 10, 5)] }])],
            buildings, edge: { radiusM: 200, grownBy: [] }
        });
        const roofless = surface(audit, 'roofless');
        expect(roofless.openEdgeM).toBeCloseTo(40, 3);
        expect(roofless.holes).toBe(1);
        expect(roofless.holePerimeterM).toBeCloseTo(40, 3);
        expect(checks(roofless)).toContain('holes');
        const standing = surface(audit, 'standing');
        expect(standing.openEdgeM).toBeCloseTo(40, 3);
        expect(standing.holes).toBe(0);
        const closed = surface(audit, 'closed');
        expect(closed.openEdgeM).toBe(0);
        expect(closed.nonManifoldEdges).toBe(0);
        expect(geometric(closed)).toEqual([]);
    });

    it('measures the share of black texels, and of surface drawn untextured', async () => {
        // a 2 x 1 texture: its left half black, its right half white
        const png = encodePng(2, 1, Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]), 4);
        const buildings = [{ id: 'half-black', loops: square(0, 0, 5) }, { id: 'white', loops: square(30, 0, 5) }, { id: 'clay', loops: square(60, 0, 5) }];
        const white = encodePng(1, 1, Uint8Array.from([250, 250, 250, 255]), 4);
        const clay = quad(55, -5, 65, 5);
        delete clay.uvs;
        const audit = await auditDistrict({
            layers: [layer('twin', [{ prims: [quad(-5, -5, 5, 5, 0, png), quad(25, -5, 35, 5, 0, white), clay] }])],
            buildings, edge: { radiusM: 200, grownBy: [] }
        });
        const half = surface(audit, 'half-black');
        expect(half.blackShare).toBeGreaterThan(0.3);
        expect(half.blackShare).toBeLessThan(0.7);
        expect(half.untexturedShare).toBe(0);
        expect(checks(half)).toContain('black-texels');
        expect(surface(audit, 'white').blackShare).toBe(0);
        expect(checks(surface(audit, 'white'))).not.toContain('black-texels');
        expect(checks(surface(audit, 'white'))).not.toContain('untextured');
        const untextured = surface(audit, 'clay');
        expect(untextured.untexturedShare).toBe(1);
        expect(checks(untextured)).toContain('untextured');
    });

    it('finds overlapping coplanar surfaces across layers and within one, and not surfaces that only meet', async () => {
        const buildings = [{ id: 'twice', loops: square(0, 0, 5) }, { id: 'stacked', loops: square(30, 0, 5) }, { id: 'meeting', loops: square(60, 0, 5) }, { id: 'duplicated', loops: square(90, 0, 5) }];
        const audit = await auditDistrict({
            layers: [
                layer('chunk-a', [{ prims: [quad(-5, -5, 5, 5), quad(25, -5, 35, 5, 0), quad(55, -5, 60, 5), quad(60, -5, 65, 5), quad(85, -5, 95, 5), quad(85, -5, 95, 5)] }]),
                // the same surface again from a neighbouring chunk, and one a metre above another (not coplanar)
                layer('chunk-b', [{ prims: [quad(-5, -5, 5, 5), quad(25, -5, 35, 5, 1)] }])
            ],
            buildings, edge: { radiusM: 200, grownBy: [] }
        });
        expect(surface(audit, 'twice').overlapAreaM2).toBeCloseTo(100, 3);
        expect(checks(surface(audit, 'twice'))).toContain('overlap');
        expect(surface(audit, 'stacked').overlapAreaM2).toBe(0);
        expect(surface(audit, 'meeting').overlapAreaM2).toBe(0);
        // the same triangles twice in one layer weld onto the same corners: duplicates, not neighbours
        expect(surface(audit, 'duplicated').overlapAreaM2).toBeCloseTo(100, 3);
    });

    it('finds a piece that touches nothing, and not one standing on the ground or on another layer', async () => {
        const buildings = [{ id: 'on-ground', loops: square(0, 0, 5) }, { id: 'floating', loops: square(30, 0, 5) }, { id: 'on-detail', loops: square(60, 0, 5) }];
        const audit = await auditDistrict({
            layers: [
                layer('scan', [{ prims: [quad(-100, -100, 100, 100), box(-5, 0, -5, 5, 10, 5, ['bottom']), box(29, 5, -1, 31, 6, 1)] }]),
                // a detail layer's piece resting on the scan's roof
                layer('detail', [{ prims: [box(-200, 0, -200, -150, 1, -150), box(59, 0, -1, 61, 2, 1)] }])
            ],
            buildings, edge: { radiusM: 300, grownBy: [] }
        });
        expect(surface(audit, 'on-ground').floatingPieces).toBe(0);
        const floating = surface(audit, 'floating');
        expect(floating.floatingPieces).toBe(1);
        expect(floating.floatingAreaM2).toBeCloseTo(2 * (4 + 2 + 2), 3);
        expect(checks(floating)).toContain('floating');
        expect(surface(audit, 'on-detail').floatingPieces).toBe(0);
    });

    it('tells a crown cut at the edge from one whole across it', async () => {
        const R = 100;
        const tree = (id: number, x: number, crown: TestPrim): TestNode => ({
            prims: [crown], translation: [x, 6, 0],
            extras: { sbTree: { id, hashSeed: id, label: 'tree', crown: { centre: [0, 0, 0], radii: [3, 2.5, 3], yawRad: 0, leanM: [0, 0], points: 10, fittedTo: 'test' } } }
        });
        const audit = await auditDistrict({
            layers: [layer('trees', [
                // centred a metre inside the line: one stops at the line, one reaches its full 3 m past the centre
                tree(1, R - 1, box(-3, -2.5, -3, 1, 2.5, 3)),
                tree(2, R - 1, box(-3, -2.5, -3, 3, 2.5, 3)),
                tree(3, 0, box(-3, -2.5, -3, 3, 2.5, 3))
            ])].map(l => ({ ...l, wholePieces: true })),
            buildings: [], edge: { radiusM: R, grownBy: [] }
        });
        expect(audit.trees.count).toBe(3);
        expect(audit.trees.straddling).toBe(2);
        expect(audit.trees.cut).toBe(1);
        const cut = audit.trees.list.find(t => !t.whole)!;
        expect(cut.centre[0]).toBeCloseTo(R - 1, 6);
        expect(cut.reachOutM).toBeCloseTo(1, 6);
        expect(cut.expectedOutM).toBeCloseTo(3, 6);
        // trees are audited as trees, not as the ground's surface
        expect(surface(audit, 'ground').triangles).toBe(0);
    });
});
