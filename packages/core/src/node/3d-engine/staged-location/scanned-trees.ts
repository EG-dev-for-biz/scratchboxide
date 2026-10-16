/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A failed tree stage puts the scanned trees back (user decision): the triangles strip removed from the photo tiles
 * (the measured crowns, and the canopy that hung on them) are written as a layer of their own, as they were
 * downloaded, labelled as scanned.
 *
 * Which triangles strip removed is read from its own input and output, not re-guessed: strip copies the triangles it
 * keeps into the devegetated tile unchanged (Central Park on trees-fix: 68,506 of 683,128 input triangles found in the
 * output at 1 mm, against stats' 68,501 kept), so the removed ones are the input triangles absent from the output.
 * Each removed triangle is given to the measured crown whose footprint holds its centroid (one node per crown, in
 * crown order); the rest went with the trees they hung on and form one more node. An isolated structure keeps only
 * those within its remeshed extent. Nothing is added, moved or smoothed.
 */

import * as fs from 'fs';
import { readGlbScene, type GlbScenePrimitive } from '../../spatial/StreetViewPoseRegistrar';
import { PROVENANCE, type ProvenanceRecord, type StagedNodeExtras } from '../../../common/spatial/staged-location-contracts';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';

export interface ScannedTreesRequest {
    /** The photo-textured extraction strip measured (its input). */
    rawGlb: string;
    /** strip's devegetated output. */
    devegetatedGlb: string;
    /** strip's crowns.json. */
    crownsJson: string;
    outGlb: string;
    /** Keep only triangles whose centroid lies in this XZ box (an isolated structure's remeshed extent). */
    keepXZ?: { minX: number; maxX: number; minZ: number; maxZ: number };
    /** Why the trees were put back (the tree stage's failure), for the provenance note. */
    reason: string;
    /** Vertex match tolerance (m); default 1 mm. */
    quantM?: number;
}

export interface ScannedTreesResult {
    glbPath: string;
    bytes: number;
    triangles: number;
    vertices: number;
    /** Removed triangles per measured crown, in crown order. */
    crowns: Array<{ crownId: number; triangles: number }>;
    /** Removed triangles outside every measured crown footprint (canopy that went with the trees). */
    canopyWithTreesTriangles: number;
    inputTriangles: number;
    keptTriangles: number;
    ms: number;
}

interface Crown { id: number; status: string; footprint?: Array<[number, number]> }

/** Statuses whose crown strip took out of the scan. */
const REMOVED_STATUSES = new Set(['tree', 'cut_at_boundary_removed']);

/** A 53-bit hash of a triangle's three vertices quantised to `q` metres, independent of vertex order. */
function triangleHash(p: Float32Array, a: number, b: number, c: number, q: number): number {
    const v = [a, b, c].map(i => [Math.round(p[i * 3] / q), Math.round(p[i * 3 + 1] / q), Math.round(p[i * 3 + 2] / q)]);
    v.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let h1 = 0x811c9dc5 | 0, h2 = 0x9e3779b9 | 0;
    for (const vertex of v) {
        for (const k of vertex) {
            h1 = Math.imul(h1 ^ (k | 0), 0x01000193);
            h2 = Math.imul(h2 ^ ((k | 0) + 0x7f4a7c15), 0x85ebca6b);
            h2 ^= h2 >>> 13;
        }
    }
    return (h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff);
}

function pointInPolygon(x: number, z: number, poly: Array<[number, number]>): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

export function putBackScannedTrees(req: ScannedTreesRequest): ScannedTreesResult {
    const t0 = Date.now();
    const q = req.quantM ?? 0.001;
    const kept = readGlbScene(req.devegetatedGlb);
    const keptHashes = new Set<number>();
    let keptTriangles = 0;
    for (const p of kept) {
        for (let t = 0; t < p.indices.length; t += 3) keptHashes.add(triangleHash(p.positions, p.indices[t], p.indices[t + 1], p.indices[t + 2], q));
        keptTriangles += p.indices.length / 3;
    }
    const crownsDoc = JSON.parse(fs.readFileSync(req.crownsJson, 'utf8'));
    const crowns: Crown[] = (Array.isArray(crownsDoc.crowns) ? crownsDoc.crowns : [])
        .filter((c: Crown) => REMOVED_STATUSES.has(c.status) && Array.isArray(c.footprint) && c.footprint.length >= 3)
        .sort((a: Crown, b: Crown) => a.id - b.id);
    // crowns binned by footprint bounds on a 4 m grid
    const CELL = 4;
    const grid = new Map<string, number[]>();
    crowns.forEach((c, ci) => {
        const xs = c.footprint!.map(p => p[0]), zs = c.footprint!.map(p => p[1]);
        for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
            for (let k = Math.floor(Math.min(...zs) / CELL); k <= Math.floor(Math.max(...zs) / CELL); k++) {
                const key = `${i},${k}`;
                const list = grid.get(key);
                if (list) list.push(ci); else grid.set(key, [ci]);
            }
        }
    });
    const crownOf = (x: number, z: number): number => {
        for (const ci of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
            if (pointInPolygon(x, z, crowns[ci].footprint!)) return ci;
        }
        return -1;
    };

    // removed triangles, grouped by crown (index crowns.length = outside every crown)
    const raw: GlbScenePrimitive[] = readGlbScene(req.rawGlb);
    const groups: Array<Array<[number, number]>> = Array.from({ length: crowns.length + 1 }, () => []);
    let inputTriangles = 0;
    const box = req.keepXZ;
    raw.forEach((p, pi) => {
        const P = p.positions, I = p.indices;
        for (let t = 0; t < I.length; t += 3) {
            inputTriangles++;
            const a = I[t], b = I[t + 1], c = I[t + 2];
            if (keptHashes.has(triangleHash(P, a, b, c, q))) continue;
            const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
            if (box && (cx < box.minX || cx > box.maxX || cz < box.minZ || cz > box.maxZ)) continue;
            const ci = crownOf(cx, cz);
            groups[ci < 0 ? crowns.length : ci].push([pi, t]);
        }
    });

    const provenance = (crownId?: number): ProvenanceRecord => ({
        label: PROVENANCE.asScanned,
        measuredGeometry: true,
        method: 'Google 3D Tiles triangles as downloaded: what tile_vegetation strip removed as measured trees, put back unchanged',
        sources: [{ kind: 'stage-output', id: 'trees-measure:strip' }],
        note: `put back as scanned because the tree stage failed: ${req.reason}${crownId === undefined ? '; canopy outside the measured crowns that went with the trees' : ''}`
    });
    const nodes: StagedGlbNode[] = [];
    const used = groups.map((g, gi) => ({ g, gi })).filter(x => x.g.length > 0);
    const summary: ScannedTreesResult['crowns'] = [];
    let vertices = 0, triangles = 0;
    used.forEach(({ g, gi }, order) => {
        const remap = new Map<number, number>();
        const pos: number[] = [];
        const idx = new Uint32Array(g.length * 3);
        g.forEach(([pi, t], k) => {
            const p = raw[pi];
            for (let j = 0; j < 3; j++) {
                const v = p.indices[t + j];
                const id = pi * 0x100000000 + v;
                let n = remap.get(id);
                if (n === undefined) {
                    n = pos.length / 3;
                    remap.set(id, n);
                    pos.push(p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]);
                }
                idx[k * 3 + j] = n;
            }
        });
        const crownId = gi < crowns.length ? crowns[gi].id : undefined;
        if (crownId !== undefined) summary.push({ crownId, triangles: g.length });
        const extras: StagedNodeExtras = {
            sb: {
                schema: 'scratchbox.staged-node/2',
                stage: 'trees',
                provenance: provenance(crownId),
                buildOrder: order,
                buildCount: used.length,
                revealKind: 'appear',
                reveal: { attribute: null, displacement: null, durationShare: Math.max(1e-6, g.length / Math.max(1, used.reduce((s, u) => s + u.g.length, 0))) },
                ids: crownId !== undefined ? { crownId } : {},
                counts: { vertices: pos.length / 3, triangles: g.length }
            }
        };
        nodes.push({ name: crownId !== undefined ? `scanned_crown_${crownId}` : 'scanned_canopy_with_trees', positions: Float32Array.from(pos), indices: idx, extras });
        vertices += pos.length / 3;
        triangles += g.length;
    });
    const written = writeStagedGlbFile(req.outGlb, nodes, { copyright: 'Google' });
    return {
        glbPath: written.path, bytes: written.bytes, triangles, vertices, crowns: summary,
        canopyWithTreesTriangles: groups[crowns.length].length, inputTriangles, keptTriangles, ms: Date.now() - t0
    };
}
