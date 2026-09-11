/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// 3D Geospatial & Google 3D Tiles Layer
export { GooglePhotorealistic3DTilesLayer } from '../../../extensions/product/src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export type { Google3DTilesLayerOptions } from '../../../extensions/product/src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
export { Google3DTileService } from '../../../extensions/product/src/browser/generative-canvas/services/Google3DTileService';
export { TerrainManager } from '../../../extensions/product/src/browser/generative-canvas/services/TerrainManager';
export { TileClayProcessor, CLAY_PRESETS } from '../../../extensions/product/src/browser/generative-canvas/services/TileClayProcessor';
export type { ClayPresetId } from '../../../extensions/product/src/browser/generative-canvas/services/TileClayProcessor';

// Atmospheric Scattering & Diurnal Lighting Pipeline
export {
    createAtmosphericSkyDome,
    getPresetLightingState,
    getSunVectorFromAngles
} from '../../../extensions/product/src/browser/generative-canvas/services/atmosphere';
export type {
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule
} from '../../../extensions/product/src/browser/generative-canvas/services/atmosphere';
export { AerialPerspectiveEffect } from '../../../extensions/product/src/browser/generative-canvas/services/atmosphere/AerialPerspectiveEffect';

// 3D Manipulation & Mesh Sculpting Engines
export {
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    createSculptableGeometry,
    recomputeGeometryNormals
} from '../../../extensions/product/src/browser/generative-canvas/services/mesh-sculpting-engine';
export type { SculptBrushOptions } from '../../../extensions/product/src/browser/generative-canvas/services/mesh-sculpting-engine';

export {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../../../extensions/product/src/browser/generative-canvas/services/transform-gizmo-engine';
export type { GizmoHandleType } from '../../../extensions/product/src/browser/generative-canvas/services/transform-gizmo-engine';

export {
    DirectDispatchOperatorEngine,
    createOperatorEngine
} from '../../../extensions/product/src/browser/generative-canvas/services/direct-dispatch-operator-engine';

// Client-Side Canvas Controllers & Transformers
export { ProjectArtifactController } from '../../../extensions/product/src/browser/generative-canvas/project-artifact-controller';
export { morphArtifact } from '../../../extensions/product/src/browser/generative-canvas/primitive-transformer-engine';
