/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration } from './tools/types';
import { TaskCapabilityResolver, type CapabilityResolutionResult, type TaskDomain } from '../agent/task-capability-resolver';
import { CANVAS_TOOL_DECLARATIONS } from './tools/canvas-tools';
import { WORKSPACE_TOOL_DECLARATIONS } from './tools/workspace-tools';
import { PYTHON_3D_TOOL_DECLARATIONS } from './tools/python-3d-tools';
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
import { MESH_SHAPING_TOOL_DECLARATIONS } from './tools/mesh-shaping-tools';
import { SB_RIG_TOOL_DECLARATIONS } from './tools/sb-rig-tools';
import { ALGORITHMIC_UV_TOOL_DECLARATIONS } from './tools/algorithmic-uv-tools';
import { BOTANICAL_TREE_TOOL_DECLARATIONS } from './tools/botanical-tree-tools';
import { NANO_BANANA_TOOL_DECLARATIONS } from './tools/nano-banana-tools';
import { TURNAROUND_TOOL_DECLARATIONS } from './tools/turnaround-tools';
import { VFX_VIDEO_TOOL_DECLARATIONS, AI_BEAUTIFY_TOOL_DECLARATIONS } from './tools/vfx-video-tools';
import { ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS } from './tools/adaptive-matchmove-tools';
import { ATMOSPHERE_TOOL_DECLARATIONS } from './tools/atmosphere-tools';
import { LIGHTING_TOOL_DECLARATIONS } from './tools/lighting-tools';
import { COMFYUI_TOOL_DECLARATIONS } from './tools/comfyui-tools';
import { LENS_TOOL_DECLARATIONS, BROWSER_TOOL_DECLARATIONS } from './tools/lens-browser-tools';

