/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration } from './tools/types';
import type { TaskDomain } from '../agent/task-capability-resolver';
import { CANVAS_TOOL_DECLARATIONS } from './tools/canvas-tools';
import { WORKSPACE_TOOL_DECLARATIONS } from './tools/workspace-tools';
import { PYTHON_3D_TOOL_DECLARATIONS } from './tools/python-3d-tools';
import { MASSING_TOOL_DECLARATIONS } from './tools/massing-tools';
import { OBJECT_REFERENCE_TOOL_DECLARATIONS } from './tools/object-reference-tools';
import { SB_SCRIPT_GUIDE_TOOL_DECLARATIONS } from './tools/sb-script-guide-tools';
import {
    GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    PANORAMA_TOOL_DECLARATIONS,
    UTDRA_TOOL_DECLARATIONS,
    WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    GEOBOX_PRECISION_TOOL_DECLARATIONS,
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    POSE_DEPTH_TOOL_DECLARATIONS,
    PHYSICAL_CAMERA_TOOL_DECLARATIONS,
    TAPIR_4DGS_TOOL_DECLARATIONS,
    AVATAR_4DGS_TOOL_DECLARATIONS,
    HUMANOID_AVATAR_TOOL_DECLARATIONS,
    ANALYTICAL_GROOM_TOOL_DECLARATIONS
} from './tools/spatial-tools';
import { UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS } from './tools/universal-3d-structure-tools';
import { TILE_REFINE_TOOL_DECLARATIONS } from './tools/tile-refine-tools';
import { SCENE_HEALING_TOOL_DECLARATIONS } from './tools/scene-healing-tools';
import { LOCATION_EVIDENCE_TOOL_DECLARATIONS } from './tools/location-evidence-tools';
import { LOCATION_REFERENCE_TOOL_DECLARATIONS } from './tools/location-reference-tools';
import { SURFACE_MATERIALS_TOOL_DECLARATIONS } from './tools/surface-material-tools';
import { MESH_SHAPING_TOOL_DECLARATIONS } from './tools/mesh-shaping-tools';
import { SB_RIG_TOOL_DECLARATIONS } from './tools/sb-rig-tools';
import { ALGORITHMIC_UV_TOOL_DECLARATIONS } from './tools/algorithmic-uv-tools';
import { BOTANICAL_TREE_TOOL_DECLARATIONS } from './tools/botanical-tree-tools';
import { IMAGE_GENERATION_TOOL_DECLARATIONS, NANO_BANANA_TOOL_DECLARATIONS } from './tools/nano-banana-tools';
import { TURNAROUND_TOOL_DECLARATIONS } from './tools/turnaround-tools';
import { VFX_VIDEO_TOOL_DECLARATIONS, AI_BEAUTIFY_TOOL_DECLARATIONS } from './tools/vfx-video-tools';
import { ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS } from './tools/adaptive-matchmove-tools';
import { ATMOSPHERE_TOOL_DECLARATIONS } from './tools/atmosphere-tools';
import { LIGHTING_TOOL_DECLARATIONS } from './tools/lighting-tools';
import { LENS_TOOL_DECLARATIONS, BROWSER_TOOL_DECLARATIONS } from './tools/lens-browser-tools';
import { BVH_QUERY_TOOL_DECLARATIONS } from './tools/bvh-query-tools';
import { SPECULAR_MATERIALS_TOOL_DECLARATIONS } from './tools/specular-material-tools';
import { CHRONO_SHADOW_TOOL_DECLARATIONS } from './tools/chrono-shadow-tools';
import { VANISHING_POINT_TOOL_DECLARATIONS } from './tools/vanishing-point-tools';
import { TILE_ELEVATION_TOOL_DECLARATIONS } from './tools/tile-elevation-tools';
import { CSG_APERTURE_TOOL_DECLARATIONS } from './tools/csg-aperture-tools';
import { GLASS_FRACTURE_TOOL_DECLARATIONS } from './tools/glass-fracture-tools';
import { TRAJECTORY_COLLISION_TOOL_DECLARATIONS } from './tools/trajectory-collision-tools';
import { BAY_RHYTHM_TOOL_DECLARATIONS } from './tools/bay-rhythm-tools';
import { WALL_PLANE_SEGMENT_TOOL_DECLARATIONS } from './tools/wall-plane-segment-tools';
import { RIGIDBODY_DROP_TOOL_DECLARATIONS } from './tools/rigidbody-drop-tools';
import { XPBD_CLOTH_TOOL_DECLARATIONS } from './tools/xpbd-cloth-tools';
import { SH9_LIGHTING_TOOL_DECLARATIONS } from './tools/sh9-lighting-tools';

