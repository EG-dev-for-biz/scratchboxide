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
export * from './sb-roadie-tools';
export * from './lighting-tools';
export * from './universal-3d-structure-tools';
export * from './python-3d-tools';
export * from './massing-tools';
export * from './image-to-pbr-tools';
export * from './turnaround-tools';
export * from './pbr-material-tools';
export * from './weathering-tools';
export * from './object-detail-tools';
export * from './blueprint-outline-tools';
export * from './local-sf3d-tools';
export * from './tile-refine-tools';
export * from './scene-healing-tools';
export * from './object-reference-tools';
export * from './sb-script-guide-tools';
export * from './texture-library-tools';
export * from './virtual-geometry-tools';
export * from './location-evidence-tools';
export * from './location-reference-tools';
export * from './surface-material-tools';
export * from './bvh-query-tools';
export * from './specular-material-tools';
export * from './chrono-shadow-tools';
export * from './vanishing-point-tools';
export * from './tile-elevation-tools';
export * from './csg-aperture-tools';
export * from './glass-fracture-tools';
export * from './trajectory-collision-tools';
export * from './bay-rhythm-tools';
export * from './rigidbody-drop-tools';
export * from './xpbd-cloth-tools';
export * from './sh9-lighting-tools';
export * from './hydraulic-erosion-tools';
export * from './wall-plane-segment-tools';


import type { ToolDeclaration, ToolHandler } from './types';

/** A pack that exports its handlers as [declaration, handler] pairs, as the handler map registerTools and the MCP take. */
export function handlersByName(pairs: ReadonlyArray<readonly [ToolDeclaration, ToolHandler]>): Record<string, ToolHandler> {
    return Object.fromEntries(pairs.map(([decl, handler]) => [decl.name, handler]));
}
import { LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers } from './local-sf3d-tools';
import { TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers } from './tile-refine-tools';
import { SCENE_HEALING_TOOL_DECLARATIONS, sceneHealingHandlers } from './scene-healing-tools';
import { VIRTUAL_GEOMETRY_TOOL_DECLARATIONS, virtualGeometryHandlers } from './virtual-geometry-tools';
import { LOCATION_EVIDENCE_TOOL_DECLARATIONS, locationEvidenceHandlers } from './location-evidence-tools';
import { LOCATION_REFERENCE_TOOL_DECLARATIONS, locationReferenceHandlers } from './location-reference-tools';
import { SURFACE_MATERIALS_TOOL_DECLARATIONS, surfaceMaterialsHandlers } from './surface-material-tools';
import { PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers } from './pbr-material-tools';
import { WEATHERING_TOOL_DECLARATIONS, WEATHERING_TOOL_HANDLERS } from './weathering-tools';
import { OBJECT_DETAIL_TOOL_DECLARATIONS, objectDetailHandlers } from './object-detail-tools';
import { BLUEPRINT_OUTLINE_TOOL_DECLARATIONS, blueprintOutlineHandlers } from './blueprint-outline-tools';
import { TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers } from './turnaround-tools';
import { IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers } from './image-to-pbr-tools';
import { PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers } from './python-3d-tools';
import { MASSING_TOOL_DECLARATIONS, massingHandlers } from './massing-tools';
import { OBJECT_REFERENCE_TOOL_DECLARATIONS, objectReferenceHandlers } from './object-reference-tools';
import { SB_SCRIPT_GUIDE_TOOL_DECLARATIONS, sbScriptGuideHandlers } from './sb-script-guide-tools';
import { TEXTURE_LIBRARY_TOOL_DECLARATIONS, textureLibraryHandlers } from './texture-library-tools';
import { MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers } from './mesh-shaping-tools';
import { SB_RIG_TOOL_DECLARATIONS, sbRigHandlers } from './sb-rig-tools';
import { NANO_BANANA_TOOL_DECLARATIONS, nanoBananaHandlers, IMAGE_GENERATION_TOOL_DECLARATIONS, imageGenerationHandlers } from './nano-banana-tools';
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
import { SB_ROADIE_TOOL_DECLARATIONS, sbRoadieHandlers } from './sb-roadie-tools';
import {
    LIGHTING_TOOL_DECLARATIONS,
    lightingHandlers
} from './lighting-tools';
import {
    UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
    universal3DStructureHandlers
} from './universal-3d-structure-tools';
import {
    BVH_QUERY_TOOL_DECLARATIONS,
    bvhQueryHandlers
} from './bvh-query-tools';
import {
    SPECULAR_MATERIALS_TOOL_DECLARATIONS,
    specularMaterialHandlers
} from './specular-material-tools';
import {
    CHRONO_SHADOW_TOOL_DECLARATIONS,
    chronoShadowHandlers
} from './chrono-shadow-tools';
import {
    VANISHING_POINT_TOOL_DECLARATIONS,
    vanishingPointHandlers
} from './vanishing-point-tools';
import {
    TILE_ELEVATION_TOOL_DECLARATIONS,
    tileElevationHandlers
} from './tile-elevation-tools';
import {
    CSG_APERTURE_TOOL_DECLARATIONS,
    csgApertureHandlers
} from './csg-aperture-tools';
import {
    GLASS_FRACTURE_TOOL_DECLARATIONS,
    glassFractureHandlers
} from './glass-fracture-tools';
import {
    TRAJECTORY_COLLISION_TOOL_DECLARATIONS,
    trajectoryCollisionHandlers
} from './trajectory-collision-tools';
import {
    BAY_RHYTHM_TOOL_DECLARATIONS,
    bayRhythmHandlers
} from './bay-rhythm-tools';
import {
    RIGIDBODY_DROP_TOOL_DECLARATIONS,
    rigidbodyDropHandlers
} from './rigidbody-drop-tools';
import {
    XPBD_CLOTH_TOOL_DECLARATIONS,
    xpbdClothHandlers
} from './xpbd-cloth-tools';
import {
    SH9_LIGHTING_TOOL_DECLARATIONS,
    sh9LightingHandlers
} from './sh9-lighting-tools';
import {
    HYDRAULIC_EROSION_TOOL_DECLARATIONS,
    HYDRAULIC_EROSION_TOOL_HANDLERS
} from './hydraulic-erosion-tools';
import {
    WALL_PLANE_SEGMENT_TOOL_DECLARATIONS,
    wallPlaneSegmentHandlers
} from './wall-plane-segment-tools';