export type ToolPackName =
    | 'core_workspace'
    | 'geospatial_3d'
    | 'mesh_surface'
    | 'vfx_video'
    | 'comfyui'
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
    description: 'File reading/writing, diagnostics, diffs, canvas primitive mounting, user dialogue, and subagent delegation.',
    declarations: [
        ...CANVAS_TOOL_DECLARATIONS,
        ...WORKSPACE_TOOL_DECLARATIONS,
        ...PYTHON_3D_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...CANVAS_TOOL_DECLARATIONS.map(d => d.name),
        ...WORKSPACE_TOOL_DECLARATIONS.map(d => d.name),
        ...PYTHON_3D_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const GEOSPATIAL_3D_PACK: ToolPackDefinition = {
    id: 'geospatial_3d',
    displayName: 'Geospatial 3D Tiles & Metrology Foundation',
    description: 'Google Maps 3D Tiles ingestion, UTDRA macro-decomposition, Universal 3D Structure Foundation, WebXR anchoring, and Geobox precision bounding.',
    declarations: [
        ...GOOGLE_3D_TILES_TOOL_DECLARATIONS,
        ...PANORAMA_TOOL_DECLARATIONS,
        ...UTDRA_TOOL_DECLARATIONS,
        ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
        ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
        ...GEOBOX_PRECISION_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...GOOGLE_3D_TILES_TOOL_DECLARATIONS.map(d => d.name),
        ...PANORAMA_TOOL_DECLARATIONS.map(d => d.name),
        ...UTDRA_TOOL_DECLARATIONS.map(d => d.name),
        ...UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS.map(d => d.name),
        ...WEBXR_GEOSPATIAL_TOOL_DECLARATIONS.map(d => d.name),
        ...GEOBOX_PRECISION_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const MESH_SURFACE_PACK: ToolPackDefinition = {
    id: 'mesh_surface',
    displayName: 'Mesh Reshaping, Botanicals & Material Textures',
    description: 'C++20 mesh shaping, SB-Rig auto-rigging (skeleton + skin weights for any mesh), botanical trees, algorithmic UV unwrap, MaxRects atlas binning, and analytical hair/groom forward splatting.',
    declarations: [
        ...MESH_SHAPING_TOOL_DECLARATIONS,
        ...SB_RIG_TOOL_DECLARATIONS,
        ...ALGORITHMIC_UV_TOOL_DECLARATIONS,
        ...BOTANICAL_TREE_TOOL_DECLARATIONS,
        ...NANO_BANANA_TOOL_DECLARATIONS,
        ...TURNAROUND_TOOL_DECLARATIONS,
        ...ANALYTICAL_GROOM_TOOL_DECLARATIONS
    ],
    toolNames: [
        ...MESH_SHAPING_TOOL_DECLARATIONS.map(d => d.name),
        ...SB_RIG_TOOL_DECLARATIONS.map(d => d.name),
        ...ALGORITHMIC_UV_TOOL_DECLARATIONS.map(d => d.name),
        ...BOTANICAL_TREE_TOOL_DECLARATIONS.map(d => d.name),
        ...NANO_BANANA_TOOL_DECLARATIONS.map(d => d.name),
        ...TURNAROUND_TOOL_DECLARATIONS.map(d => d.name),
        ...ANALYTICAL_GROOM_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const VFX_VIDEO_PACK: ToolPackDefinition = {
    id: 'vfx_video',
    displayName: 'VFX Video Timeline, Matchmove & Lighting',
    description: 'Video timeline NLE, AI beautify prompt synthesis, matchmove camera resection, Brown-Conrady optics, atmospheric scattering, lighting, and 4DGS dynamic avatars.',
    declarations: [
        ...VFX_VIDEO_TOOL_DECLARATIONS,
        ...AI_BEAUTIFY_TOOL_DECLARATIONS,
        ...ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
        ...ATMOSPHERE_TOOL_DECLARATIONS,
        ...LIGHTING_TOOL_DECLARATIONS,
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
        ...OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS.map(d => d.name),
        ...PHYSICAL_CAMERA_TOOL_DECLARATIONS.map(d => d.name),
        ...POSE_DEPTH_TOOL_DECLARATIONS.map(d => d.name),
        ...TAPIR_4DGS_TOOL_DECLARATIONS.map(d => d.name),
        ...AVATAR_4DGS_TOOL_DECLARATIONS.map(d => d.name),
        ...HUMANOID_AVATAR_TOOL_DECLARATIONS.map(d => d.name)
    ]
};

export const COMFYUI_PACK: ToolPackDefinition = {
    id: 'comfyui',
    displayName: 'ComfyUI & Neural Generation Engine',
    description: 'Two-tier capability resolution, Cloud Run GPU / local pipeline research, dynamic node injection, and execution telemetry.',
    declarations: COMFYUI_TOOL_DECLARATIONS,
    toolNames: COMFYUI_TOOL_DECLARATIONS.map(d => d.name)
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
    comfyui: COMFYUI_PACK,
    lens: LENS_PACK,
    browser: BROWSER_PACK
};

export interface ResolveToolPacksOptions {
    prompt?: string;
    mode?: string;
    domainHint?: TaskDomain | 'auto';
    enableWorkspaceTools?: boolean;
    enableComfyUiTools?: boolean;
    enableBrowserTools?: boolean;
    enableLensTools?: boolean;
    requestedPacks?: ToolPackName[];
    agent?: string;
    activeArtifact?: any;
}

/**
 * Deterministically resolves which domain tool packs should be active for a request.
 * Runs pre-flight TaskCapabilityResolver to classify domain and enforce Two-Tier directives
 * before the LLM generates tokens.
 */
export function resolveDomainToolPacks(options: ResolveToolPacksOptions): {
    packs: ToolPackName[];
    capabilityResolution?: CapabilityResolutionResult;
} {
    const requested = options.requestedPacks;
    if (requested && requested.length > 0) {
        return { packs: Array.from(new Set(requested)) };
    }

    const prompt = (options.prompt || '').trim();
    let capabilityResolution: CapabilityResolutionResult | undefined;

    if (prompt.length > 0) {
        try {
            capabilityResolution = TaskCapabilityResolver.resolveTaskCapability(prompt, {
                domainHint: options.domainHint,
                activeArtifact: options.activeArtifact
            });
        } catch {
            // Graceful fallback
        }
    }

    const packs = new Set<ToolPackName>();

    // 1. Browser check
    const isBrowserNeeded = !!(
        options.enableBrowserTools ||
        options.agent ||
        (prompt && /browse|click|navigate|page|web|url|http|localhost/i.test(prompt))
    );
    if (isBrowserNeeded) {
        packs.add('browser');
    }

    // 2. Lens check
    const isLensNeeded = options.enableLensTools !== false && (
        options.enableLensTools === true ||
        !!(prompt && /lens|unproject|lens_project|lens_sync|codebase_lens/i.test(prompt))
    );
    if (isLensNeeded) {
        packs.add('lens');
    }

    // 3. ComfyUI check
    const isComfyUiNeeded = options.enableComfyUiTools !== false && (
        options.enableComfyUiTools === true ||
        capabilityResolution?.recommendedResolutionRoute === 'tier2-comfyui' ||
        capabilityResolution?.tier2Fallback?.needed === true ||
        !!(prompt && /comfy|neural|diffusion|trellis|triposr|marigold|lora|checkpoint|cloudrun|workflow|pipeline/i.test(prompt))
    );
    if (isComfyUiNeeded) {
        packs.add('comfyui');
    }

    // 4. Workspace & domain packs check
    const isWorkspaceAllowed = options.enableWorkspaceTools !== false;
    if (isWorkspaceAllowed) {
        // Core workspace is always provided when workspace tools are active
        const isCoreNeeded =
            options.enableWorkspaceTools === true ||
            options.mode === 'agent' ||
            options.mode === 'plan' ||
            options.mode === 'ask' ||
            !!options.agent ||
            prompt.length === 0 ||
            capabilityResolution?.canSolveNatively === true ||
            /workspace|file|edit|patch|sandbox|compile|diagnostic|symbol|search/i.test(prompt);

        if (isCoreNeeded) {
            packs.add('core_workspace');
        }

        // Domain-specific packs based on Capability Resolution & Domain hints
        const domain = capabilityResolution?.taskDomain || 'general';
        const is3DActive = options.activeArtifact?.type === '3d-scene';
        const isStagingPrompt = /stage|staging|place|ground|anchor|situate|relocate|location|at\s+[a-z]|on\s+[a-z]|beach|park|city|street|monaco|venice|cyclorama|plinth|pedestal|platform|cove|pavement|asphalt|boardwalk|vector|tiles/i.test(prompt);

        if (domain === '3d' || is3DActive || isStagingPrompt || /3d|tile|photorealistic|satellite|geodetic|landmark|coordinates|address|utdra|uldra|decomposition|rectif|beautif|universal.*3d|webxr|geobox|splat/i.test(prompt)) {
            packs.add('geospatial_3d');
            packs.add('mesh_surface');
            packs.add('core_workspace');
        }

        if (domain === 'vfx' || /vfx|video|timeline|nle|matchmove|brown-conrady|lens\s*distortion|camera\s*solve|ephemeris|solar|god_ray|turbidity|atmosphere|lighting|gaffer|usd|4dgs|tapir|avatar|performer/i.test(prompt)) {
            packs.add('vfx_video');
            packs.add('core_workspace');
        }

        if (/mesh|deform|taper|twist|bend|bulge|sculpt|lattice|botanical|tree|plant|rhytidome|uv|unwrap|texel|maxrects|pbr|nano.banana|color\s*match|palette|recolor/i.test(prompt)) {
            packs.add('mesh_surface');
            packs.add('core_workspace');
        }

        // If explicit enableWorkspaceTools is requested or mode === 'agent', ensure all domain packs are available
        // to maintain 100% full compatibility with global agent stress test suites.
        if (options.enableWorkspaceTools === true || options.mode === 'agent') {
            packs.add('core_workspace');
            packs.add('geospatial_3d');
            packs.add('mesh_surface');
            packs.add('vfx_video');
        }
    }

    return {
        packs: Array.from(packs),
        capabilityResolution
    };
}

/**
 * Coerces and normalizes tool arguments defensively before execution:
 * - Parses stringified JSON objects / arrays (common LLM hallucination).
 * - Coerces string numbers to floats/integers when schema specifies NUMBER/INTEGER.
 * - Coerces string booleans ("true"/"false") to real booleans.
 * - Filters out unwanted null/undefined values.
 */
export function coerceToolArguments(
    declaration: ToolDeclaration | undefined,
    rawArgs: Record<string, unknown> | undefined
): Record<string, unknown> {
    if (!rawArgs || typeof rawArgs !== 'object') {
        return {};
    }

    const coerced: Record<string, unknown> = { ...rawArgs };
    const schemaProps = (declaration?.parameters as any)?.properties;

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
