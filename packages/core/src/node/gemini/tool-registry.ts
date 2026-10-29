/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { isReadOnlyMode, PARENT_ONLY_TOOLS, READ_ONLY_TOOLS } from './tool-permissions';
import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import type { McpExecutionState } from '../../browser/generative-canvas/canvas-types';
import { errorMessage } from './gemini-client';
import { createLoadToolsHandler, ENTRY_TOOL_NAMES, LOAD_TOOLS_NAME, loadToolsDeclaration, toolOfferMode, type ToolOfferMode } from './tool-catalog';

// Re-export all tool types, schemas, declarations, and handlers from domain modules
export * from './tools';
export * from './domain-tool-packs';
import {
    coerceToolArguments,
    ALL_TOOL_PACKS,
    type ToolPackName
} from './domain-tool-packs';

import {
    type ToolDeclaration,
    type ToolGroup,
    type ToolResultPayload,
    type ToolExecutionResult,
    type ToolHandlerOutcome,
    type ToolContext,
    type ToolHandler,
    type ToolFallbackHandler,
    type GeminiFunctionCall,
    type GeminiToolConfig,
    CANVAS_TOOL_DECLARATIONS,
    canvasHandlers,
    WORKSPACE_TOOL_DECLARATIONS,
    workspaceHandlers,
    GOOGLE_3D_TILES_TOOL_DECLARATIONS,
    google3DTilesHandlers,
    PANORAMA_TOOL_DECLARATIONS,
    panoramaHandlers,
    UTDRA_TOOL_DECLARATIONS,
    utdraHandlers,
    VFX_VIDEO_TOOL_DECLARATIONS,
    vfxVideoHandlers,
    PROMPT_TEMPLATE_TOOL_NAMES,
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS,
    adaptiveMatchmoveHandlers,
    NANO_BANANA_TOOL_DECLARATIONS,
    nanoBananaHandlers,
    IMAGE_GENERATION_TOOL_DECLARATIONS,
    imageGenerationHandlers,
    ALGORITHMIC_UV_TOOL_DECLARATIONS,
    algorithmicUvHandlers,
    ATMOSPHERE_TOOL_DECLARATIONS,
    atmosphereHandlers,
    MESH_SHAPING_TOOL_DECLARATIONS,
    meshShapingHandlers,
    SB_RIG_TOOL_DECLARATIONS,
    sbRigHandlers,
    WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    webxrGeospatialHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS,
    geoboxPrecisionHandlers,
    GEOBOX_RESECTION_ALIAS_TOOL_NAMES,
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    opticsLensDistortionHandlers,
    BOTANICAL_TREE_TOOL_DECLARATIONS,
    botanicalTreeHandlers,
    SB_ROADIE_TOOL_DECLARATIONS,
    sbRoadieHandlers,
    LIGHTING_TOOL_DECLARATIONS,
    lightingHandlers,
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
    analyticalGroomHandlers,
    UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS,
    universal3DStructureHandlers,
    PYTHON_3D_TOOL_DECLARATIONS,
    python3DHandlers,
    MASSING_TOOL_DECLARATIONS,
    massingHandlers,
    LENS_TOOL_DECLARATIONS,
    lensHandlers,
    BROWSER_TOOL_DECLARATIONS,
    browserHandlers,
    TILE_REFINE_TOOL_DECLARATIONS,
    tileRefineHandlers,
    SCENE_HEALING_TOOL_DECLARATIONS,
    sceneHealingHandlers,
    VIRTUAL_GEOMETRY_TOOL_DECLARATIONS,
    virtualGeometryHandlers,
    LOCATION_EVIDENCE_TOOL_DECLARATIONS,
    locationEvidenceHandlers,
    LOCATION_REFERENCE_TOOL_DECLARATIONS,
    locationReferenceHandlers,
    SURFACE_MATERIALS_TOOL_DECLARATIONS,
    surfaceMaterialsHandlers,
    IMAGE_TO_PBR_TOOL_DECLARATIONS,
    imageToPbrHandlers,
    PBR_MATERIAL_TOOL_DECLARATIONS,
    pbrMaterialHandlers,
    LOCAL_SF3D_TOOL_DECLARATIONS,
    LOCAL_SF3D_OFFERED_BY_DEFAULT,
    localSf3DHandlers,
    TURNAROUND_TOOL_DECLARATIONS,
    turnaroundHandlers,
    OBJECT_REFERENCE_TOOL_DECLARATIONS,
    objectReferenceHandlers,
    SB_SCRIPT_GUIDE_TOOL_DECLARATIONS,
    sbScriptGuideHandlers,
    TEXTURE_LIBRARY_TOOL_DECLARATIONS,
    textureLibraryHandlers,
    WEATHERING_TOOL_DECLARATIONS,
    WEATHERING_TOOL_HANDLERS,
    HYDRAULIC_EROSION_TOOL_DECLARATIONS,
    HYDRAULIC_EROSION_TOOL_HANDLERS
} from './tools';

