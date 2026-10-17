/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The scene data a staged artifact carries (§6.1), as the harness mounts it. */

import type { StagedBuildState, StagedLayer } from '../../src/common/spatial/staged-location-contracts';

export interface StagedSceneOpts {
    renderMode?: 'clay' | 'shaded';
    camera?: { position: [number, number, number]; target: [number, number, number] };
    /** Omit stagedBuild: the same objects as a plain scene (the static reference render). */
    plain?: boolean;
    /** A geodetic anchor as the live staged artifact carries (it makes the viewport treat the scene as geospatial, large scale). */
    geoAnchor?: { lat: number; lng: number; elevation?: number };
}

export const FIXTURE_CAMERA = { position: [30, 21, 33] as [number, number, number], target: [0, 6, 0] as [number, number, number] };

export function stagedSceneData(state: StagedBuildState, opts: StagedSceneOpts = {}): Record<string, unknown> {
    const objects = state.layers.filter((l: StagedLayer) => !l.retired).map(l => ({
        id: l.objectId,
        content: {
            type: '3d-model',
            durableUri: l.url,
            mimeType: 'model/gltf-binary',
            metadata: { role: 'environment', source: 'google3dtilesclay', stage: l.stage }
        },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }
    }));
    return {
        title: `Staged build ${state.runId}`,
        renderMode: opts.renderMode ?? 'clay',
        cameraMode: 'orbit',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        groundTileMode: 'photoreal-clay',
        camera: opts.camera ?? FIXTURE_CAMERA,
        objects,
        ...(opts.geoAnchor ? { geoAnchor: opts.geoAnchor } : {}),
        ...(opts.plain ? {} : { stagedBuild: state })
    };
}
