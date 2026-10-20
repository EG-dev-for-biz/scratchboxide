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

// Re-export all tool types, schemas, declarations, and handlers from domain modules
export * from './tools';
export * from './domain-tool-packs';
import {
    resolveDomainToolPacks,
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
    AI_BEAUTIFY_TOOL_DECLARATIONS,
    aiBeautifyHandlers,
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
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    opticsLensDistortionHandlers,
    BOTANICAL_TREE_TOOL_DECLARATIONS,
    botanicalTreeHandlers,
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
    LENS_TOOL_DECLARATIONS,
    lensHandlers,
    BROWSER_TOOL_DECLARATIONS,
    browserHandlers,
    TILE_REFINE_TOOL_DECLARATIONS,
    tileRefineHandlers,
    VIRTUAL_GEOMETRY_TOOL_DECLARATIONS,
    virtualGeometryHandlers,
    LOCATION_EVIDENCE_TOOL_DECLARATIONS,
    locationEvidenceHandlers,
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
    sbScriptGuideHandlers
} from './tools';

interface ToolRegistration {
    name: string;
    group: ToolGroup;
    declaration: ToolDeclaration;
    handler: ToolHandler;
    /** False for tools that run only when a request names them; they stay dispatchable but are not offered by group. */
    offeredByDefault: boolean;
}

