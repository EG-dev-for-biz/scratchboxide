/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What pipeline K's street band (street-band.ts) needs around its Street View survey: how many views it asks for, the tile
 * mesh around the structure (its own scan cut away, the rebuilt twin standing in for it) and the two put together for the
 * views' depth.
 */

import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';

/**
 * Views the survey asks for (one wide view a face first, then each face's next best pano), each also aimed at the street
 * level: up to twice this many images, about $0.007 each.
 */
export const STREET_BAND_VIEWS = 12;

/** The structure's own scan is cut from the context within this of its outline (m): the twin stands in for it. */
export const CONTEXT_CUT_M = 1.5;

/** Distance (m) from (x, z) to a polygon's boundary, negative inside. */
function signedDistance(poly: Vec2[], x: number, z: number): number {
    let inside = false, d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        const ex = xj - xi, ez = zj - zi, l2 = ex * ex + ez * ez;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / l2)) : 0;
        d = Math.min(d, Math.hypot(x - (xi + t * ex), z - (zi + t * ez)));
    }
    return inside ? -d : d;
}

/** The tile mesh without the structure's own scan: triangles whose centroid lies within cutM of its outline (or inside it) dropped. */
export function contextOutsideOutline(mesh: RenderMesh3D, outline: Vec2[], cutM = CONTEXT_CUT_M): RenderMesh3D {
    if (outline.length < 3) return mesh;
    const V = mesh.vertices, I = mesh.indices, kept: number[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        if (signedDistance(outline, (V[a] + V[b] + V[c]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3) <= cutM) continue;
        kept.push(I[t], I[t + 1], I[t + 2]);
    }
    return { vertices: mesh.vertices, indices: Uint32Array.from(kept) };
}

/** Two meshes as one. */
export function mergeMeshes(a: RenderMesh3D, b: RenderMesh3D): RenderMesh3D {
    const vertices = new Float32Array(a.vertices.length + b.vertices.length);
    vertices.set(a.vertices); vertices.set(b.vertices, a.vertices.length);
    const indices = new Uint32Array(a.indices.length + b.indices.length), base = a.vertices.length / 3;
    indices.set(a.indices);
    for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + base;
    return { vertices, indices };
}
