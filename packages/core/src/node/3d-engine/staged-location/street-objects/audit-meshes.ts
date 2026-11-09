/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district residual audit of a built district's own meshes (MAIN, 2026-11-09: read the blobs of the K-D district we
 * ship, not the raw scan's). A pipeline K-D build leaves one remeshed mesh per chunk, each cut to what its chunk keeps and
 * placed in the district's frame; their own audits ran in the cloud and stay there. This audits them here, one chunk at a
 * time, with the audit the build runs (district-residual-audit.ts auditDistrict, Google's vector buildings, roads and
 * water), and joins the clusters into one result: ids made unique per chunk, counts summed, the ground the median of the
 * chunks'. Each cluster keeps its measures; its triangle ids index its own chunk's mesh (`chunk` names it).
 */

import * as path from 'path';
import { auditDistrict } from '../district-residual-audit';
import type { AuditedCluster, ResidualAuditResult } from '../residual-audit';
import type { EvidenceLookup, VectorEvidence } from '../vector-footprints';
import { buildGroundModel, loadScanMesh } from '../../../spatial/StreetViewSurveyPlanner';

/** Cluster ids of chunk k start at k * CHUNK_ID_STRIDE. */
export const CHUNK_ID_STRIDE = 100_000;

export interface MeshAuditChunk { glb: string; clusters: number; triangles: number; ms: number; error?: string }

export async function auditMeshes(input: {
    glbs: string[]; look: Pick<EvidenceLookup, 'buildingAt' | 'waterAt' | 'roadAt'>; vector: Pick<VectorEvidence, 'roads' | 'rails'>;
    dir: string; signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<{ audit: ResidualAuditResult & { chunks: MeshAuditChunk[] }; chunks: MeshAuditChunk[] }> {
    const clusters: Array<AuditedCluster & { chunk?: string }> = [], grounds: number[] = [], chunks: MeshAuditChunk[] = [];
    let first: ResidualAuditResult | undefined;
    const counts = { clusters: 0, realObjects: 0, artefacts: 0, unsure: 0, removedTriangles: 0, keptTriangles: 0, removedAreaM2: 0 };
    for (const [k, glb] of input.glbs.entries()) {
        const t0 = Date.now();
        input.onProgress?.(`auditing chunk ${k + 1} of ${input.glbs.length}: ${path.basename(glb)}`);
        try {
            const scan = loadScanMesh(glb);
            const ground = buildGroundModel(scan, { cellMeters: 1, water: input.look.waterAt, road: input.look.roadAt });
            const r = await auditDistrict({
                scan, ground, buildingAt: input.look.buildingAt, waterAt: input.look.waterAt, within: () => true, rails: input.vector.rails ?? [], roads: input.vector.roads,
                dir: path.join(input.dir, `chunk_${k}`), ...(input.signal ? { signal: input.signal } : {}), idPrefix: `district/chunk${k}`
            });
            const a = r.audit;
            first ??= a;
            if (a.groundY !== null && Number.isFinite(a.groundY)) grounds.push(a.groundY);
            for (const c of a.clusters) clusters.push({ ...c, id: k * CHUNK_ID_STRIDE + c.id, chunk: path.basename(glb) });
            for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += a.counts[key] ?? 0;
            chunks.push({ glb: path.basename(glb), clusters: a.clusters.length, triangles: scan.triCount, ms: Date.now() - t0 });
        } catch (err) {
            if (input.signal?.aborted) throw err;
            chunks.push({ glb: path.basename(glb), clusters: 0, triangles: 0, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
        }
    }
    if (!first) throw new Error(`no chunk could be audited (${chunks.map(c => c.error).filter(Boolean)[0] ?? 'no meshes given'})`);
    grounds.sort((a, b) => a - b);
    const audit = {
        ...first, clusters, counts, groundY: grounds.length ? grounds[grounds.length >> 1] : null, sources: [],
        notes: [`the district residual audit of ${input.glbs.length} meshes, one chunk at a time: ${clusters.length} clusters (${counts.realObjects} real objects, ${counts.artefacts} scan artefacts, ${counts.unsure} unsure)`, ...chunks.filter(c => c.error).map(c => `${c.glb}: not audited (${c.error})`)],
        chunks
    };
    return { audit, chunks };
}
