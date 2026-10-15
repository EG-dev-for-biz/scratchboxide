/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive Scene Chunk Planner.
 * Implements perspective-aware depth-region chunking derived from the
 * "Building Rome from a Single Image" adaptive chunking algorithm.
 *
 * Core invariant: physical chunk size doubles per depth region (6m, 12m, 24m, 48m...)
 * so nearby regions preserve fine geometric detail while distant regions extend
 * coverage at coarser physical resolution — all within the same canonical 3m volume.
 ********************************************************************************/

import type { Adaptive3DSceneContract, SceneChunkRegion } from '../../common/spatial/adaptive-3d-scene-contract';

export interface ChunkDescriptor {
    regionIndex: number;
    lateralIndex: number;
    /** World-space XZ origin (lower-left corner of chunk) */
    originMeters: [number, number, number];
    physicalExtentMeters: number;
    physicalOverlapMeters: number;
    gridResolution: number;
}

export interface ChunkAllocationPlan {
    chunks: ChunkDescriptor[];
    regionCount: number;
    totalPhysicalDepthMeters: number;
    totalPhysicalWidthMeters: number;
}

const CANONICAL_L = 3.0;         // paper's fixed canonical volume side length (meters)
const BASE_SCALE = 2;            // a_0: first region = 2 × 3m = 6m physical
const GRID_RES = 48;             // constant vertex count per axis per chunk
const CANONICAL_OVERLAP = 0.5;  // meters overlap in canonical space; physical = 0.5 * a_i
const HEIGHT_TRIGGER_M = 2.8;   // p99 structure height that triggers an extra scale bump
const MAX_SCALE = 16;            // caps physical extent at 48m

export class AdaptiveSceneChunkPlanner {
    plan(contract: Adaptive3DSceneContract): ChunkAllocationPlan {
        const env = contract.sceneGraph?.terrain?.envelope;
        const totalWidth  = env?.width  ?? 150;
        const totalDepth  = env?.depth  ?? 150;
        if (!(Number.isFinite(totalWidth) && totalWidth > 0 && Number.isFinite(totalDepth) && totalDepth > 0)) {
            throw new Error(`Terrain envelope must have a positive finite width and depth (got ${totalWidth} x ${totalDepth})`);
        }
        const halfWidth   = totalWidth  / 2;
        const halfDepth   = totalDepth  / 2;

        const chunks: ChunkDescriptor[] = [];
        let regionIndex = 0;
        let scaleFactor = BASE_SCALE;
        let zFront = -halfDepth;   // leading edge of next row in world-space Z

        while (zFront < halfDepth) {
            const physExt     = scaleFactor * CANONICAL_L;
            const physOverlap = CANONICAL_OVERLAP * scaleFactor;

            const lateralCount = Math.ceil(totalWidth / physExt);

            for (let lat = 0; lat < lateralCount; lat++) {
                const originX = -halfWidth + lat * physExt;
                chunks.push({
                    regionIndex,
                    lateralIndex: lat,
                    originMeters: [originX, 0, zFront],
                    physicalExtentMeters: physExt,
                    physicalOverlapMeters: physOverlap,
                    gridResolution: GRID_RES
                });
            }

            zFront += physExt - physOverlap;
            regionIndex++;

            // Next region: double scale, then apply height criterion
            let nextScale = Math.min(scaleFactor * 2, MAX_SCALE);
            const nextBandZ1 = zFront + nextScale * CANONICAL_L;
            if (this.maxStructureHeightInBand(contract, zFront, nextBandZ1) > HEIGHT_TRIGGER_M) {
                nextScale = Math.min(nextScale * 2, MAX_SCALE);
            }
            scaleFactor = nextScale;
        }

        return {
            chunks,
            regionCount: regionIndex,
            totalPhysicalDepthMeters: zFront + halfDepth,
            totalPhysicalWidthMeters: totalWidth
        };
    }

    /** Returns max structure height (floorCount × floorHeight) in the given world-Z band. */
    private maxStructureHeightInBand(
        contract: Adaptive3DSceneContract,
        zMin: number,
        zMax: number
    ): number {
        let maxH = 0;
        for (const s of contract.architecture.structures) {
            const sz = s.position[2];
            if (sz >= zMin && sz <= zMax) {
                maxH = Math.max(maxH, s.dimensions.floorCount * s.dimensions.floorHeight);
            }
        }
        return maxH;
    }

    /** Converts a ChunkDescriptor to the SceneChunkRegion embedded in a contract. */
    static toChunkRegion(desc: ChunkDescriptor): SceneChunkRegion {
        return {
            origin:               desc.originMeters,
            physicalExtentMeters: desc.physicalExtentMeters,
            physicalOverlapMeters: desc.physicalOverlapMeters,
            regionIndex:          desc.regionIndex,
            gridResolution:       desc.gridResolution
        };
    }
}
