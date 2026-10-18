/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The per-cluster LOD selection rule, on the CPU. It is the same rule as `projectedError` and the
 * first two tests of `cull` in VirtualGeometryRenderer's CULL_WGSL (frustum and cone culling aside);
 * change both together.
 */

export interface ClusterSelectionParams {
    eye: [number, number, number] | number[];
    /** Pixels per unit of error at distance 1: viewport height / (2 tan(fovY / 2)). */
    lodScale: number;
    /** Camera near distance: a LOD sphere closer than this (or containing the eye) always refines. */
    near: number;
    thresholdPx: number;
    /** Finest level resident on the GPU: clusters of that level are drawn as leaves. */
    finestLevel: number;
}

export interface SelectableCluster {
    level: number;
    /** LOD sphere (x, y, z, radius) and error of the group that produced the cluster. */
    self: number[];
    selfError: number;
    /** LOD sphere and error of the group the cluster was simplified in. */
    parent: number[];
    parentError: number;
}

/** Projected screen-space error of a LOD sphere, in pixels (1e30 for "always refine"). */
export function projectedLodError(sphere: number[], error: number, eye: ArrayLike<number>, lodScale: number, near: number): number {
    if (error <= 0) return 0;
    if (error >= 1e37) return 1e30;
    const d = Math.hypot(sphere[0] - eye[0], sphere[1] - eye[1], sphere[2] - eye[2]) - sphere[3];
    if (d <= near) return 1e30;
    return (error * lodScale) / d;
}

/** True when the renderer draws `c` for these parameters (before frustum and cone culling). */
export function clusterSelected(c: SelectableCluster, p: ClusterSelectionParams): boolean {
    if (c.level < p.finestLevel) return false;
    if (projectedLodError(c.parent, c.parentError, p.eye, p.lodScale, p.near) <= p.thresholdPx) return false;
    return c.level === p.finestLevel || projectedLodError(c.self, c.selfError, p.eye, p.lodScale, p.near) <= p.thresholdPx;
}
