/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's roof objects (pipeline-g/roof-objects.ts) from measured clusters on a 20 x 20 m massing whose roof is at
 * 12 m: a 6 x 6 m pyramid 3 m tall becomes a part with four fitted planes meeting at its apex; a 4 x 3 m box 2.5 m tall a
 * flat-topped part; a cluster hanging on a wall (its support a balcony, not the roof) and a scan artefact are not built;
 * the native tool builds the parts on the roof.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText, roofAt, type MassingPart } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { hull2, insidePart, roofObjectPart, simplifyRing2 } from '../src/node/3d-engine/staged-location/pipeline-g/roof-objects';
import type { AuditedCluster } from '../src/node/3d-engine/staged-location/residual-audit';

type P3 = [number, number, number];
const MAIN: MassingPart = { id: 'main', baseY: 0, topY: 12, loops: [[[0, 0], [20, 0], [20, -20], [0, -20]]], planes: [], heightSource: 'vector', heights: {} };

/** A cluster with only what the fit reads: verdict and support. */
const cluster = (id: number, supportY: number, verdict: AuditedCluster['verdict'] = 'real-object') =>
    ({ id, verdict, attachment: { supportY } } as unknown as AuditedCluster);

/** A pyramid on a square base [x0, x0 + w] x [z0 - w, z0], apex h above y0, as triangles (with its base's side walls). */
function pyramid(x0: number, z0: number, w: number, y0: number, h: number): P3[][] {
    const c: P3 = [x0 + w / 2, y0 + h, z0 - w / 2];
    const corners: P3[] = [[x0, y0, z0], [x0 + w, y0, z0], [x0 + w, y0, z0 - w], [x0, y0, z0 - w]];
    const tris: P3[][] = [];
    // each face subdivided so it holds several triangles, as a scan would
    for (let k = 0; k < 4; k++) {
        const a = corners[k], b = corners[(k + 1) % 4];
        for (let s = 0; s < 4; s++) {
            const p = (t: number): P3 => [a[0] + (b[0] - a[0]) * t, y0, a[2] + (b[2] - a[2]) * t];
            tris.push([p(s / 4), p((s + 1) / 4), c]);
        }
    }
    return tris;
}

/** A box [x0, x1] x [z1, z0] from y0 to y1: its top as triangles and its sides. */
function box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): P3[][] {
    const t: P3[][] = [[[x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x1, y1, z1], [x0, y1, z1]]];
    for (const [a, b] of [[[x0, z0], [x1, z0]], [[x1, z0], [x1, z1]], [[x1, z1], [x0, z1]], [[x0, z1], [x0, z0]]] as Array<[[number, number], [number, number]]>) {
        t.push([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]]], [[a[0], y0, a[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]]);
    }
    return t;
}

