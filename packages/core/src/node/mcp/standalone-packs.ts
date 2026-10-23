/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tool packs the stdio MCP server serves: every pack the in-app chat registers (tool-registry.ts) whose handlers
 * run on the node side alone, with a workspace root, an abort signal and progress reports. The packs left out need the
 * IDE itself (IDE_ONLY_PACKS: the canvas, the lens and the browser proxy), and their handlers would only throw the
 * standalone context's "requires the IDE" error. Both MCP entry points (scratchbox-mcp.ts, the one .mcp.json runs, and
 * scratchbox-mcp-server.ts) take their tools from here, so there is one list to keep in step with the registry;
 * mcp-pack-drift.test.ts fails when tool-registry.ts registers a pack this file neither serves nor names as IDE-only.
 */

import {
    WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers,
    GOOGLE_3D_TILES_TOOL_DECLARATIONS, google3DTilesHandlers,
    PANORAMA_TOOL_DECLARATIONS, panoramaHandlers,
    UTDRA_TOOL_DECLARATIONS, utdraHandlers,
    VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers,
    AI_BEAUTIFY_TOOL_DECLARATIONS, aiBeautifyHandlers,
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS, adaptiveMatchmoveHandlers,
    NANO_BANANA_TOOL_DECLARATIONS, nanoBananaHandlers,
    IMAGE_GENERATION_TOOL_DECLARATIONS, imageGenerationHandlers,
    ALGORITHMIC_UV_TOOL_DECLARATIONS, algorithmicUvHandlers,
    ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers,
    MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers,
    SB_RIG_TOOL_DECLARATIONS, sbRigHandlers,
    WEBXR_GEOSPATIAL_TOOL_DECLARATIONS, webxrGeospatialHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS, geoboxPrecisionHandlers,
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS, opticsLensDistortionHandlers,
    BOTANICAL_TREE_TOOL_DECLARATIONS, botanicalTreeHandlers,
    SB_ROADIE_TOOL_DECLARATIONS, sbRoadieHandlers,
    LIGHTING_TOOL_DECLARATIONS, lightingHandlers,
    POSE_DEPTH_TOOL_DECLARATIONS, poseDepthHandlers,
    PHYSICAL_CAMERA_TOOL_DECLARATIONS, physicalCameraHandlers,
    TAPIR_4DGS_TOOL_DECLARATIONS, tapir4dgsHandlers,
    AVATAR_4DGS_TOOL_DECLARATIONS, avatar4dgsHandlers,
    HUMANOID_AVATAR_TOOL_DECLARATIONS, humanoidAvatarHandlers,
    ANALYTICAL_GROOM_TOOL_DECLARATIONS, analyticalGroomHandlers,
    UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS, universal3DStructureHandlers,
    PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers,
    TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers,
    VIRTUAL_GEOMETRY_TOOL_DECLARATIONS, virtualGeometryHandlers,
    LOCATION_EVIDENCE_TOOL_DECLARATIONS, locationEvidenceHandlers,
    LOCATION_REFERENCE_TOOL_DECLARATIONS, locationReferenceHandlers,
    SURFACE_MATERIALS_TOOL_DECLARATIONS, surfaceMaterialsHandlers,
    IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers,
    PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers,
    LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers,
    TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers,
    OBJECT_REFERENCE_TOOL_DECLARATIONS, objectReferenceHandlers,
    SB_SCRIPT_GUIDE_TOOL_DECLARATIONS, sbScriptGuideHandlers,
    type ToolDeclaration,
    type ToolHandler,
} from '../gemini/tools';

export interface ToolPack { name: string; declarations: ToolDeclaration[]; handlers: Record<string, ToolHandler> }

/** Packs whose handlers need the running IDE (canvas, lens, browser proxy): never served standalone. */
export const IDE_ONLY_PACKS: ReadonlyArray<string> = ['CANVAS_TOOL_DECLARATIONS', 'LENS_TOOL_DECLARATIONS', 'BROWSER_TOOL_DECLARATIONS'];

