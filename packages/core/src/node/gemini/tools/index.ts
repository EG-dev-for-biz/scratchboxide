/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export * from './types';
export * from './workspace-tools';
export * from './lens-browser-tools';
export * from './canvas-tools';
export * from './spatial-tools';
export * from './atmosphere-tools';
export * from './vfx-video-tools';
export * from './mesh-shaping-tools';
export * from './sb-rig-tools';
export * from './nano-banana-tools';
export * from './algorithmic-uv-tools';
export * from './adaptive-matchmove-tools';
export * from './botanical-tree-tools';
export * from './lighting-tools';
export * from './universal-3d-structure-tools';
export * from './python-3d-tools';
export * from './image-to-pbr-tools';
export * from './turnaround-tools';
export * from './pbr-material-tools';
export * from './local-sf3d-tools';
export * from './tile-refine-tools';
export * from './object-reference-tools';


import type { ToolDeclaration, ToolHandler } from './types';
import { LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers } from './local-sf3d-tools';
import { TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers } from './tile-refine-tools';
import { PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers } from './pbr-material-tools';
import { TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers } from './turnaround-tools';
import { IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers } from './image-to-pbr-tools';
import { PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers } from './python-3d-tools';
import { OBJECT_REFERENCE_TOOL_DECLARATIONS, objectReferenceHandlers } from './object-reference-tools';
import { MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers } from './mesh-shaping-tools';
import { SB_RIG_TOOL_DECLARATIONS, sbRigHandlers } from './sb-rig-tools';
import { NANO_BANANA_TOOL_DECLARATIONS, nanoBananaHandlers } from './nano-banana-tools';
import { ALGORITHMIC_UV_TOOL_DECLARATIONS, algorithmicUvHandlers } from './algorithmic-uv-tools';
import { WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers } from './workspace-tools';
import { LENS_TOOL_DECLARATIONS, lensHandlers, BROWSER_TOOL_DECLARATIONS, browserHandlers } from './lens-browser-tools';
import { CANVAS_TOOL_DECLARATIONS, canvasHandlers } from './canvas-tools';
import {
    GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    google3DTilesHandlers,
    PANORAMA_TOOL_DECLARATIONS,
    panoramaHandlers,
    UTDRA_TOOL_DECLARATIONS,
    utdraHandlers,
    WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    webxrGeospatialHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS,
    geoboxPrecisionHandlers,
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    opticsLensDistortionHandlers,
    POSE_DEPTH_TOOL_DECLARATIONS,
    poseDepthHandlers,
    PHYSICAL_CAMERA_TOOL_DECLARATIONS,
    physicalCameraHandlers,
    TAPIR_4DGS_TOOL_DECLARATIONS,
    tapir4dgsHandlers,
    AVATAR_4DGS_TOOL_DECLARATIONS,
    avatar4dgsHandlers,
    HUMANOID_AVATAR_TOOL_DECLARATIONS,
    humanoidAvatarHandlers,
    ANALYTICAL_GROOM_TOOL_DECLARATIONS,
    analyticalGroomHandlers
} from './spatial-tools';
import { ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers } from './atmosphere-tools';
import {
    VFX_VIDEO_TOOL_DECLARATIONS,
    vfxVideoHandlers,
    AI_BEAUTIFY_TOOL_DECLARATIONS,
    aiBeautifyHandlers
} from './vfx-video-tools';
import {
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    adaptiveMatchmoveHandlers
} from './adaptive-matchmove-tools';
import {
    BOTANICAL_TREE_TOOL_DECLARATIONS,
    botanicalTreeHandlers
} from './botanical-tree-tools';
import {
    LIGHTING_TOOL_DECLARATIONS,
    lightingHandlers
} from './lighting-tools';
import {
    UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
    universal3DStructureHandlers
} from './universal-3d-structure-tools';

export const DEFAULT_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ...CANVAS_TOOL_DECLARATIONS,
    ...WORKSPACE_TOOL_DECLARATIONS,
    ...PYTHON_3D_TOOL_DECLARATIONS,
    ...OBJECT_REFERENCE_TOOL_DECLARATIONS,
    ...GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    ...TILE_REFINE_TOOL_DECLARATIONS,
    ...BOTANICAL_TREE_TOOL_DECLARATIONS,
    ...PANORAMA_TOOL_DECLARATIONS,
    ...UTDRA_TOOL_DECLARATIONS,
    ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
    ...ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    ...VFX_VIDEO_TOOL_DECLARATIONS,
    ...NANO_BANANA_TOOL_DECLARATIONS,
    ...ALGORITHMIC_UV_TOOL_DECLARATIONS,
    ...ATMOSPHERE_TOOL_DECLARATIONS,
    ...LIGHTING_TOOL_DECLARATIONS,
    ...MESH_SHAPING_TOOL_DECLARATIONS,
    ...SB_RIG_TOOL_DECLARATIONS,
    ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    ...GEOBOX_PRECISION_TOOL_DECLARATIONS,
    ...OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    ...POSE_DEPTH_TOOL_DECLARATIONS,
    ...PHYSICAL_CAMERA_TOOL_DECLARATIONS,
    ...TAPIR_4DGS_TOOL_DECLARATIONS,
    ...AVATAR_4DGS_TOOL_DECLARATIONS,
    ...HUMANOID_AVATAR_TOOL_DECLARATIONS,
    ...ANALYTICAL_GROOM_TOOL_DECLARATIONS,
    ...IMAGE_TO_PBR_TOOL_DECLARATIONS,
    ...PBR_MATERIAL_TOOL_DECLARATIONS,
    ...LOCAL_SF3D_TOOL_DECLARATIONS,
    ...TURNAROUND_TOOL_DECLARATIONS,
    ...LENS_TOOL_DECLARATIONS,
    ...BROWSER_TOOL_DECLARATIONS
];

export const DEFAULT_TOOL_HANDLERS: Record<string, ToolHandler> = {
    ...canvasHandlers,
    ...workspaceHandlers,
    ...python3DHandlers,
    ...objectReferenceHandlers,
    ...google3DTilesHandlers,
    ...tileRefineHandlers,
    ...panoramaHandlers,
    ...utdraHandlers,
    ...universal3DStructureHandlers,
    ...adaptiveMatchmoveHandlers,
    ...vfxVideoHandlers,
    ...nanoBananaHandlers,
    ...turnaroundHandlers,
    ...algorithmicUvHandlers,
    ...atmosphereHandlers,
    ...lightingHandlers,
    ...meshShapingHandlers,
    ...sbRigHandlers,
    ...webxrGeospatialHandlers,
    ...geoboxPrecisionHandlers,
    ...opticsLensDistortionHandlers,
    ...poseDepthHandlers,
    ...physicalCameraHandlers,
    ...tapir4dgsHandlers,
    ...avatar4dgsHandlers,
    ...analyticalGroomHandlers,
    ...imageToPbrHandlers,
    ...pbrMaterialHandlers,
    ...localSf3DHandlers,
    ...lensHandlers,
    ...browserHandlers,
    ...botanicalTreeHandlers
};

export {
    HUMANOID_AVATAR_TOOL_DECLARATIONS,
    humanoidAvatarHandlers
};
