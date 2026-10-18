/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { Scene3DData } from '../../canvas-types';

/** Body of POST /3d/virtual-geometry/build for a scene's source GLB. */
export interface VirtualGeometryBuildRequest {
    sourceGlbPath: string;
    workspaceRoot?: string;
}

/**
 * What the viewport loads for a scene. With a source GLB it always asks the server first: the server
 * hashes the GLB (memoised by inode, size and mtime) and the builder, so a saved sbvgUrl from an older GLB
 * or builder is replaced by the current one instead of being trusted. The root is the one the path was
 * stored relative to (virtualGeometry.workspaceRoot), falling back to the open workspace.
 * Only a scene without a source loads its sbvgUrl as is.
 */
export function virtualGeometryLoadPlan(
    vg: Scene3DData['virtualGeometry'] | undefined,
    openWorkspace?: string
): { kind: 'build'; request: VirtualGeometryBuildRequest } | { kind: 'url'; url: string } | { kind: 'none' } {
    const sourceGlbPath = vg?.sourceGlbPath?.trim();
    if (sourceGlbPath) {
        const workspaceRoot = vg?.workspaceRoot || openWorkspace;
        return { kind: 'build', request: { sourceGlbPath, ...(workspaceRoot ? { workspaceRoot } : {}) } };
    }
    if (vg?.sbvgUrl) return { kind: 'url', url: vg.sbvgUrl };
    return { kind: 'none' };
}
