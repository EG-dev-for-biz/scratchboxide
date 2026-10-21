/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * residual-shape-fit.ts on a synthetic rooftop tank (the same tank-on-legs fixture residual-audit.test.ts verifies gets
 * the `real-object` verdict and the `ROOF_OBJECT_TANK` label): the measured per-slice profile is picked up, the native
 * shape-program tool revolves a clean solid from it, and the applyAudit integration drops exactly the tank body's
 * triangles (never its support legs, which the circle fit does not cover) in favour of the fitted node.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { auditResidual, type ResidualAuditResult } from '../src/node/3d-engine/staged-location/residual-audit';
import { pickRadialShapeFits, buildResidualShapeNodes, MIN_SECTORS } from '../src/node/3d-engine/staged-location/pipeline-e/residual-shape-fit';
import { applyAudit } from '../src/node/3d-engine/staged-location/pipeline-e/residual-audit-e';
import { FLAT_COLOUR_REF_BASE } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import type { MassingNode, MassingRun } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'residual-shape-fit-'));

type P3 = [number, number, number];
const tri = (out: number[], a: P3, b: P3, c: P3) => out.push(...a, ...b, ...c);
const quad = (out: number[], a: P3, b: P3, c: P3, d: P3) => { tri(out, a, b, c); tri(out, a, c, d); };

function box(lo: P3, hi: P3, opts: { bottom?: boolean; n?: number } = {}): number[] {
    const o: number[] = [], n = opts.n ?? 1;
    const L = (u: number, a: number, b: number) => a + ((b - a) * u) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x0 = L(i, lo[0], hi[0]), x1 = L(i + 1, lo[0], hi[0]), y0 = L(j, lo[1], hi[1]), y1 = L(j + 1, lo[1], hi[1]), z0 = L(j, lo[2], hi[2]), z1 = L(j + 1, lo[2], hi[2]), zi0 = L(i, lo[2], hi[2]), zi1 = L(i + 1, lo[2], hi[2]);
        quad(o, [x0, hi[1], z0], [x0, hi[1], z1], [x1, hi[1], z1], [x1, hi[1], z0]);
        if (opts.bottom !== false) quad(o, [x0, lo[1], z0], [x1, lo[1], z0], [x1, lo[1], z1], [x0, lo[1], z1]);
        quad(o, [x0, y0, lo[2]], [x1, y0, lo[2]], [x1, y1, lo[2]], [x0, y1, lo[2]]);
        quad(o, [x0, y0, hi[2]], [x0, y1, hi[2]], [x1, y1, hi[2]], [x1, y0, hi[2]]);
        quad(o, [lo[0], y0, zi0], [lo[0], y1, zi0], [lo[0], y1, zi1], [lo[0], y0, zi1]);
        quad(o, [hi[0], y0, zi0], [hi[0], y0, zi1], [hi[0], y1, zi1], [hi[0], y1, zi0]);
    }
    return o;
}

const SOLID = Float32Array.from(box([-15, 0, -15], [15, 20, 15], { n: 4 }));
const ROOF = 20;
const CX = 9, CZ = 2, R = 1.5, Y0 = ROOF + 3.5, Y1 = Y0 + 3;

/** A cylindrical tank on four thin legs (residual-audit.test.ts's fixture, reused here). */
function tankOnLegs(): number[] {
    const o: number[] = [], N = 24;
    const P = (k: number, y: number): P3 => [CX + R * Math.cos((2 * Math.PI * k) / N), y, CZ + R * Math.sin((2 * Math.PI * k) / N)];
    for (let k = 0; k < N; k++) {
        quad(o, P(k, Y0), P(k + 1, Y0), P(k + 1, Y1), P(k, Y1));
        tri(o, [CX, Y1, CZ], P(k + 1, Y1), P(k, Y1));
        tri(o, [CX, Y0, CZ], P(k, Y0), P(k + 1, Y0));
    }
    for (const k of [0, 6, 12, 18]) {
        const top = P(k, Y0), foot: P3 = [CX + 1.2 * Math.cos((2 * Math.PI * k) / N), ROOF, CZ + 1.2 * Math.sin((2 * Math.PI * k) / N)];
        const f = [[foot[0] - 0.1, foot[1], foot[2] - 0.1], [foot[0] + 0.1, foot[1], foot[2] - 0.1], [foot[0], foot[1], foot[2] + 0.12]] as P3[];
        for (let j = 0; j < 3; j++) tri(o, f[j], f[(j + 1) % 3], top);
    }
    return o;
}

