/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeConvexHull3D, DegenerateConvexHullError, type ConvexHull3D } from '../src/common/spatial/quickhull3d';
import { Universal3DStructureFoundation, ConvexHullOptionError } from '../src/node/spatial/Universal3DStructureFoundation';
import { createSeededRng } from '../src/node/spatial/ProceduralSfMDatasetService';
import {
    universal3DStructureHandlers,
    UnknownUniversalStructureError,
    UniversalStructureArgumentError
} from '../src/node/gemini/tools/universal-3d-structure-tools';

const ctx: any = { workspaceRoot: process.cwd() };

function signedVolume(h: ConvexHull3D): number {
    let vol = 0;
    for (let i = 0; i < h.indices.length; i += 3) {
        const [a, b, c] = [h.vertices[h.indices[i]], h.vertices[h.indices[i + 1]], h.vertices[h.indices[i + 2]]];
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return vol;
}

/** Max signed distance of any point above any hull face (<= ~0 when every point is inside). */
function maxOutsideDistance(h: ConvexHull3D, pts: ArrayLike<number>): number {
    let worst = -Infinity;
    for (let i = 0; i < h.indices.length; i += 3) {
        const [a, b, c] = [h.vertices[h.indices[i]], h.vertices[h.indices[i + 1]], h.vertices[h.indices[i + 2]]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        for (let p = 0; p < pts.length; p += 3) {
            const d = ((pts[p] - a[0]) * n[0] + (pts[p + 1] - a[1]) * n[1] + (pts[p + 2] - a[2]) * n[2]) / len;
            if (d > worst) worst = d;
        }
    }
    return worst;
}

describe('computeConvexHull3D (Quickhull)', () => {
    it('returns exactly the 8 corners and 12 outward triangles of a cube with interior points', () => {
        const pts: number[] = [];
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push(x, y, z);
        const rng = createSeededRng(7);
        for (let i = 0; i < 500; i++) pts.push(rng() * 1.8 - 0.9, rng() * 1.8 - 0.9, rng() * 1.8 - 0.9);
        // face-interior points must not become hull vertices either
        pts.push(1, 0.2, -0.3, 0, -1, 0.5);

        const hull = computeConvexHull3D(pts);
        expect(hull.vertices.length).toBe(8);
        expect(hull.indices.length / 3).toBe(12);
        for (const v of hull.vertices) for (const c of v) expect(Math.abs(c)).toBe(1);
        expect(signedVolume(hull)).toBeCloseTo(8, 9);
        expect(maxOutsideDistance(hull, pts)).toBeLessThan(1e-9);
    });

    it('returns the 6 vertices and 8 faces of an octahedron', () => {
        const pts = [1, 0, 0, -1, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0, 3, 0, 0, -3, 0.1, 0.1, 0.1, -0.2, 0.3, 0.4];
        const hull = computeConvexHull3D(pts);
        expect(hull.vertices.length).toBe(6);
        expect(hull.indices.length / 3).toBe(8);
        // octahedron volume = (4/3) * a * b * c
        expect(signedVolume(hull)).toBeCloseTo((4 / 3) * 1 * 2 * 3, 9);
        expect(hull.sourceIndices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('keeps every point of a seeded sphere cloud on or inside a closed hull (Euler F = 2V - 4)', () => {
        const rng = createSeededRng(42);
        const pts: number[] = [];
        for (let i = 0; i < 400; i++) {
            const z = rng() * 2 - 1, t = rng() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
            const k = i % 2 === 0 ? 1 : 0.9 * rng();
            pts.push(r * Math.cos(t) * k, r * Math.sin(t) * k, z * k);
        }
        const hull = computeConvexHull3D(pts);
        expect(hull.vertices.length).toBe(200); // every surface point is extreme, no interior point is
        expect(hull.indices.length / 3).toBe(2 * hull.vertices.length - 4);
        expect(maxOutsideDistance(hull, pts)).toBeLessThan(1e-6);
        const vol = signedVolume(hull);
        expect(vol).toBeGreaterThan(3.5);
        expect(vol).toBeLessThan((4 / 3) * Math.PI);
    });

    it('throws a typed error for coplanar input instead of inventing a volume', () => {
        expect(() => computeConvexHull3D([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0])).toThrow(DegenerateConvexHullError);
    });
});

describe('Universal3DStructureFoundation convex hull and seeding', () => {
    it('convex_hull mode returns the true hull of the mesh, not 8 OBB corners', () => {
        const sphere = Universal3DStructureFoundation.createFromProcedural('sphere', { scale: 2, center: [0, 0, 0], pointDensity: 50 });
        const hull = sphere.computeCollisionEnvelope({ mode: 'convex_hull' });
        expect(hull.type).toBe('convex_hull');
        expect(hull.convexVertices!.length).toBeGreaterThan(300);
        for (const v of hull.convexVertices!) expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(2, 4);
        expect(maxOutsideDistance({ vertices: hull.convexVertices!, indices: Array.from(hull.indices!), sourceIndices: [] }, sphere.mesh.vertices)).toBeLessThan(1e-4);
        expect(hull.radius).toBeCloseTo(2, 4);
    });

    it('rejects a safety margin on convex_hull rather than returning an un-inflated hull', () => {
        const box = Universal3DStructureFoundation.createFromProcedural('box', { scale: 1, pointDensity: 10 });
        expect(() => box.computeCollisionEnvelope({ mode: 'convex_hull', safetyMarginMeters: 1 })).toThrow(ConvexHullOptionError);
        expect(() => box.computeCollisionEnvelope({ mode: 'convex_hull', maxHullVertices: 4 })).toThrow(ConvexHullOptionError);
    });

    it('point sampling is deterministic per seed', () => {
        const a = Universal3DStructureFoundation.createFromProcedural('sphere', { pointDensity: 100, seed: 5 });
        const b = Universal3DStructureFoundation.createFromProcedural('sphere', { pointDensity: 100, seed: 5 });
        const c = Universal3DStructureFoundation.createFromProcedural('sphere', { pointDensity: 100, seed: 6 });
        expect(a.points.map(p => p.position)).toEqual(b.points.map(p => p.position));
        expect(a.points.map(p => p.position)).not.toEqual(c.points.map(p => p.position));

        a.resynchronizePoints(80, 9);
        const first = a.points.map(p => p.position);
        a.resynchronizePoints(80, 9);
        expect(a.points.map(p => p.position)).toEqual(first);
    });

    it('torus meshes lie on the torus the points are sampled from (not a cylinder)', () => {
        const t = Universal3DStructureFoundation.createFromProcedural('torus', { scale: 2, center: [0, 0, 0], pointDensity: 50 });
        const v = t.mesh.vertices;
        for (let i = 0; i < v.length; i += 3) {
            const ring = Math.hypot(v[i], v[i + 2]) - 2;
            expect(Math.hypot(ring, v[i + 1])).toBeCloseTo(0.7, 4);
        }
        for (const p of t.points) {
            const ring = Math.hypot(p.position[0], p.position[2]) - 2;
            expect(Math.hypot(ring, p.position[1])).toBeCloseTo(0.7, 4);
        }
    });
});

describe('universal_3d_structure tool handlers', () => {
    it('an unknown structure name with no source is a typed error, not a default 10 m box', async () => {
        await expect(universal3DStructureHandlers.universal_3d_structure_export({ name: 'never_created_xyz', format: 'glb' }, ctx))
            .rejects.toBeInstanceOf(UnknownUniversalStructureError);
        await expect(universal3DStructureHandlers.universal_3d_structure_animate({ name: 'never_created_xyz' }, ctx))
            .rejects.toBeInstanceOf(UnknownUniversalStructureError);
        await expect(universal3DStructureHandlers.universal_3d_structure_get_collision_hull({ name: 'never_created_xyz' }, ctx))
            .rejects.toBeInstanceOf(UnknownUniversalStructureError);
    });

    it('an unimplemented proceduralType is rejected instead of meshing a cylinder', async () => {
        await expect(universal3DStructureHandlers.universal_3d_structure_create({ name: 'p', proceduralType: 'plane' }, ctx))
            .rejects.toBeInstanceOf(UniversalStructureArgumentError);
    });

    it('ingests a .glb through inputGlbPath and reports what part of the file was read', async () => {
        const src = Universal3DStructureFoundation.createFromProcedural('sphere', { scale: 3, pointDensity: 20 });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u3d-glb-'));
        const glbPath = path.join(dir, 'sphere.glb');
        fs.writeFileSync(glbPath, src.toGlbBuffer());

        const res = await universal3DStructureHandlers.universal_3d_structure_create(
            { name: 'from_glb', inputGlbPath: glbPath, pointDensity: 64, seed: 3 }, ctx
        );
        const s = res.resultPayload.structure as any;
        expect(s.vertexCount).toBe(src.mesh.vertices.length / 3);
        expect(s.pointCount).toBe(64);
        expect(s.glbSource.path).toBe(glbPath);
        expect(s.glbSource.primitivesInFile).toBeGreaterThanOrEqual(1);

        const hullRes = await universal3DStructureHandlers.universal_3d_structure_get_collision_hull({ name: 'from_glb', mode: 'convex_hull' }, ctx);
        const hull = hullRes.resultPayload.collisionHull as any;
        expect(hull.type).toBe('convex_hull');
        for (const v of hull.vertices) expect(Math.hypot(v[0], v[1] - 3, v[2])).toBeCloseTo(3, 3);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