/** Every standalone pack, named by its declarations constant (the name tool-registry.ts imports). */
export const STANDALONE_PACKS: ReadonlyArray<ToolPack> = [
    { name: 'WORKSPACE_TOOL_DECLARATIONS', declarations: WORKSPACE_TOOL_DECLARATIONS, handlers: workspaceHandlers },
    { name: 'GOOGLE_3D_TILES_TOOL_DECLARATIONS', declarations: GOOGLE_3D_TILES_TOOL_DECLARATIONS, handlers: google3DTilesHandlers },
    // some panorama-pack tools (Street View grounding, vector staging) keep their handlers in analyticalGroomHandlers (tool-registry.ts does the same)
    { name: 'PANORAMA_TOOL_DECLARATIONS', declarations: PANORAMA_TOOL_DECLARATIONS, handlers: { ...analyticalGroomHandlers, ...panoramaHandlers } },
    { name: 'UTDRA_TOOL_DECLARATIONS', declarations: UTDRA_TOOL_DECLARATIONS, handlers: utdraHandlers },
    { name: 'VFX_VIDEO_TOOL_DECLARATIONS', declarations: VFX_VIDEO_TOOL_DECLARATIONS, handlers: vfxVideoHandlers },
    { name: 'AI_BEAUTIFY_TOOL_DECLARATIONS', declarations: AI_BEAUTIFY_TOOL_DECLARATIONS, handlers: aiBeautifyHandlers },
    { name: 'ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS', declarations: ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS, handlers: adaptiveMatchmoveHandlers },
    { name: 'NANO_BANANA_TOOL_DECLARATIONS', declarations: NANO_BANANA_TOOL_DECLARATIONS, handlers: nanoBananaHandlers },
    { name: 'IMAGE_GENERATION_TOOL_DECLARATIONS', declarations: IMAGE_GENERATION_TOOL_DECLARATIONS, handlers: imageGenerationHandlers },
    { name: 'ALGORITHMIC_UV_TOOL_DECLARATIONS', declarations: ALGORITHMIC_UV_TOOL_DECLARATIONS, handlers: algorithmicUvHandlers },
    { name: 'ATMOSPHERE_TOOL_DECLARATIONS', declarations: ATMOSPHERE_TOOL_DECLARATIONS, handlers: atmosphereHandlers },
    { name: 'MESH_SHAPING_TOOL_DECLARATIONS', declarations: MESH_SHAPING_TOOL_DECLARATIONS, handlers: meshShapingHandlers },
    { name: 'SB_RIG_TOOL_DECLARATIONS', declarations: SB_RIG_TOOL_DECLARATIONS, handlers: sbRigHandlers },
    { name: 'WEBXR_GEOSPATIAL_TOOL_DECLARATIONS', declarations: WEBXR_GEOSPATIAL_TOOL_DECLARATIONS, handlers: webxrGeospatialHandlers },
    { name: 'GEOBOX_PRECISION_TOOL_DECLARATIONS', declarations: GEOBOX_PRECISION_TOOL_DECLARATIONS, handlers: geoboxPrecisionHandlers },
    { name: 'OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS', declarations: OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS, handlers: opticsLensDistortionHandlers },
    { name: 'BOTANICAL_TREE_TOOL_DECLARATIONS', declarations: BOTANICAL_TREE_TOOL_DECLARATIONS, handlers: botanicalTreeHandlers },
    { name: 'SB_ROADIE_TOOL_DECLARATIONS', declarations: SB_ROADIE_TOOL_DECLARATIONS, handlers: sbRoadieHandlers },
    { name: 'LIGHTING_TOOL_DECLARATIONS', declarations: LIGHTING_TOOL_DECLARATIONS, handlers: lightingHandlers },
    { name: 'POSE_DEPTH_TOOL_DECLARATIONS', declarations: POSE_DEPTH_TOOL_DECLARATIONS, handlers: poseDepthHandlers },
    { name: 'PHYSICAL_CAMERA_TOOL_DECLARATIONS', declarations: PHYSICAL_CAMERA_TOOL_DECLARATIONS, handlers: physicalCameraHandlers },
    { name: 'TAPIR_4DGS_TOOL_DECLARATIONS', declarations: TAPIR_4DGS_TOOL_DECLARATIONS, handlers: tapir4dgsHandlers },
    { name: 'AVATAR_4DGS_TOOL_DECLARATIONS', declarations: AVATAR_4DGS_TOOL_DECLARATIONS, handlers: avatar4dgsHandlers },
    { name: 'HUMANOID_AVATAR_TOOL_DECLARATIONS', declarations: HUMANOID_AVATAR_TOOL_DECLARATIONS, handlers: humanoidAvatarHandlers },
    { name: 'ANALYTICAL_GROOM_TOOL_DECLARATIONS', declarations: ANALYTICAL_GROOM_TOOL_DECLARATIONS, handlers: analyticalGroomHandlers },
    { name: 'UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS', declarations: UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS, handlers: universal3DStructureHandlers },
    { name: 'PYTHON_3D_TOOL_DECLARATIONS', declarations: PYTHON_3D_TOOL_DECLARATIONS, handlers: python3DHandlers },
    { name: 'TILE_REFINE_TOOL_DECLARATIONS', declarations: TILE_REFINE_TOOL_DECLARATIONS, handlers: tileRefineHandlers },
    { name: 'VIRTUAL_GEOMETRY_TOOL_DECLARATIONS', declarations: VIRTUAL_GEOMETRY_TOOL_DECLARATIONS, handlers: virtualGeometryHandlers },
    { name: 'LOCATION_EVIDENCE_TOOL_DECLARATIONS', declarations: LOCATION_EVIDENCE_TOOL_DECLARATIONS, handlers: locationEvidenceHandlers },
    { name: 'LOCATION_REFERENCE_TOOL_DECLARATIONS', declarations: LOCATION_REFERENCE_TOOL_DECLARATIONS, handlers: locationReferenceHandlers },
    { name: 'SURFACE_MATERIALS_TOOL_DECLARATIONS', declarations: SURFACE_MATERIALS_TOOL_DECLARATIONS, handlers: surfaceMaterialsHandlers },
    { name: 'IMAGE_TO_PBR_TOOL_DECLARATIONS', declarations: IMAGE_TO_PBR_TOOL_DECLARATIONS, handlers: imageToPbrHandlers },
    { name: 'PBR_MATERIAL_TOOL_DECLARATIONS', declarations: PBR_MATERIAL_TOOL_DECLARATIONS, handlers: pbrMaterialHandlers },
    { name: 'LOCAL_SF3D_TOOL_DECLARATIONS', declarations: LOCAL_SF3D_TOOL_DECLARATIONS, handlers: localSf3DHandlers },
    { name: 'TURNAROUND_TOOL_DECLARATIONS', declarations: TURNAROUND_TOOL_DECLARATIONS, handlers: turnaroundHandlers },
    { name: 'OBJECT_REFERENCE_TOOL_DECLARATIONS', declarations: OBJECT_REFERENCE_TOOL_DECLARATIONS, handlers: objectReferenceHandlers },
    { name: 'SB_SCRIPT_GUIDE_TOOL_DECLARATIONS', declarations: SB_SCRIPT_GUIDE_TOOL_DECLARATIONS, handlers: sbScriptGuideHandlers },
];

/**
 * The packs merged into one declaration list and one handler map, first pack wins on a repeated tool name (the
 * registry's own rule). A declaration without a handler is left out, so the MCP never lists a tool it cannot call.
 */
export function mergeStandalonePacks(packs: ReadonlyArray<ToolPack> = STANDALONE_PACKS): { declarations: ToolDeclaration[]; handlers: Record<string, ToolHandler>; unhandled: string[] } {
    const declarations: ToolDeclaration[] = [];
    const handlers: Record<string, ToolHandler> = {};
    const unhandled: string[] = [];
    for (const pack of packs) {
        for (const decl of pack.declarations) {
            if (handlers[decl.name]) continue;
            const h = pack.handlers[decl.name];
            if (!h) { unhandled.push(`${pack.name}:${decl.name}`); continue; }
            handlers[decl.name] = h;
            declarations.push(decl);
        }
    }
    return { declarations, handlers, unhandled };
}