interface ToolRegistration {
    name: string;
    group: ToolGroup;
    declaration: ToolDeclaration;
    handler: ToolHandler;
    /** False for tools that run only when a request names them; they stay dispatchable but are not offered by group. */
    offeredByDefault: boolean;
    loadableWhenNamed?: boolean;
}

export interface ToolRegistrationOptions {
    offeredByDefault?: boolean;
    /**
     * For a tool not offered by default: list it in load_tools anyway, marked as used only when the user names it
     * (the model decides by meaning whether the request names it; tool-catalog.ts).
     */
    loadableWhenNamed?: boolean;
}

/**
 * Deprecated tool names: registered so saved scripts and chats still dispatch them, but not offered to the model
 * (hidden since 2026-10-20; remove after one release). Each one's description says what replaces it: the kept
 * tool for an alias, or the generation path that now applies a prompt template itself.
 */
export const DEPRECATED_TOOL_ALIASES: ReadonlySet<string> = new Set<string>([
    ...GEOBOX_RESECTION_ALIAS_TOOL_NAMES,
    ...PROMPT_TEMPLATE_TOOL_NAMES
]);

/** Registration options for a declaration: hidden when its name is a deprecated alias. */
function offeredUnlessDeprecated(name: string): ToolRegistrationOptions {
    return { offeredByDefault: !DEPRECATED_TOOL_ALIASES.has(name) };
}

interface GroupPresentation {
    prefix: string;
    mcpServerId: string;
    mcpName: string;
    humanTitle: (name: string) => string;
    cardTitle: (name: string, status: 'completed' | 'failed') => string;
    stepTitle: (name: string) => string;
    durationMs: { completed: number; failed: number };
    statusLabel: (status: 'completed' | 'failed') => string;
    unknownTool: 'fail' | 'noop';
    failurePayload: (message: string) => ToolResultPayload;
}