export interface ToolRegistrationOptions {
    offeredByDefault?: boolean;
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
            if (name.startsWith('lighting_')) return `Lighting: ${name.replace('lighting_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('archie_')) return `Archie: ${name.replace('archie_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('sb_terrain_')) return `SB-Terrain: ${name.replace('sb_terrain_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('universal_3d_structure_')) return `Universal 3D: ${name.replace('universal_3d_structure_', '').replace(/_/g, ' ')}`;
            return `Workspace: ${name}`;
        },
        stepTitle: name => {
            if (name === 'mount_canvas_primitive') return 'Mount canvas primitive on stage';
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
        this.tools.set(name, { name, group, declaration: { ...declaration, name }, handler, offeredByDefault: options.offeredByDefault !== false });
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
            .filter(t => toolNames.has(t.name))
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
 * Decide which tool groups a request needs and assemble the Vertex `tools` payload
 * (Google Search grounding, code execution, and function declarations).
 */
export function buildToolDeclarations(
    request: GeminiGenerateRequest,
    registry: ToolRegistry,
    mcpDeclarations: ToolDeclaration[] = []
): GeminiToolConfig[] | undefined {
    // 1. Pre-flight Capability Resolution & Domain Tool Packs
    const { packs, capabilityResolution } = resolveDomainToolPacks({
        prompt: request.prompt,
        mode: request.mode,
        domainHint: (request as any).domainHint,
        activeArtifact: request.activeArtifact,
        enableWorkspaceTools: request.enableWorkspaceTools,
        enableBrowserTools: request.enableBrowserTools,
        enableLensTools: request.enableLensTools,
        requestedPacks: (request as any).toolPacks,
        agent: request.agent
    });

    const isBrowserNeeded = !!(request.enableBrowserTools || request.agent ||
        packs.includes('browser') ||
        (request.prompt && /browse|click|navigate|page|web|url|http|localhost/i.test(request.prompt)));

    const isLensNeeded = request.enableLensTools !== false && (
        request.enableLensTools === true ||
        packs.includes('lens') ||
        !!(request.prompt && /lens|unproject|lens_project|lens_sync|codebase_lens/i.test(request.prompt))
    );

    const isWorkspaceNeeded = request.enableWorkspaceTools !== false && (
        request.enableWorkspaceTools === true ||
        request.mode === 'agent' ||
        request.mode === 'plan' ||
        request.mode === 'ask' ||
        !!request.agent ||
        capabilityResolution?.canSolveNatively === true ||
        capabilityResolution?.taskDomain === '3d' ||
        capabilityResolution?.taskDomain === 'vfx' ||
        capabilityResolution?.taskDomain === 'code' ||
        packs.includes('core_workspace') ||
        packs.includes('geospatial_3d') ||
        packs.includes('mesh_surface') ||
        packs.includes('vfx_video') ||
        !!(request.prompt && /workspace|file|edit|patch|sandbox|compile|diagnostic|symbol|semantic|search|3d|tile|photorealistic|satellite|geodetic|landmark|coordinates|address|utdra|uldra|decomposition|rectif|beautif|nano.banana|color\s*match|grade\s*match|color\s*transfer|palette|recolor|omni|atmosphere|diurnal|ephemeris|scattering|god_ray|cloud_shadow|aerial_perspective|turbidity|reshape|deform|taper|twist|bend|bulge|sculpt|lattice|neural|diffusion|matchmove|spline|botanical|avatar|4dgs|performer/i.test(request.prompt))
    );

    let functionDeclarations: ToolDeclaration[];

    // If explicit toolPacks are provided on the request, prioritize the focused pack declarations
    if ((request as any).toolPacks && Array.isArray((request as any).toolPacks) && (request as any).toolPacks.length > 0) {
        functionDeclarations = registry.declarationsForPacks((request as any).toolPacks);
    } else {
        const groups: ToolGroup[] = [];
        if (isWorkspaceNeeded) groups.push('workspace');
        if (isLensNeeded) groups.push('lens');
        if (isBrowserNeeded) groups.push('browser');

        functionDeclarations = groups.length > 0 ? registry.declarations(groups) : [];
    }

    const allFunctionDeclarations: ToolDeclaration[] = [
        ...functionDeclarations,
        ...mcpDeclarations
    ];

    // Guarantee that if capability resolution identified a specific targetTool, it is included
    if (capabilityResolution?.suggestedNativeAction?.targetTool) {
        const targetToolName = capabilityResolution.suggestedNativeAction.targetTool;
        if (!allFunctionDeclarations.some(d => d.name === targetToolName)) {
            const decl = registry.get(targetToolName)?.declaration;
            if (decl) {
                allFunctionDeclarations.push(sanitizeToolDeclaration(decl));
            }
        }
    }

    // Scratchbox Canvas Architecture: Ensure declarative canvas mounting is accessible for visual primitive synthesis
    const isCanvasNeeded = request.enableWorkspaceTools !== false && (
        isWorkspaceNeeded ||
        !!(request.prompt && /3d|scene|world|model|asteroid|flight|plane|spatial|terrain|mesh|sandbox|app\b|component|widget|calculator|preview|landing\s*page|doc\b|document|spec\b|proposal|paper|essay|report|board|kanban|graph\b|flow\b|pipeline|diagram|dashboard|canvas|mount/i.test(request.prompt))
    );

    if (isCanvasNeeded && !allFunctionDeclarations.some(d => d.name === 'mount_canvas_primitive')) {
        const canvasDecl = registry.declarations().find(d => d.name === 'mount_canvas_primitive');
        if (canvasDecl) {
            allFunctionDeclarations.push(canvasDecl);
        }
    }

    // Plan and Ask may only use tools that cannot change anything (enforced again at execution).
    // A subagent reports back to its parent agent, so it gets no user-facing or delegation tools.
    const offeredDeclarations = (isReadOnlyMode(request.mode)
        ? allFunctionDeclarations.filter(d => READ_ONLY_TOOLS.has(d.name))
        : allFunctionDeclarations
    ).filter(d => !request.isSubagentRun || !PARENT_ONLY_TOOLS.has(d.name));

    const tools: GeminiToolConfig[] = [];
    if (request.enableGoogleSearch !== false || request.requireGoogleSearch) {
        tools.push({ googleSearch: {} });
    }
    const is3DSceneRequest = /build.*3d|make.*3d|create.*3d|generate.*3d|3d\s+scene|3d\s+car|3d\s+vehicle|3d\s+model|\b3d\b|mesh\s*shaping|sculpt|flower|garden|plant|flora|botan|procedural|scratchbox|blender|building|plaza|architecture/i.test(request.prompt || '');
    if (request.enableCodeExecution && !is3DSceneRequest) {
        tools.push({ codeExecution: {} });
    }
    if (offeredDeclarations.length > 0) {
        tools.push({ functionDeclarations: offeredDeclarations });
    }

    return tools.length > 0 ? tools : undefined;
}

/** Registry pre-loaded with the workspace, lens, browser, google 3d tiles, utdra, ai beautify, atmosphere, webxr geospatial, geobox, optics and canvas tool suites. */
export function createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const decl of CANVAS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, canvasHandlers[decl.name], 'workspace');
    }
    for (const decl of WORKSPACE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, workspaceHandlers[decl.name], 'workspace');
    }
    for (const decl of GOOGLE_3D_TILES_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, google3DTilesHandlers[decl.name], 'workspace');
    }
    for (const decl of PANORAMA_TOOL_DECLARATIONS) {
        // Some panorama-pack tools (Street View grounding, vector staging) keep their handlers in analyticalGroomHandlers.
        registry.register(decl.name, decl, panoramaHandlers[decl.name] ?? analyticalGroomHandlers[decl.name], 'workspace');
    }
    for (const decl of UTDRA_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, utdraHandlers[decl.name], 'workspace');
    }
    for (const decl of TILE_REFINE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, tileRefineHandlers[decl.name], 'workspace');
    }
    for (const decl of VIRTUAL_GEOMETRY_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, virtualGeometryHandlers[decl.name], 'workspace');
    }
    for (const decl of LOCATION_EVIDENCE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, locationEvidenceHandlers[decl.name], 'workspace');
    }
    for (const decl of ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, adaptiveMatchmoveHandlers[decl.name], 'workspace');
    }
    for (const decl of VFX_VIDEO_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, vfxVideoHandlers[decl.name], 'workspace');
    }
    for (const decl of NANO_BANANA_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, nanoBananaHandlers[decl.name], 'workspace');
    }
    for (const decl of IMAGE_GENERATION_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, imageGenerationHandlers[decl.name], 'workspace');
    }
    for (const decl of ALGORITHMIC_UV_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, algorithmicUvHandlers[decl.name], 'workspace');
    }
    for (const decl of ATMOSPHERE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, atmosphereHandlers[decl.name], 'workspace');
    }
    for (const decl of MESH_SHAPING_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, meshShapingHandlers[decl.name], 'workspace');
    }
    for (const decl of SB_RIG_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, sbRigHandlers[decl.name], 'workspace');
    }
    for (const decl of WEBXR_GEOSPATIAL_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, webxrGeospatialHandlers[decl.name], 'workspace');
    }
    for (const decl of GEOBOX_PRECISION_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, geoboxPrecisionHandlers[decl.name], 'workspace');
    }
    for (const decl of OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, opticsLensDistortionHandlers[decl.name], 'workspace');
    }
    for (const decl of BOTANICAL_TREE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, botanicalTreeHandlers[decl.name], 'workspace');
    }
    for (const decl of LIGHTING_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, lightingHandlers[decl.name], 'workspace');
    }
    for (const decl of POSE_DEPTH_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, poseDepthHandlers[decl.name], 'workspace');
    }
    for (const decl of PHYSICAL_CAMERA_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, physicalCameraHandlers[decl.name], 'workspace');
    }
    for (const decl of TAPIR_4DGS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, tapir4dgsHandlers[decl.name], 'workspace');
    }
    for (const decl of AVATAR_4DGS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, avatar4dgsHandlers[decl.name], 'workspace');
    }
    for (const decl of HUMANOID_AVATAR_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, humanoidAvatarHandlers[decl.name], 'workspace');
    }
    for (const decl of ANALYTICAL_GROOM_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, analyticalGroomHandlers[decl.name], 'workspace');
    }
    for (const decl of UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, universal3DStructureHandlers[decl.name], 'workspace');
    }
    for (const decl of PYTHON_3D_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, python3DHandlers[decl.name], 'workspace');
    }
    for (const decl of OBJECT_REFERENCE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, objectReferenceHandlers[decl.name], 'workspace');
    }
    for (const decl of SB_SCRIPT_GUIDE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, sbScriptGuideHandlers[decl.name], 'workspace');
    }
    // Declared in DEFAULT_TOOL_DECLARATIONS; without these the agent is offered tools it cannot dispatch.
    for (const decl of IMAGE_TO_PBR_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, imageToPbrHandlers[decl.name], 'workspace');
    }
    for (const decl of PBR_MATERIAL_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, pbrMaterialHandlers[decl.name], 'workspace');
    }
    for (const decl of LOCAL_SF3D_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, localSf3DHandlers[decl.name], 'workspace', { offeredByDefault: LOCAL_SF3D_OFFERED_BY_DEFAULT });
    }
    for (const decl of TURNAROUND_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, turnaroundHandlers[decl.name], 'workspace');
    }
    for (const decl of LENS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, lensHandlers[decl.name], 'lens');
    }
    for (const decl of BROWSER_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, browserHandlers[decl.name], 'browser');
    }
    return registry;
}