export type ToolPackName =
    | 'core_workspace'
    | 'geospatial_3d'
    | 'mesh_surface'
    | 'vfx_video'
    | 'lens'
    | 'browser';

export interface ToolPackDefinition {
    id: ToolPackName;
    displayName: string;
    description: string;
    toolNames: string[];
    declarations: ToolDeclaration[];
}

export const CORE_WORKSPACE_PACK: ToolPackDefinition = {
    id: 'core_workspace',
    displayName: 'Core Workspace & Canvas Studio',
    description: 'File reading/writing, diagnostics, diffs, canvas primitive mounting, native 3D scripts, reference-built objects and SB-Veggie vegetation, image generation, user dialogue, and subagent delegation.',
    declarations: [
        ...CANVAS_TOOL_DECLARATIONS,
        ...WORKSPACE_TOOL_DECLARATIONS,
        ...PYTHON_3D_TOOL_DECLARATIONS,
        ...SB_SCRIPT_GUIDE_TOOL_DECLARATIONS,
        ...OBJECT_REFERENCE_TOOL_DECLARATIONS,
        // the vegetation generator of every 3D path (SB-Veggie): offered wherever 3D scenes are
        ...BOTANICAL_TREE_TOOL_DECLARATIONS,
        ...IMAGE_GENERATION_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...CANVAS_TOOL_DECLARATIONS.map(d => d.name),
        ...WORKSPACE_TOOL_DECLARATIONS.map(d => d.name),
        ...PYTHON_3D_TOOL_DECLARATIONS.map(d => d.name),
        ...SB_SCRIPT_GUIDE_TOOL_DECLARATIONS.map(d => d.name),
        ...OBJECT_REFERENCE_TOOL_DECLARATIONS.map(d => d.name),
        ...BOTANICAL_TREE_TOOL_DECLARATIONS.map(d => d.name),
        ...IMAGE_GENERATION_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const GEOSPATIAL_3D_PACK: ToolPackDefinition = {
    id: 'geospatial_3d',
    displayName: 'Geospatial 3D Tiles & Metrology Foundation',
    description: 'Google Maps 3D Tiles ingestion, UTDRA macro-decomposition, Universal 3D Structure Foundation, WebXR anchoring, Geobox precision bounding, reverse shadow-geolocation, single-photo camera calibration, tile sea-level elevation queries, camera-trajectory collision auditing, blind wall-plane segmentation, and facade bay-rhythm/elevation analysis.',
    declarations: [
        ...GOOGLE_3D_TILES_TOOL_DECLARATIONS,
        ...PANORAMA_TOOL_DECLARATIONS,
        ...UTDRA_TOOL_DECLARATIONS,
        ...TILE_REFINE_TOOL_DECLARATIONS,
        ...SCENE_HEALING_TOOL_DECLARATIONS,
        ...LOCATION_EVIDENCE_TOOL_DECLARATIONS,
        ...LOCATION_REFERENCE_TOOL_DECLARATIONS,
        ...SURFACE_MATERIALS_TOOL_DECLARATIONS,
        ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
        ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
        ...GEOBOX_PRECISION_TOOL_DECLARATIONS,
        ...CHRONO_SHADOW_TOOL_DECLARATIONS,
        ...VANISHING_POINT_TOOL_DECLARATIONS,
        ...TILE_ELEVATION_TOOL_DECLARATIONS,
        ...TRAJECTORY_COLLISION_TOOL_DECLARATIONS,
        ...WALL_PLANE_SEGMENT_TOOL_DECLARATIONS,
        ...BAY_RHYTHM_TOOL_DECLARATIONS,
        ...MASSING_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...GOOGLE_3D_TILES_TOOL_DECLARATIONS.map(d => d.name),
        ...PANORAMA_TOOL_DECLARATIONS.map(d => d.name),
        ...UTDRA_TOOL_DECLARATIONS.map(d => d.name),
        ...TILE_REFINE_TOOL_DECLARATIONS.map(d => d.name),
        ...SCENE_HEALING_TOOL_DECLARATIONS.map(d => d.name),
        ...LOCATION_EVIDENCE_TOOL_DECLARATIONS.map(d => d.name),
        ...LOCATION_REFERENCE_TOOL_DECLARATIONS.map(d => d.name),
        ...SURFACE_MATERIALS_TOOL_DECLARATIONS.map(d => d.name),
        ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS.map(d => d.name),
        ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS.map(d => d.name),
        ...GEOBOX_PRECISION_TOOL_DECLARATIONS.map(d => d.name),
        ...CHRONO_SHADOW_TOOL_DECLARATIONS.map(d => d.name),
        ...VANISHING_POINT_TOOL_DECLARATIONS.map(d => d.name),
        ...TILE_ELEVATION_TOOL_DECLARATIONS.map(d => d.name),
        ...TRAJECTORY_COLLISION_TOOL_DECLARATIONS.map(d => d.name),
        ...WALL_PLANE_SEGMENT_TOOL_DECLARATIONS.map(d => d.name),
        ...BAY_RHYTHM_TOOL_DECLARATIONS.map(d => d.name),
        ...MASSING_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const MESH_SURFACE_PACK: ToolPackDefinition = {
    id: 'mesh_surface',
    displayName: 'Mesh Reshaping & Material Textures',
    description: 'C++20 mesh shaping, SB-Rig auto-rigging (skeleton + skin weights for any mesh), algorithmic UV unwrap, MaxRects atlas binning, analytical hair/groom forward splatting, BVH spatial queries (raycast, closest-point, RTAO baking), reflective/dielectric material detection on any mesh (self-rendered or posed evidence, baked into a new metallicRoughness texture), analytical facade aperture (window/door) generation, ballistic glass fracture, rigid-body drop/settle simulation, and XPBD cloth draping — on individual meshes and buildings.',
    declarations: [
        ...MESH_SHAPING_TOOL_DECLARATIONS,
        ...SB_RIG_TOOL_DECLARATIONS,
        ...ALGORITHMIC_UV_TOOL_DECLARATIONS,
        ...NANO_BANANA_TOOL_DECLARATIONS,
        ...TURNAROUND_TOOL_DECLARATIONS,
        ...ANALYTICAL_GROOM_TOOL_DECLARATIONS,
        ...BVH_QUERY_TOOL_DECLARATIONS,
        ...SPECULAR_MATERIALS_TOOL_DECLARATIONS,
        ...CSG_APERTURE_TOOL_DECLARATIONS,
        ...GLASS_FRACTURE_TOOL_DECLARATIONS,
        ...RIGIDBODY_DROP_TOOL_DECLARATIONS,
        ...XPBD_CLOTH_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...MESH_SHAPING_TOOL_DECLARATIONS.map(d => d.name),
        ...SB_RIG_TOOL_DECLARATIONS.map(d => d.name),
        ...ALGORITHMIC_UV_TOOL_DECLARATIONS.map(d => d.name),
        ...NANO_BANANA_TOOL_DECLARATIONS.map(d => d.name),
        ...TURNAROUND_TOOL_DECLARATIONS.map(d => d.name),
        ...ANALYTICAL_GROOM_TOOL_DECLARATIONS.map(d => d.name),
        ...BVH_QUERY_TOOL_DECLARATIONS.map(d => d.name),
        ...SPECULAR_MATERIALS_TOOL_DECLARATIONS.map(d => d.name),
        ...CSG_APERTURE_TOOL_DECLARATIONS.map(d => d.name),
        ...GLASS_FRACTURE_TOOL_DECLARATIONS.map(d => d.name),
        ...RIGIDBODY_DROP_TOOL_DECLARATIONS.map(d => d.name),
        ...XPBD_CLOTH_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const VFX_VIDEO_PACK: ToolPackDefinition = {
    id: 'vfx_video',
    displayName: 'VFX Video Timeline, Matchmove & Lighting',
    description: 'Video timeline NLE, AI beautify prompt synthesis, matchmove camera resection, Brown-Conrady optics, atmospheric scattering, lighting (including SH9 ambient-light estimation from a real panorama), and 4DGS dynamic avatars.',
    declarations: [
        ...VFX_VIDEO_TOOL_DECLARATIONS,
        ...AI_BEAUTIFY_TOOL_DECLARATIONS,
        ...ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
        ...ATMOSPHERE_TOOL_DECLARATIONS,
        ...LIGHTING_TOOL_DECLARATIONS,
        ...SH9_LIGHTING_TOOL_DECLARATIONS,
        ...OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
        ...PHYSICAL_CAMERA_TOOL_DECLARATIONS,
        ...POSE_DEPTH_TOOL_DECLARATIONS,
        ...TAPIR_4DGS_TOOL_DECLARATIONS,
        ...AVATAR_4DGS_TOOL_DECLARATIONS,
        ...HUMANOID_AVATAR_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...VFX_VIDEO_TOOL_DECLARATIONS.map(d => d.name),
        ...AI_BEAUTIFY_TOOL_DECLARATIONS.map(d => d.name),
        ...ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS.map(d => d.name),
        ...ATMOSPHERE_TOOL_DECLARATIONS.map(d => d.name),
        ...LIGHTING_TOOL_DECLARATIONS.map(d => d.name),
        ...SH9_LIGHTING_TOOL_DECLARATIONS.map(d => d.name),
        ...OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS.map(d => d.name),
        ...PHYSICAL_CAMERA_TOOL_DECLARATIONS.map(d => d.name),
        ...POSE_DEPTH_TOOL_DECLARATIONS.map(d => d.name),
        ...TAPIR_4DGS_TOOL_DECLARATIONS.map(d => d.name),
        ...AVATAR_4DGS_TOOL_DECLARATIONS.map(d => d.name),
        ...HUMANOID_AVATAR_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const LENS_PACK: ToolPackDefinition = {
    id: 'lens',
    displayName: 'Codebase Lens AST & Projections',
    description: 'Bi-directional Codebase Lens projection, sync, symbol graph lookup, and LSP diagnostics.',
    declarations: LENS_TOOL_DECLARATIONS,
    toolNames: LENS_TOOL_DECLARATIONS.map(d => d.name)
};

export const BROWSER_PACK: ToolPackDefinition = {
    id: 'browser',
    displayName: 'Browser Automation & Web Bridge',
    description: 'Browser navigation, page snapshots, DOM evaluation, and clientside canvas auditing.',
    declarations: BROWSER_TOOL_DECLARATIONS,
    toolNames: BROWSER_TOOL_DECLARATIONS.map(d => d.name)
};

export const ALL_TOOL_PACKS: Record<ToolPackName, ToolPackDefinition> = {
    core_workspace: CORE_WORKSPACE_PACK,
    geospatial_3d: GEOSPATIAL_3D_PACK,
    mesh_surface: MESH_SURFACE_PACK,
    vfx_video: VFX_VIDEO_PACK,
    lens: LENS_PACK,
    browser: BROWSER_PACK
};

export interface ResolveToolPacksOptions {
    prompt?: string;
    mode?: string;
    domainHint?: TaskDomain | 'auto';
    enableWorkspaceTools?: boolean;
    enableBrowserTools?: boolean;
    enableLensTools?: boolean;
    requestedPacks?: ToolPackName[];
    agent?: string;
    activeArtifact?: any;
}

/**
 * The packs a request's switches select: the packs it names (toolPacks), else core workspace with the domain packs
 * when workspace tools are allowed, plus lens and browser when they are switched on. Nothing here reads the prompt:
 * tools are never chosen or withheld by words in the request (AGENTS.md ADA 1.2); the chat offers its entry set and
 * the model loads the rest (tool-catalog.ts).
 */
export function resolveDomainToolPacks(options: ResolveToolPacksOptions): { packs: ToolPackName[] } {
    const requested = options.requestedPacks;
    if (requested && requested.length > 0) {
        return { packs: Array.from(new Set(requested)) };
    }
    const packs: ToolPackName[] = [];
    if (options.enableWorkspaceTools !== false) {
        packs.push('core_workspace', 'geospatial_3d', 'mesh_surface', 'vfx_video');
    }
    if (options.enableLensTools === true) packs.push('lens');
    if (options.enableBrowserTools === true || options.agent) packs.push('browser');
    return { packs };
}

function unwrapNestedArguments(rawArgs: Record<string, unknown>, schemaProps: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!schemaProps) {
        return { ...rawArgs };
    }
    for (const wrapper of ['parameters', 'arguments', 'args']) {
        let nested = rawArgs[wrapper];
        if (wrapper in schemaProps || nested === undefined) continue;
        if (typeof nested === 'string') {
            try { nested = JSON.parse(nested); } catch { continue; }
        }
        if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.keys(nested).some(k => k in schemaProps)) {
            const { [wrapper]: _wrapper, ...rest } = rawArgs;
            return { ...rest, ...(nested as Record<string, unknown>) };
        }
    }
    return { ...rawArgs };
}

export function coerceToolArguments(
    declaration: ToolDeclaration | undefined,
    rawArgs: Record<string, unknown> | undefined
): Record<string, unknown> {
    if (!rawArgs || typeof rawArgs !== 'object') {
        return {};
    }

    const schemaProps = (declaration?.parameters as any)?.properties;
    const coerced: Record<string, unknown> = unwrapNestedArguments(rawArgs, schemaProps);

    for (const [key, val] of Object.entries(coerced)) {
        if (val === null || val === undefined) {
            continue;
        }

        const propSchema = schemaProps?.[key];
        const expectedType = propSchema ? String(propSchema.type || '').toUpperCase() : undefined;

        // 1. If property is expected to be OBJECT or ARRAY, but model passed JSON string
        if (typeof val === 'string' && (expectedType === 'OBJECT' || expectedType === 'ARRAY' || !expectedType)) {
            const trimmed = val.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    coerced[key] = JSON.parse(trimmed);
                    continue;
                } catch {
                    // Retain original string if invalid JSON
                }
            }
        }

        // 2. If property is expected to be NUMBER / INTEGER, but model passed numeric string
        if (typeof val === 'string' && (expectedType === 'NUMBER' || expectedType === 'INTEGER')) {
            const num = Number(val);
            if (!Number.isNaN(num)) {
                coerced[key] = num;
                continue;
            }
        }

        // 3. If property is expected to be BOOLEAN, but model passed string
        if (typeof val === 'string' && expectedType === 'BOOLEAN') {
            const lower = val.toLowerCase().trim();
            if (lower === 'true') {
                coerced[key] = true;
                continue;
            } else if (lower === 'false') {
                coerced[key] = false;
                continue;
            }
        }

        // 4. If property is expected to be ARRAY, but model passed comma-separated string
        if (typeof val === 'string' && expectedType === 'ARRAY' && val.includes(',')) {
            coerced[key] = val.split(',').map(s => s.trim()).filter(Boolean);
            continue;
        }
    }

    return coerced;
}
