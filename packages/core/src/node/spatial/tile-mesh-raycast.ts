/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Vertical raycasts against a Photorealistic 3D Tiles mesh (an extracted clay/texture GLB as a triangle soup).
 * Triangles are bucketed on a horizontal grid so a downward ray only tests the few under it; meshes of a million
 * triangles answer thousands of rays in well under a second.
 *
 * The extraction frame is local ENU at the mesh anchor (+X east, +Y up, -Z north). Y = 0 sits at a known height
 * above the WGS84 ellipsoid (the extraction reports it), so a hit's height above sea level is
 * Y + originEllipsoidalHeightM - N, with N the EGM96 undulation at the anchor.
 */
import type { TriangleSoup } from '../3d-engine/part-connectivity';
import { wgs84ToLocalEnu } from './GoogleVectorTileService';
import { geoidUndulation } from './egm96-geoid';

export interface TileMeshFrame {
    soup: TriangleSoup;
    anchorLat: number;
    anchorLng: number;
    /** Ellipsoid height of local Y = 0 (Google3DTile3DObjectResult.frame.originEllipsoidalHeightM). */
    originEllipsoidalHeightM: number;
}

export class TileMeshRaycaster {
    private readonly cell: number;
    private readonly minX: number;
    private readonly minZ: number;
    private readonly cols: number;
    private readonly rows: number;
    private readonly buckets: Uint32Array[];
    /** Height above sea level of local Y = 0. */
    readonly originMsl: number;

    constructor(readonly frame: TileMeshFrame, cellMeters = 4) {
        const p = frame.soup.positions, idx = frame.soup.indices;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < p.length; i += 3) {
            minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
            minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
        }
        this.originMsl = frame.originEllipsoidalHeightM - geoidUndulation(frame.anchorLat, frame.anchorLng);
        this.cell = cellMeters;
        this.minX = minX; this.minZ = minZ;
        this.cols = Math.max(1, Math.ceil((maxX - minX) / cellMeters) + 1);
        this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellMeters) + 1);
        const lists: number[][] = Array.from({ length: this.cols * this.rows }, () => []);
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const c0 = Math.floor((Math.min(p[a], p[b], p[c]) - minX) / cellMeters), c1 = Math.floor((Math.max(p[a], p[b], p[c]) - minX) / cellMeters);
            const r0 = Math.floor((Math.min(p[a + 2], p[b + 2], p[c + 2]) - minZ) / cellMeters), r1 = Math.floor((Math.max(p[a + 2], p[b + 2], p[c + 2]) - minZ) / cellMeters);
            for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) lists[r * this.cols + col].push(t);
        }
        this.buckets = lists.map(l => Uint32Array.from(l));
    }

    /** Highest surface under (x, z) in mesh-local coordinates, or undefined if the ray misses. */
    topHitLocal(x: number, z: number): number | undefined {
        const col = Math.floor((x - this.minX) / this.cell), row = Math.floor((z - this.minZ) / this.cell);
        if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return undefined;
        const p = this.frame.soup.positions, idx = this.frame.soup.indices;
        let best: number | undefined;
        for (const t of this.buckets[row * this.cols + col]) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2];
            const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (Math.abs(det) < 1e-12) continue; // vertical triangle: no unique height under the ray
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
            const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1];
            if (best === undefined || y > best) best = y;
        }
        return best;
    }

    /** Highest tile surface at a lat/lng, in meters above sea level. */
    topHitMsl(latDeg: number, lngDeg: number): number | undefined {
        const { x, z } = wgs84ToLocalEnu(latDeg, lngDeg, this.frame.anchorLat, this.frame.anchorLng, this.originMsl);
        const y = this.topHitLocal(x, z);
        return y === undefined ? undefined : y + this.originMsl;
    }
}
