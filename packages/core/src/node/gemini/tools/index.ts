/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export * from './types';
export * from './workspace-tools';
export * from './lens-browser-tools';
export * from './canvas-tools';
export * from './comfyui-tools';
export * from './spatial-tools';
export * from './atmosphere-tools';
export * from './vfx-video-tools';
export * from './mesh-shaping-tools';
export * from './nano-banana-tools';
export * from './algorithmic-uv-tools';
export * from './botanical-tree-tools';

import type { ToolDeclaration, ToolHandler } from './types';
import { MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers } from './mesh-shaping-tools';
import { NANO_BANANA_TOOL_DECLARATIONS, nanoBananaHandlers } from './nano-banana-tools';
import { ALGORITHMIC_UV_TOOL_DECLARATIONS, algorithmicUvHandlers } from './algorithmic-uv-tools';
import { WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers } from './workspace-tools';
import { LENS_TOOL_DECLARATIONS, lensHandlers, BROWSER_TOOL_DECLARATIONS, browserHandlers } from './lens-browser-tools';
import { CANVAS_TOOL_DECLARATIONS, canvasHandlers } from './canvas-tools';
import { COMFYUI_TOOL_DECLARATIONS, comfyuiHandlers } from './comfyui-tools';
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
    avatar4dgsHandlers
} from './spatial-tools';
import { ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers } from './atmosphere-tools';
import {
    VFX_VIDEO_TOOL_DECLARATIONS,
    vfxVideoHandlers,
    AI_BEAUTIFY_TOOL_DECLARATIONS,
    aiBeautifyHandlers
} from './vfx-video-tools';
import {
    BOTANICAL_TREE_TOOL_DECLARATIONS,
    botanicalTreeHandlers
} from './botanical-tree-tools';

export const DEFAULT_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ...CANVAS_TOOL_DECLARATIONS,
    ...WORKSPACE_TOOL_DECLARATIONS,
    ...GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    ...BOTANICAL_TREE_TOOL_DECLARATIONS,
    ...PANORAMA_TOOL_DECLARATIONS,
    ...UTDRA_TOOL_DECLARATIONS,
    ...VFX_VIDEO_TOOL_DECLARATIONS,
    ...NANO_BANANA_TOOL_DECLARATIONS,
    ...ALGORITHMIC_UV_TOOL_DECLARATIONS,
    ...ATMOSPHERE_TOOL_DECLARATIONS,
    ...MESH_SHAPING_TOOL_DECLARATIONS,
    ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    ...GEOBOX_PRECISION_TOOL_DECLARATIONS,
    ...OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    ...POSE_DEPTH_TOOL_DECLARATIONS,
    ...PHYSICAL_CAMERA_TOOL_DECLARATIONS,
    ...TAPIR_4DGS_TOOL_DECLARATIONS,
    ...AVATAR_4DGS_TOOL_DECLARATIONS,
    ...COMFYUI_TOOL_DECLARATIONS,
    ...LENS_TOOL_DECLARATIONS,
    ...BROWSER_TOOL_DECLARATIONS
];

export const DEFAULT_TOOL_HANDLERS: Record<string, ToolHandler> = {
    ...canvasHandlers,
    ...workspaceHandlers,
    ...google3DTilesHandlers,
    ...panoramaHandlers,
    ...utdraHandlers,
    ...vfxVideoHandlers,
    ...nanoBananaHandlers,
    ...algorithmicUvHandlers,
    ...atmosphereHandlers,
    ...meshShapingHandlers,
    ...webxrGeospatialHandlers,
    ...geoboxPrecisionHandlers,
    ...opticsLensDistortionHandlers,
    ...poseDepthHandlers,
    ...physicalCameraHandlers,
    ...tapir4dgsHandlers,
    ...avatar4dgsHandlers,
    ...comfyuiHandlers,
    ...lensHandlers,
    ...browserHandlers,
    ...botanicalTreeHandlers
};