describe('pipeline G roof objects', () => {
    it('outlines a cluster by its simplified hull', () => {
        const ring = simplifyRing2(hull2([[0, 0], [2, 0.01], [4, 0], [4, 3], [2, 3.02], [0, 3], [1, 1]]), 0.25);
        expect(ring).toHaveLength(4);
        expect(insidePart(MAIN, 10, -10)).toBe(true);
        expect(insidePart(MAIN, 25, -10)).toBe(false);
    });

    it('fits a pyramid with four planes meeting at its apex, and a box with a flat top', () => {
        const pyr = roofObjectPart(cluster(1, 12), pyramid(4, -4, 6, 12, 3), 'roof-object-1', 0, [MAIN]);
        if (!('part' in pyr)) throw new Error(pyr.skipped);
        expect(pyr.planes).toBe(4);
        expect(pyr.part.loops[0]).toHaveLength(4);
        expect(pyr.part.provenance).toBe('scan-fitted');
        // the roof the planes make: the apex at the centre, the eaves at the edges
        expect(roofAt(pyr.part, 7, -7)).toBeCloseTo(15, 1);
        expect(roofAt(pyr.part, 4.2, -7)).toBeLessThan(12.5);
        const bx = roofObjectPart(cluster(2, 12), box(12, 16, -12, -15, 12, 14.5), 'roof-object-2', 0, [MAIN]);
        if (!('part' in bx)) throw new Error(bx.skipped);
        expect(bx.planes).toBe(0);
        expect(bx.part.topY).toBeCloseTo(14.5, 6);
        expect(bx.outlineM2).toBeCloseTo(12, 6);
    });

    it('drops a plane fitted to a blob that, carried to its outline, sinks into the building (the Haughwout water tower)', () => {
        // a 2 m pyramid, 1.5 m tall, whose cluster also holds vertical slivers 3 m out on two sides (a blob's spill):
        // the outline grows to the slivers, and the steep faces carried out to it reach far below the roof
        const steep = pyramid(9, -9, 2, 12, 1.5);
        const sliver = (x: number, z: number): P3[][] => [[[x, 12, z], [x + 0.2, 12, z], [x + 0.2, 13, z]], [[x, 12, z], [x + 0.2, 13, z], [x, 13, z]]];
        const blob = roofObjectPart(cluster(3, 12), [...steep, ...sliver(5, -10), ...sliver(14, -6), ...sliver(9.5, -14)], 'roof-object-3', 0, [MAIN]);
        if (!('part' in blob)) throw new Error(blob.skipped);
        expect(blob.planes).toBe(0);
        expect(blob.reason, blob.reason).toMatch(/dropped: outside its own height/);
        for (const [x, z] of blob.part.loops[0]) expect(roofAt(blob.part, x, z)).toBeGreaterThanOrEqual(12);
        // the same pyramid on its own keeps its four planes
        const alone = roofObjectPart(cluster(4, 12), steep, 'roof-object-4', 0, [MAIN]);
        if (!('part' in alone)) throw new Error(alone.skipped);
        expect(alone.planes).toBe(4);
    });

    it('does not build a cluster hanging on a wall, one standing on the street, or an artefact', () => {
        // a balcony-hung box outside the plan (beyond z = 0), standing on something 6 m up
        const hung = roofObjectPart(cluster(3, 6), box(5, 8, 2, 0.5, 6, 8), 'x', 0, [MAIN]);
        expect('skipped' in hung && hung.skipped).toMatch(/not on the roof/);
        // inside the plan but at 6 m, not on the 12 m roof
        const mid = roofObjectPart(cluster(4, 6), box(5, 8, -5, -8, 6, 8), 'x', 0, [MAIN]);
        expect('skipped' in mid && mid.skipped).toMatch(/no massing roof under its centre/);
        expect('skipped' in roofObjectPart(cluster(5, 0.5), box(5, 8, 2, 0.5, 0.5, 2), 'x', 0, [MAIN])).toBe(true);
        expect('skipped' in roofObjectPart(cluster(6, 12, 'scan-artefact'), box(12, 16, -12, -15, 12, 14.5), 'x', 0, [MAIN])).toBe(true);
    });

    it('is built on the roof by the native tool', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-roof-'));
        const pyr = roofObjectPart(cluster(1, 12), pyramid(4, -4, 6, 12, 3), 'roof-object-1', 0, [MAIN]);
        if (!('part' in pyr)) throw new Error(pyr.skipped);
        const r = await runMassing(massingSpecText({ parts: [MAIN, pyr.part], meshes: [] }, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 } }), dir);
        // the pyramid's sloping roof faces are built above the main roof, up to its apex
        const roofs = r.report.faces.filter(f => f.kind === 'roof' && f.part === 'roof-object-1');
        expect(roofs.length).toBeGreaterThanOrEqual(4);
        let top = -Infinity;
        for (const n of r.nodes) for (let i = 1; i < n.positions.length; i += 3) top = Math.max(top, n.positions[i]);
        expect(top).toBeCloseTo(15, 0);
    });
});