describe('residual-shape-fit (native per-slice profile, revolved via the shape-program tool)', () => {
    let result: ResidualAuditResult;
    const tankTris = tankOnLegs();

    it('serialises the native per-slice circle fits, and picks the tank (not its support legs) for a shape fit', async () => {
        const dir = tmp();
        result = await auditResidual({ solid: SOLID, sources: [{ node: 'residual:tank', triangles: Float32Array.from(tankTris) }], groundY: 0, dir });
        const cluster = result.clusters[0];
        expect(cluster.verdict).toBe('real-object');
        expect(cluster.slices.length).toBeGreaterThan(5);
        // some slices (through the legs, near the roof) fill few sectors; the tank body's slices fill (almost) all of them
        const legLike = cluster.slices.filter(s => s.r > 0 && s.sectors < MIN_SECTORS);
        const bodyLike = cluster.slices.filter(s => s.r > 0 && s.sectors >= MIN_SECTORS);
        expect(legLike.length).toBeGreaterThan(0);
        expect(bodyLike.length).toBeGreaterThan(0);
        for (const s of bodyLike) { expect(s.r).toBeGreaterThan(1.3); expect(s.r).toBeLessThan(1.7); expect(s.y).toBeGreaterThanOrEqual(Y0 - 0.3); expect(s.y).toBeLessThanOrEqual(Y1 + 0.3); }

        const fits = pickRadialShapeFits(result);
        expect(fits.length).toBe(1);
        const fit = fits[0];
        expect(fit.clusterId).toBe(cluster.id);
        expect(fit.baseY).toBeGreaterThanOrEqual(Y0 - 0.3);
        expect(fit.topY).toBeLessThanOrEqual(Y1 + 0.3);
        expect(fit.centerX).toBeCloseTo(CX, 0);
        expect(fit.centerZ).toBeCloseTo(CZ, 0);
        expect(fit.profileZR.length).toBe(bodyLike.length);
        for (const [, r] of fit.profileZR) { expect(r).toBeGreaterThan(1.3); expect(r).toBeLessThan(1.7); }
        expect(fit.confidence).toBeGreaterThan(0.5);
    }, 120_000);

    it('revolves a clean cylindrical solid from the measured profile (native shape-program tool), coloured with no photo as a flat clay grey', async () => {
        const fits = pickRadialShapeFits(result);
        const dir = tmp();
        const { nodes, flatColours } = await buildResidualShapeNodes(fits, dir);
        expect(nodes.length).toBe(1);
        const node = nodes[0];
        expect(node.kind).toBe('residual-shape');
        expect(node.positions.length).toBeGreaterThan(0);
        expect(node.indices.length % 3).toBe(0);
        expect(Array.from(node.ref).every(r => r === FLAT_COLOUR_REF_BASE)).toBe(true);
        expect(flatColours.get(0)).toEqual([140, 140, 140]); // no photo on this synthetic cluster: the clay fallback
        // every vertex sits within the fit's own height range; every vertex but the two cap centres (r = 0, the axis
        // point the top and bottom fan triangles share) sits within the measured radius band
        const fit = fits[0];
        let axisVertices = 0;
        for (let i = 0; i < node.positions.length / 3; i++) {
            const x = node.positions[i * 3], y = node.positions[i * 3 + 1], z = node.positions[i * 3 + 2];
            expect(y).toBeGreaterThanOrEqual(fit.baseY - 1e-3);
            expect(y).toBeLessThanOrEqual(fit.topY + 1e-3);
            const r = Math.hypot(x - fit.centerX, z - fit.centerZ);
            if (r < 0.5) { axisVertices++; continue; }
            expect(r).toBeGreaterThan(1.2);
            expect(r).toBeLessThan(1.8);
        }
        expect(axisVertices).toBe(2);
        // normals point outward (away from the axis) on the cylindrical wall, not flipped inward
        let wallI = -1;
        for (let i = 0; i < node.positions.length / 3; i++) if (Math.hypot(node.positions[i * 3] - fit.centerX, node.positions[i * 3 + 2] - fit.centerZ) > 1.2) { wallI = i; break; }
        expect(wallI).toBeGreaterThanOrEqual(0);
        const mx = node.positions[wallI * 3] - fit.centerX, mz = node.positions[wallI * 3 + 2] - fit.centerZ;
        const nx = node.normals[wallI * 3], nz = node.normals[wallI * 3 + 2];
        expect(mx * nx + mz * nz).toBeGreaterThan(0);
    }, 120_000);

    it('applyAudit drops exactly the tank body triangles and keeps the support legs as scanned', async () => {
        const fits = pickRadialShapeFits(result);
        const node: MassingNode = {
            name: 'residual:tank', kind: 'residual', provenance: 'as-scanned', confidence: null,
            positions: Float32Array.from(tankTris), normals: new Float32Array(tankTris.length),
            ref: new Int32Array(tankTris.length / 3).fill(-2), st: new Float32Array((tankTris.length / 3) * 2),
            indices: Uint32Array.from({ length: tankTris.length / 3 }, (_, i) => i)
        };
        const run = { dir: tmp(), report: { schema: 'scratchbox.staged-massing/1', faces: [], parts: [] }, nodes: [node], ms: 0, binary: { path: '', built: false } } as unknown as MassingRun;
        applyAudit(run, result, fits);
        const kept = run.nodes.find(n => n.name === 'residual:tank');
        // the legs (4 x 3 triangles) survive; the tank body (48 wall + 24 + 24 cap triangles) is dropped
        expect(kept).toBeDefined();
        expect(kept!.indices.length / 3).toBe(12);
        const shapeNode = run.nodes.find(n => n.kind === 'residual-shape');
        expect(shapeNode).toBeUndefined(); // applyAudit only drops triangles; buildResidualShapeNodes (auditMassingRun) adds the fitted node
    });
});