export const DEFAULT_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ...CANVAS_TOOL_DECLARATIONS,
    ...WORKSPACE_TOOL_DECLARATIONS,
    ...PYTHON_3D_TOOL_DECLARATIONS,
    ...MASSING_TOOL_DECLARATIONS,
    ...OBJECT_REFERENCE_TOOL_DECLARATIONS,
    ...SB_SCRIPT_GUIDE_TOOL_DECLARATIONS,
    ...TEXTURE_LIBRARY_TOOL_DECLARATIONS,
    ...GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    ...TILE_REFINE_TOOL_DECLARATIONS,
    ...SCENE_HEALING_TOOL_DECLARATIONS,
    ...VIRTUAL_GEOMETRY_TOOL_DECLARATIONS,
    ...LOCATION_EVIDENCE_TOOL_DECLARATIONS,
    ...LOCATION_REFERENCE_TOOL_DECLARATIONS,
    ...SURFACE_MATERIALS_TOOL_DECLARATIONS,
    ...BOTANICAL_TREE_TOOL_DECLARATIONS,
    ...PANORAMA_TOOL_DECLARATIONS,
    ...UTDRA_TOOL_DECLARATIONS,
    ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
    ...ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    ...VFX_VIDEO_TOOL_DECLARATIONS,
    ...NANO_BANANA_TOOL_DECLARATIONS,
    ...IMAGE_GENERATION_TOOL_DECLARATIONS,
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
    ...WEATHERING_TOOL_DECLARATIONS,
    ...OBJECT_DETAIL_TOOL_DECLARATIONS,
    ...BLUEPRINT_OUTLINE_TOOL_DECLARATIONS,
    ...LOCAL_SF3D_TOOL_DECLARATIONS,
    ...TURNAROUND_TOOL_DECLARATIONS,
    ...LENS_TOOL_DECLARATIONS,
    ...BROWSER_TOOL_DECLARATIONS,
    ...BVH_QUERY_TOOL_DECLARATIONS,
    ...SPECULAR_MATERIALS_TOOL_DECLARATIONS,
    ...CHRONO_SHADOW_TOOL_DECLARATIONS,
    ...VANISHING_POINT_TOOL_DECLARATIONS,
    ...TILE_ELEVATION_TOOL_DECLARATIONS,
    ...CSG_APERTURE_TOOL_DECLARATIONS,
    ...GLASS_FRACTURE_TOOL_DECLARATIONS,
    ...TRAJECTORY_COLLISION_TOOL_DECLARATIONS,
    ...BAY_RHYTHM_TOOL_DECLARATIONS,
    ...RIGIDBODY_DROP_TOOL_DECLARATIONS,
    ...XPBD_CLOTH_TOOL_DECLARATIONS,
    ...SH9_LIGHTING_TOOL_DECLARATIONS,
    ...HYDRAULIC_EROSION_TOOL_DECLARATIONS,
    ...WALL_PLANE_SEGMENT_TOOL_DECLARATIONS
];

export const DEFAULT_TOOL_HANDLERS: Record<string, ToolHandler> = {
    ...canvasHandlers,
    ...workspaceHandlers,
    ...python3DHandlers,
    ...massingHandlers,
    ...objectReferenceHandlers,
    ...sbScriptGuideHandlers,
    ...textureLibraryHandlers,
    ...google3DTilesHandlers,
    ...tileRefineHandlers,
    ...sceneHealingHandlers,
    ...virtualGeometryHandlers,
    ...locationEvidenceHandlers,
    ...locationReferenceHandlers,
    ...surfaceMaterialsHandlers,
    ...panoramaHandlers,
    ...utdraHandlers,
    ...universal3DStructureHandlers,
    ...adaptiveMatchmoveHandlers,
    ...vfxVideoHandlers,
    ...nanoBananaHandlers,
    ...imageGenerationHandlers,
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
    ...WEATHERING_TOOL_HANDLERS,
    ...objectDetailHandlers,
    ...blueprintOutlineHandlers,
    ...localSf3DHandlers,
    ...lensHandlers,
    ...browserHandlers,
    ...botanicalTreeHandlers,
    ...sbRoadieHandlers,
    ...Object.fromEntries([
        ...bvhQueryHandlers,
        ...specularMaterialHandlers,
        ...chronoShadowHandlers,
        ...vanishingPointHandlers,
        ...tileElevationHandlers,
        ...csgApertureHandlers,
        ...glassFractureHandlers,
        ...trajectoryCollisionHandlers,
        ...bayRhythmHandlers,
        ...rigidbodyDropHandlers,
        ...xpbdClothHandlers,
        ...sh9LightingHandlers,
        ...wallPlaneSegmentHandlers
    ].map(([decl, handler]) => [decl.name, handler])),
    ...HYDRAULIC_EROSION_TOOL_HANDLERS
};

export {
    HUMANOID_AVATAR_TOOL_DECLARATIONS,
    humanoidAvatarHandlers
};