const GROUPS: Record<ToolGroup, GroupPresentation> = {
    workspace: {
        prefix: 'workspace_',
        mcpServerId: 'mcp-scratchbox-workspace',
        mcpName: 'Scratchbox Workspace',
        humanTitle: name => {
            if (name === 'mount_canvas_primitive') return 'Mount Canvas Primitive';
            if (name === 'morph_canvas_primitive') return 'Morph Canvas Primitive';
            if (name === 'ask_user_question') return 'Ask User Clarification';
            if (name === 'present_execution_plan') return 'Present Execution Plan';
            if (name === 'location_generate_3dgs') return 'Location 3DGS: Synthesize Radiance Field';
            if (name === 'location_building_shape') return 'Location Evidence: Building Shape';
            if (name === 'location_isolate_structure') return 'Location Evidence: Isolate Structure';
            if (name === 'location_split_block') return 'Location Evidence: Split Block';
            if (name === 'location_residual_audit') return 'Location Evidence: Residual Audit';
            if (name.startsWith('location_')) return `Location 3DGS: ${name.replace('location_', '').replace(/_/g, ' ')}`;
            if (name === 'google_3d_tiles_recolor_glb') return '3D Tiles: Recolor & PBR Synthesis';
            if (name.startsWith('google_3d_tiles_')) return `Google 3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Atmospheric Simulation: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Native Mesh Reshaping: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `VFX & Video Engine: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Adaptive Matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('continuous_spline_')) return `Continuous Spline Matchmove: ${name.replace('continuous_spline_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `SB-Veggie Botanical: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
            if (name === 'sb_roadie') return 'SB-Roadie: Road Surfaces';
            if (name.startsWith('lighting_')) return `Photometric Lighting: ${name.replace('lighting_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('archie_')) return `Archie Architecture: ${name.replace('archie_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('sb_terrain_')) return `SB-Terrain Engine: ${name.replace('sb_terrain_', '').replace(/_/g, ' ')}`;
            if (name === 'execute_3d_python_script') return 'Python 3D Engine: Execute Procedural Script';
            if (name === 'build_3d_object_from_reference') return '3D Object: Build from Internal Reference';
            if (name === 'read_sb_script_guide') return 'Python 3D Engine: Read Script Guide';
            return `Workspace Action: ${name}`;
        },
        cardTitle: (name, _status) => {
            if (name === 'mount_canvas_primitive') return 'Canvas: Mount Primitive';
            if (name === 'morph_canvas_primitive') return 'Canvas: Morph Primitive';
            if (name === 'ask_user_question') return 'User: Clarify Choice';
            if (name === 'present_execution_plan') return 'Plan: Review & Confirm';
            if (name === 'execute_3d_python_script') return 'Python 3D: Execute Script';
            if (name === 'build_3d_object_from_reference') return '3D Object: Build';
            if (name === 'read_sb_script_guide') return 'Python 3D: Script Guide';
            if (name === 'location_building_shape') return 'Location Evidence: Building Shape';
            if (name === 'location_isolate_structure') return 'Location Evidence: Isolate Structure';
            if (name === 'location_split_block') return 'Location Evidence: Split Block';
            if (name === 'location_residual_audit') return 'Location Evidence: Residual Audit';
            if (name.startsWith('location_')) return `Location 3DGS: ${name.replace('location_', '').replace(/_/g, ' ')}`;
            if (name === 'google_3d_tiles_recolor_glb') return '3D Tiles: Recolor & PBR';
            if (name.startsWith('google_3d_tiles_')) return `3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Atmosphere: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Mesh: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `VFX: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('continuous_spline_')) return `Spline Matchmove: ${name.replace('continuous_spline_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `Botanical: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
            if (name === 'sb_roadie') return 'SB-Roadie: road surfaces';
            if (name.startsWith('lighting_')) return `Lighting: ${name.replace('lighting_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('archie_')) return `Archie: ${name.replace('archie_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('sb_terrain_')) return `SB-Terrain: ${name.replace('sb_terrain_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('universal_3d_structure_')) return `Universal 3D: ${name.replace('universal_3d_structure_', '').replace(/_/g, ' ')}`;
            return `Workspace: ${name}`;
        },
        stepTitle: name => {
            if (name === 'mount_canvas_primitive') return 'Mount canvas primitive on stage';
            if (name === 'morph_canvas_primitive') return 'Morph active canvas primitive into a different view';
            if (name === 'ask_user_question') return 'Ask user clarifying question with structured choices';
            if (name === 'present_execution_plan') return 'Present execution plan card for confirmation';
            if (name === 'execute_3d_python_script') return 'Execute procedural 3D Python script with Scratchbox C++20 engine';
            if (name === 'build_3d_object_from_reference') return 'Draw an internal reference, read it into a build spec and build the object natively in clay';
            if (name === 'read_sb_script_guide') return 'Read the rules for writing an sb Python script';
            if (name === 'location_building_shape') return 'Read the building footprint, vector height, Solar DSM and roof segments at a place';
            if (name === 'location_isolate_structure') return 'Isolate one structure from Google 3D Tiles: footprint, ground, kept and removed areas';
            if (name === 'location_split_block') return 'Split a block from Google 3D Tiles into one mesh per building footprint, party walls and the unassigned rest';
            if (name === 'location_residual_audit') return 'Judge the leftover scan clusters of a staged build: real objects, scan artefacts, unsure, from measured numbers';
            if (name.startsWith('location_')) return `Synthesize real-world location 3D Gaussian Splats: ${name.replace('location_', '').replace(/_/g, ' ')}`;
            if (name === 'google_3d_tiles_recolor_glb') return 'Recolor 3D tile GLB with material segmentation and PBR normal/roughness synthesis';
            if (name.startsWith('google_3d_tiles_')) return `Ingest Google 3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Simulate atmospheric lighting: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Reshape 3D mesh via native C++20 engine: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `Execute video & VFX operation: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Calibrate and resect camera matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('continuous_spline_')) return `Optimize continuous spline camera trajectory: ${name.replace('continuous_spline_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `Synthesize 1:1 metric botanical tree: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
            if (name === 'sb_roadie') return 'Measure and rebuild the streets with SB-Roadie';
            if (name.startsWith('lighting_')) return `Compute photometric lighting: ${name.replace('lighting_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('archie_')) return `Refine building structure with Archie: ${name.replace('archie_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('sb_terrain_')) return `Classify terrain materials with SB-Terrain: ${name.replace('sb_terrain_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('universal_3d_structure_')) return `Universal 3D Structure Foundation: ${name.replace('universal_3d_structure_', '').replace(/_/g, ' ')}`;
            return `Invoke ${name}`;
        },
        durationMs: { completed: 25, failed: 25 },
        statusLabel: status => status,
        unknownTool: 'fail',
        failurePayload: message => ({ status: 'failed', error: message })
    },
    lens: {
        prefix: 'lens_',
        mcpServerId: 'mcp-scratchbox-lens',
        mcpName: 'Codebase Lens',
        humanTitle: name => `Lens Tool: ${name}`,
        cardTitle: name => `Lens: ${name}`,
        stepTitle: name => `Invoke ${name}`,
        durationMs: { completed: 30, failed: 30 },
        statusLabel: status => status,
        unknownTool: 'fail',
        failurePayload: message => ({ success: false, error: message })
    },
    browser: {
        prefix: 'browser_',
        mcpServerId: 'mcp-scratchbox-browser',
        mcpName: 'Scratchbox Browser',
        humanTitle: name => `Execute Browser Tool: ${name}`,
        cardTitle: (name, status) => status === 'completed' ? `Browser Action: ${name}` : `Browser Action Failed: ${name}`,
        stepTitle: name => `Invoke ${name} in browser bridge`,
        durationMs: { completed: 45, failed: 12 },
        statusLabel: status => status === 'completed' ? 'success' : 'failed',
        unknownTool: 'fail',
        failurePayload: message => ({ status: 'failed', error: message })
    },
    mcp: {
        prefix: '',
        mcpServerId: 'mcp-live',
        mcpName: 'Live MCP Tool',
        humanTitle: name => `Execute MCP Tool: ${name}`,
        cardTitle: name => `MCP Execution: ${name}`,
        stepTitle: name => `Invoke ${name}`,
        durationMs: { completed: 25, failed: 25 },
        statusLabel: status => status,
        unknownTool: 'fail',
        failurePayload: message => ({ status: 'failed', error: message })
    }
};

const PREFIXED_GROUPS: Array<Exclude<ToolGroup, 'mcp'>> = ['workspace', 'lens', 'browser'];

export function inferToolGroup(name: string): ToolGroup {
    if (typeof name !== 'string') return 'workspace';
    if (name.startsWith('lens_')) return 'lens';
    if (name.startsWith('browser_')) return 'browser';
    if (
        name === 'invoke_subagent' ||
        name === 'send_message' ||
        name === 'mount_canvas_primitive' ||
        name === 'execute_3d_python_script' ||
        name === 'ask_user_question' ||
        name === 'present_execution_plan' ||
        name.startsWith('workspace_') ||
        name.startsWith('google_3d_tiles_') ||
        name.startsWith('location_') ||
        name === 'splat_to_3dtiles' ||
        name.startsWith('survey_') ||
        name.startsWith('utdra_') ||
        name.startsWith('atmosphere_') ||
        name.startsWith('mesh_') ||
        name.startsWith('webxr_geospatial_') ||
        name.startsWith('geobox_') ||
        name.startsWith('spatial_') ||
        name.startsWith('optics_') ||
        name.startsWith('panorama_') ||
        name.startsWith('nano_banana_') ||
        name.startsWith('algorithmic_uv_') ||
        name === 'uv_analyze_texel_density' ||
        name.startsWith('vfx_') ||
        name.startsWith('build_') ||
        name.startsWith('generate_') ||
        name.startsWith('adaptive_matchmove_') ||
        name.startsWith('continuous_spline_') ||
        name.startsWith('botanical_') ||
        name === 'sb_roadie' ||
        name.startsWith('archie_') ||
        name.startsWith('sb_terrain_') ||
        name.startsWith('mediapipe_') ||
        name === 'gemini_estimate_scene_depth' ||
        name === 'configure_physical_camera' ||
        name === 'camera_track_focus_target' ||
        name.startsWith('tapir_') ||
        name.startsWith('avatar_') ||
        name.startsWith('performer_') ||
        name === 'pbr_material_decompose' ||
        name === 'atlas_maxrects_pack' ||
        name === 'build_beautify_prompt'
    ) return 'workspace';
    for (const group of PREFIXED_GROUPS) {
        if (name.startsWith(GROUPS[group].prefix)) return group;
    }
    return 'mcp';
}

const timestampNow = (): string => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const execId = (): string => `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function sanitizeSchemaNode(schemaNode: any): any {
    if (!schemaNode || typeof schemaNode !== 'object') return schemaNode;
    const sanitized = { ...schemaNode };
    const typeStr = String(sanitized.type || '').toUpperCase();
    if (typeStr === 'ARRAY' && !sanitized.items) {
        sanitized.items = { type: 'STRING' };
    }
    if (sanitized.items && typeof sanitized.items === 'object') {
        sanitized.items = sanitizeSchemaNode(sanitized.items);
    }
    if (sanitized.properties && typeof sanitized.properties === 'object') {
        const nextProps: Record<string, any> = {};
        for (const [key, val] of Object.entries(sanitized.properties)) {
            nextProps[key] = sanitizeSchemaNode(val);
        }
        sanitized.properties = nextProps;
    }
    return sanitized;
}

export function sanitizeToolDeclaration(decl: ToolDeclaration): ToolDeclaration {
    if (!decl || !decl.parameters) return decl;
    return {
        ...decl,
        parameters: sanitizeSchemaNode(decl.parameters)
    };
}

/**
 * Registry of Gemini function-calling tools. Each tool contributes its declaration and a handler;
 * `dispatch` resolves a model tool call to a handler, runs it with a `ToolContext`, and wraps the
 * outcome in `McpExecutionState` telemetry. Unknown names fall through to an optional fallback
 * (used for attached MCP tools that have no native implementation).
 */
export class ToolRegistry {
    private readonly tools = new Map<string, ToolRegistration>();
    private fallback?: ToolFallbackHandler;

    register(name: string, declaration: ToolDeclaration, handler: ToolHandler, group: ToolGroup = inferToolGroup(name), options: ToolRegistrationOptions = {}): this {
        this.tools.set(name, { name, group, declaration: { ...declaration, name }, handler, offeredByDefault: options.offeredByDefault !== false, loadableWhenNamed: options.loadableWhenNamed === true });
        return this;
    }

    setFallback(handler: ToolFallbackHandler | undefined): this {
        this.fallback = handler;
        return this;
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    get(name: string): ToolRegistration | undefined {
        return this.tools.get(name);
    }

    getTool(name: string): ToolRegistration | undefined {
        return this.tools.get(name);
    }

    names(group?: ToolGroup): string[] {
        return Array.from(this.tools.values()).filter(t => !group || t.group === group).map(t => t.name);
    }

    /** Declarations offered by default for the given groups (all groups when omitted), in registration order. */
    declarations(groups?: ToolGroup[]): ToolDeclaration[] {
        const wanted = groups ? new Set(groups) : undefined;
        return Array.from(this.tools.values())
            .filter(t => t.offeredByDefault && (!wanted || wanted.has(t.group)))
            .map(t => sanitizeToolDeclaration(t.declaration));
    }

    /** Declarations of tools not offered by default that load_tools lists for when the user names them. */
    namedOnlyDeclarations(groups?: ToolGroup[]): ToolDeclaration[] {
        const wanted = groups ? new Set(groups) : undefined;
        return Array.from(this.tools.values())
            .filter(t => !t.offeredByDefault && t.loadableWhenNamed && (!wanted || wanted.has(t.group)))
            .map(t => sanitizeToolDeclaration(t.declaration));
    }

    /** Declarations focused on targeted domain tool packs. */
    declarationsForPacks(packs: ToolPackName[]): ToolDeclaration[] {
        const toolNames = new Set<string>();
        for (const pack of packs) {
            const def = ALL_TOOL_PACKS[pack];
            if (def) {
                for (const name of def.toolNames) {
                    toolNames.add(name);
                }
            }
        }
        return Array.from(this.tools.values())
            .filter(t => t.offeredByDefault && toolNames.has(t.name))
            .map(t => sanitizeToolDeclaration(t.declaration));
    }

    async dispatch(name: string, args: Record<string, unknown> | undefined, ctx: ToolContext): Promise<ToolExecutionResult> {
        const registration = this.tools.get(name);
        const safeArgs = coerceToolArguments(registration?.declaration, args);
        if (registration) {
            return this.run(registration, safeArgs, ctx);
        }

        const group = inferToolGroup(name);
        if (group !== 'mcp') {
            const presentation = GROUPS[group];
            if (presentation.unknownTool === 'noop') {
                return this.wrap(group, name, { resultPayload: { status: 'success', data: undefined }, status: 'completed', summaryResult: `Successfully executed ${name}.` });
            }
            const message = `Unknown ${group} tool: ${name}`;
            return this.wrap(group, name, { resultPayload: presentation.failurePayload(message), status: 'failed', summaryResult: `Failed: ${message}` });
        }

        if (this.fallback) {
            return this.fallback({ name, args: safeArgs }, ctx);
        }
        throw new Error(`No handler registered for tool "${name}"`);
    }

    private async run(registration: ToolRegistration, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
        const group = registration.group;
        try {
            const outcome = await registration.handler(args, ctx);
            return this.wrap(group, registration.name, outcome);
        } catch (err: unknown) {
            const message = errorMessage(err);
            return this.wrap(group, registration.name, {
                resultPayload: GROUPS[group].failurePayload(message),
                status: 'failed',
                summaryResult: `Failed: ${message}`
            });
        }
    }

    private wrap(group: ToolGroup, name: string, outcome: ToolHandlerOutcome): ToolExecutionResult {
        const presentation = GROUPS[group];
        const status = outcome.status || 'completed';
        const summaryResult = outcome.summaryResult ?? '';
        const errorText = typeof outcome.resultPayload.error === 'string' ? outcome.resultPayload.error : summaryResult;

        const items: NonNullable<McpExecutionState['humanFriendlyOutput']>['items'] = [
            { label: 'Status', value: presentation.statusLabel(status), color: status === 'completed' ? 'emerald' : 'rose' }
        ];
        if (group === 'browser' && status === 'failed') {
            items.push({ label: 'Error', value: errorText, color: 'rose' });
        } else {
            items.push({ label: 'Tool', value: name, color: 'indigo' });
        }
        if (group === 'workspace') {
            items.push({ label: 'Result', value: summaryResult.slice(0, 80), color: 'blue' });
        }

        const exec: McpExecutionState = {
            id: execId(),
            mcpServerId: presentation.mcpServerId,
            mcpName: presentation.mcpName,
            toolName: name,
            humanTitle: presentation.humanTitle(name),
            status,
            timestamp: timestampNow(),
            steps: [
                { id: 's1', title: presentation.stepTitle(name), status: status === 'completed' ? 'done' : 'failed', durationMs: presentation.durationMs[status] }
            ],
            summaryResult,
            humanFriendlyOutput: {
                cardType: 'status-card',
                title: presentation.cardTitle(name, status),
                items
            }
        };

        return { exec, resultPayload: outcome.resultPayload };
    }
}

// ----------------------------------------------------------------------
// Request-driven tool selection
// ----------------------------------------------------------------------

/**
 * The Vertex `tools` payload for a request: Google Search grounding, code execution when asked for, and the function
 * declarations. Which declarations go out is decided by the request's switches (mode, enableWorkspaceTools,
 * enableLensTools, enableBrowserTools, toolPacks, attached MCP tools) and the tools loaded so far, never by words in
 * the prompt (AGENTS.md ADA 1.2). In catalog mode (tool-catalog.ts) the entry set and load_tools come first, in a
 * fixed order, so they are a stable prefix the prompt cache reuses; loaded tools follow in the order they were loaded.
 */
export function buildToolDeclarations(
    request: GeminiGenerateRequest,
    registry: ToolRegistry,
    mcpDeclarations: ToolDeclaration[] = [],
    mode: ToolOfferMode = toolOfferMode()
): GeminiToolConfig[] | undefined {
    const workspaceAllowed = request.enableWorkspaceTools !== false;
    const lensOn = request.enableLensTools === true;
    const browserOn = request.enableBrowserTools === true || !!request.agent;
    // With workspace tools allowed, lens and browser tools are available unless switched off (offered whole when
    // switched on, else loadable); without them, only a group that is switched on is offered.
    const groups: ToolGroup[] = [];
    if (workspaceAllowed) groups.push('workspace');
    if (lensOn || (workspaceAllowed && request.enableLensTools !== false)) groups.push('lens');
    if (browserOn || (workspaceAllowed && request.enableBrowserTools !== false)) groups.push('browser');
    // Tools the switches allow, in registration order.
    let allowed: ToolDeclaration[] = registry.declarations(groups);
    if (Array.isArray(request.toolPacks) && request.toolPacks.length > 0) {
        // Named packs narrow the allowed tools; they never bring back a group the request switched off.
        const groupOn = new Set(groups);
        allowed = registry.declarationsForPacks(request.toolPacks).filter(d => {
            const group = registry.get(d.name)?.group;
            return !!group && groupOn.has(group);
        });
    }
    // Plan and Ask may only use tools that cannot change anything (enforced again at execution).
    // A subagent reports back to its parent agent, so it gets no user-facing or delegation tools.
    const permitted = (d: Pick<ToolDeclaration, 'name'>) =>
        (!isReadOnlyMode(request.mode) || READ_ONLY_TOOLS.has(d.name)) && (!request.isSubagentRun || !PARENT_ONLY_TOOLS.has(d.name));
    allowed = allowed.filter(permitted);

    let offered: ToolDeclaration[];
    if (mode === 'all' || (Array.isArray(request.toolPacks) && request.toolPacks.length > 0)) {
        // Every allowed tool (named packs are an explicit choice, offered whole).
        // As before 2026-10-20: every allowed tool, except that lens and browser tools need their switch on.
        offered = allowed.filter(d => {
            const group = registry.get(d.name)?.group;
            if (group === 'lens') return lensOn;
            if (group === 'browser') return browserOn;
            return true;
        });
    } else {
        // Explicitly switched-on groups are offered whole; the rest of the allowed tools are listed in load_tools.
        const upfront = (d: ToolDeclaration) => {
            const group = registry.get(d.name)?.group;
            return (group === 'lens' && lensOn) || (group === 'browser' && browserOn);
        };
        const byName = new Map(allowed.map(d => [d.name, d]));
        const entry = ENTRY_TOOL_NAMES.filter(n => n !== LOAD_TOOLS_NAME).map(n => byName.get(n)).filter((d): d is ToolDeclaration => !!d);
        const entryNames = new Set(entry.map(d => d.name));
        const switchedOn = allowed.filter(d => !entryNames.has(d.name) && upfront(d));
        const offeredNames = new Set([...entryNames, ...switchedOn.map(d => d.name)]);
        const namedOnly = request.toolPacks?.length ? [] : registry.namedOnlyDeclarations(groups).filter(permitted);
        const catalog = [...allowed.filter(d => !offeredNames.has(d.name)), ...namedOnly.map(d => ({ ...d, description: `Only when the user names it: ${d.description || ''}` }))];
        const loadableByName = new Map(namedOnly.map(d => [d.name, d]));
        const loaded = [...new Set(request.loadedTools || [])].map(n => byName.get(n) ?? loadableByName.get(n)).filter((d): d is ToolDeclaration => !!d && !offeredNames.has(d.name));
        offered = [...entry, ...switchedOn];
        if (catalog.length > 0 && registry.has(LOAD_TOOLS_NAME) && permitted({ name: LOAD_TOOLS_NAME })) {
            offered.push(loadToolsDeclaration(catalog));
        }
        offered.push(...loaded);
    }
    const allFunctionDeclarations: ToolDeclaration[] = [...offered, ...mcpDeclarations];

    const tools: GeminiToolConfig[] = [];
    if (request.enableGoogleSearch !== false || request.requireGoogleSearch) {
        tools.push({ googleSearch: {} });
    }
    if (request.enableCodeExecution) {
        tools.push({ codeExecution: {} });
    }
    if (allFunctionDeclarations.length > 0) {
        tools.push({ functionDeclarations: allFunctionDeclarations });
    }

    return tools.length > 0 ? tools : undefined;
}

/**
 * Registers each declaration of one tool pack with its handler. Building the default registry must never register a
 * name twice (Map.set would silently replace the earlier tool) or a declaration with no handler (the model would be
 * offered a tool it cannot run), so both throw, naming the tool.
 */
export function registerTools(
    registry: ToolRegistry,
    declarations: ToolDeclaration[],
    handlers: Record<string, ToolHandler | undefined>,
    group: ToolGroup,
    optionsFor: (name: string) => ToolRegistrationOptions = () => ({})
): void {
    for (const decl of declarations) {
        if (registry.has(decl.name)) throw new Error(`Tool "${decl.name}" is registered twice (already in the ${registry.get(decl.name)!.group} group)`);
        const handler = handlers[decl.name];
        if (typeof handler !== 'function') throw new Error(`Tool "${decl.name}" has a declaration but no handler`);
        registry.register(decl.name, decl, handler, group, optionsFor(decl.name));
    }
}

/** Registry pre-loaded with the workspace, lens, browser, google 3d tiles, utdra, ai beautify, atmosphere, webxr geospatial, geobox, optics and canvas tool suites. */
export function createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerTools(registry, CANVAS_TOOL_DECLARATIONS, canvasHandlers, 'workspace');
    registerTools(registry, WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers, 'workspace');
    registerTools(registry, GOOGLE_3D_TILES_TOOL_DECLARATIONS, google3DTilesHandlers, 'workspace');
    // Some panorama-pack tools (Street View grounding, vector staging) keep their handlers in analyticalGroomHandlers.
    registerTools(registry, PANORAMA_TOOL_DECLARATIONS, { ...analyticalGroomHandlers, ...panoramaHandlers }, 'workspace');
    registerTools(registry, UTDRA_TOOL_DECLARATIONS, utdraHandlers, 'workspace');
    registerTools(registry, TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers, 'workspace');
    registerTools(registry, SCENE_HEALING_TOOL_DECLARATIONS, sceneHealingHandlers, 'workspace');
    registerTools(registry, VIRTUAL_GEOMETRY_TOOL_DECLARATIONS, virtualGeometryHandlers, 'workspace');
    registerTools(registry, LOCATION_EVIDENCE_TOOL_DECLARATIONS, locationEvidenceHandlers, 'workspace');
    registerTools(registry, LOCATION_REFERENCE_TOOL_DECLARATIONS, locationReferenceHandlers, 'workspace');
    registerTools(registry, SURFACE_MATERIALS_TOOL_DECLARATIONS, surfaceMaterialsHandlers, 'workspace');
    registerTools(registry, ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS, adaptiveMatchmoveHandlers, 'workspace');
    registerTools(registry, VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers, 'workspace', offeredUnlessDeprecated);
    registerTools(registry, NANO_BANANA_TOOL_DECLARATIONS, nanoBananaHandlers, 'workspace');
    registerTools(registry, IMAGE_GENERATION_TOOL_DECLARATIONS, imageGenerationHandlers, 'workspace');
    registerTools(registry, ALGORITHMIC_UV_TOOL_DECLARATIONS, algorithmicUvHandlers, 'workspace');
    registerTools(registry, ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers, 'workspace');
    registerTools(registry, MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers, 'workspace');
    registerTools(registry, SB_RIG_TOOL_DECLARATIONS, sbRigHandlers, 'workspace');
    registerTools(registry, WEBXR_GEOSPATIAL_TOOL_DECLARATIONS, webxrGeospatialHandlers, 'workspace');
    registerTools(registry, GEOBOX_PRECISION_TOOL_DECLARATIONS, geoboxPrecisionHandlers, 'workspace', offeredUnlessDeprecated);
    registerTools(registry, OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS, opticsLensDistortionHandlers, 'workspace');
    registerTools(registry, BOTANICAL_TREE_TOOL_DECLARATIONS, botanicalTreeHandlers, 'workspace');
    registerTools(registry, SB_ROADIE_TOOL_DECLARATIONS, sbRoadieHandlers, 'workspace');
    registerTools(registry, LIGHTING_TOOL_DECLARATIONS, lightingHandlers, 'workspace');
    registerTools(registry, POSE_DEPTH_TOOL_DECLARATIONS, poseDepthHandlers, 'workspace');
    registerTools(registry, PHYSICAL_CAMERA_TOOL_DECLARATIONS, physicalCameraHandlers, 'workspace');
    registerTools(registry, TAPIR_4DGS_TOOL_DECLARATIONS, tapir4dgsHandlers, 'workspace');
    registerTools(registry, AVATAR_4DGS_TOOL_DECLARATIONS, avatar4dgsHandlers, 'workspace');
    registerTools(registry, HUMANOID_AVATAR_TOOL_DECLARATIONS, humanoidAvatarHandlers, 'workspace');
    registerTools(registry, ANALYTICAL_GROOM_TOOL_DECLARATIONS, analyticalGroomHandlers, 'workspace');
    registerTools(registry, UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS, universal3DStructureHandlers, 'workspace');
    registerTools(registry, PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers, 'workspace');
    registerTools(registry, MASSING_TOOL_DECLARATIONS, massingHandlers, 'workspace');
    registerTools(registry, OBJECT_REFERENCE_TOOL_DECLARATIONS, objectReferenceHandlers, 'workspace');
    registerTools(registry, SB_SCRIPT_GUIDE_TOOL_DECLARATIONS, sbScriptGuideHandlers, 'workspace');
    registerTools(registry, TEXTURE_LIBRARY_TOOL_DECLARATIONS, textureLibraryHandlers, 'workspace');
    // Declared in DEFAULT_TOOL_DECLARATIONS; without these the agent is offered tools it cannot dispatch.
    registerTools(registry, IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers, 'workspace');
    registerTools(registry, PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers, 'workspace');
    registerTools(registry, LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers, 'workspace', () => ({ offeredByDefault: LOCAL_SF3D_OFFERED_BY_DEFAULT, loadableWhenNamed: true }));
    registerTools(registry, TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers, 'workspace');
    registerTools(registry, LENS_TOOL_DECLARATIONS, lensHandlers, 'lens');
    registerTools(registry, BROWSER_TOOL_DECLARATIONS, browserHandlers, 'browser');
    registerTools(registry, WEATHERING_TOOL_DECLARATIONS, WEATHERING_TOOL_HANDLERS, 'workspace');
    registerTools(registry, HYDRAULIC_EROSION_TOOL_DECLARATIONS, HYDRAULIC_EROSION_TOOL_HANDLERS, 'workspace');
    // Not offered as itself: buildToolDeclarations builds its declaration (the catalog) per request.
    registry.register(LOAD_TOOLS_NAME, loadToolsDeclaration([]), createLoadToolsHandler(name => registry.has(name) && name !== LOAD_TOOLS_NAME), 'workspace', { offeredByDefault: false });
    return registry;
}
