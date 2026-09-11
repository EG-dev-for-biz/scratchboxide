/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// 3D Geospatial & Google 3D Tiles Layer
export { GooglePhotorealistic3DTilesLayer } from './browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export type { Google3DTilesLayerOptions } from './browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export { Google3DTileService } from './browser/generative-canvas/services/Google3DTileService';
export { TerrainManager } from './browser/generative-canvas/services/TerrainManager';
export { TileClayProcessor, CLAY_PRESETS } from './browser/generative-canvas/services/TileClayProcessor';
export type { ClayPresetId } from './browser/generative-canvas/services/TileClayProcessor';

// Atmospheric Scattering & Diurnal Lighting Pipeline
export {
    createAtmosphericSkyDome,
    getPresetLightingState,
    getSunVectorFromAngles
} from './browser/generative-canvas/services/atmosphere';
export type {
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule
} from './browser/generative-canvas/services/atmosphere';
export { AerialPerspectiveEffect } from './browser/generative-canvas/services/atmosphere/AerialPerspectiveEffect';

// 3D Manipulation & Mesh Sculpting Engines
export {
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    createSculptableGeometry,
    recomputeGeometryNormals
} from './browser/generative-canvas/services/mesh-sculpting-engine';
export type { SculptBrushOptions } from './browser/generative-canvas/services/mesh-sculpting-engine';

export {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from './browser/generative-canvas/services/transform-gizmo-engine';
export type { GizmoHandleType } from './browser/generative-canvas/services/transform-gizmo-engine';

export {
    DirectDispatchOperatorEngine,
    createOperatorEngine
} from './browser/generative-canvas/services/direct-dispatch-operator-engine';

// Client-Side Canvas Controllers & Transformers
export { ProjectArtifactController } from './browser/generative-canvas/project-artifact-controller';
export { morphArtifact } from './browser/generative-canvas/primitive-transformer-engine';
