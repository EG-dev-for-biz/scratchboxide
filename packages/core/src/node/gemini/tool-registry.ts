/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import type { McpExecutionState } from '../../browser/generative-canvas/canvas-types';
import { errorMessage } from './gemini-client';

// Re-export all tool types, schemas, declarations, and handlers from domain modules
export * from './tools';

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
    ALGORITHMIC_UV_TOOL_DECLARATIONS,
    algorithmicUvHandlers,
    ATMOSPHERE_TOOL_DECLARATIONS,
    atmosphereHandlers,
    MESH_SHAPING_TOOL_DECLARATIONS,
    meshShapingHandlers,
    WEBXR_GEOSPATIAL_TOOL_DECLARATIONS,
    webxrGeospatialHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS,
    geoboxPrecisionHandlers,
    OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS,
    opticsLensDistortionHandlers,
    COMFYUI_TOOL_DECLARATIONS,
    comfyuiHandlers,
    LENS_TOOL_DECLARATIONS,
    lensHandlers,
    BROWSER_TOOL_DECLARATIONS,
    browserHandlers
} from './tools';

interface ToolRegistration {
    name: string;
    group: ToolGroup;
    declaration: ToolDeclaration;
    handler: ToolHandler;
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
            if (name === 'google_3d_tiles_recolor_glb') return '3D Tiles: Recolor & PBR Synthesis';
            if (name.startsWith('google_3d_tiles_')) return `Google 3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Atmospheric Simulation: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Native Mesh Reshaping: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `VFX & Video Engine: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Adaptive Matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `SB-Veggie Botanical: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
            return `Workspace Action: ${name}`;
        },
        cardTitle: (name, _status) => {
            if (name === 'mount_canvas_primitive') return 'Canvas: Mount Primitive';
            if (name === 'google_3d_tiles_recolor_glb') return '3D Tiles: Recolor & PBR';
            if (name.startsWith('google_3d_tiles_')) return `3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Atmosphere: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Mesh: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `VFX: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `Botanical: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
            return `Workspace: ${name}`;
        },
        stepTitle: name => {
            if (name === 'mount_canvas_primitive') return 'Mount canvas primitive on stage';
            if (name === 'google_3d_tiles_recolor_glb') return 'Recolor 3D tile GLB with material segmentation and PBR normal/roughness synthesis';
            if (name.startsWith('google_3d_tiles_')) return `Ingest Google 3D Tiles: ${name.replace('google_3d_tiles_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('atmosphere_')) return `Simulate atmospheric lighting: ${name.replace('atmosphere_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('mesh_')) return `Reshape 3D mesh via native C++20 engine: ${name.replace('mesh_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('vfx_')) return `Execute video & VFX operation: ${name.replace('vfx_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('adaptive_matchmove_')) return `Calibrate and resect camera matchmove: ${name.replace('adaptive_matchmove_', '').replace(/_/g, ' ')}`;
            if (name.startsWith('botanical_')) return `Synthesize 1:1 metric botanical tree: ${name.replace('botanical_', '').replace(/_/g, ' ')}`;
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
        unknownTool: 'noop',
        failurePayload: message => ({ status: 'failed', error: message })
    },
    comfyui: {
        prefix: 'comfyui_',
        mcpServerId: 'mcp-scratchbox-comfyui',
        mcpName: 'ComfyUI Pipeline Engine',
        humanTitle: name => `ComfyUI Pipeline Action: ${name}`,
        cardTitle: (name, status) => status === 'completed' ? `ComfyUI: ${name}` : `ComfyUI Failed: ${name}`,
        stepTitle: name => `Execute ComfyUI pipeline: ${name}`,
        durationMs: { completed: 80, failed: 40 },
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

const PREFIXED_GROUPS: Array<Exclude<ToolGroup, 'mcp'>> = ['workspace', 'lens', 'browser', 'comfyui'];

export function inferToolGroup(name: string): ToolGroup {
    if (typeof name !== 'string') return 'workspace';
    if (
        name === 'invoke_subagent' ||
        name === 'send_message' ||
        name === 'mount_canvas_primitive' ||
        name.startsWith('google_3d_tiles_') ||
        name.startsWith('utdra_') ||
        name.startsWith('atmosphere_') ||
        name.startsWith('mesh_') ||
        name.startsWith('webxr_geospatial_') ||
        name.startsWith('geobox_') ||
        name.startsWith('panorama_') ||
        name.startsWith('nano_banana_') ||
        name.startsWith('algorithmic_uv_') ||
        name.startsWith('vfx_') ||
        name.startsWith('adaptive_matchmove_') ||
        name.startsWith('botanical_') ||
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

/**
 * Registry of Gemini function-calling tools. Each tool contributes its declaration and a handler;
 * `dispatch` resolves a model tool call to a handler, runs it with a `ToolContext`, and wraps the
 * outcome in `McpExecutionState` telemetry. Unknown names fall through to an optional fallback
 * (used for attached MCP tools that have no native implementation).
 */
export class ToolRegistry {
    private readonly tools = new Map<string, ToolRegistration>();
    private fallback?: ToolFallbackHandler;

    register(name: string, declaration: ToolDeclaration, handler: ToolHandler, group: ToolGroup = inferToolGroup(name)): this {
        this.tools.set(name, { name, group, declaration: { ...declaration, name }, handler });
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

    /** Declarations for the given groups (all groups when omitted), in registration order. */
    declarations(groups?: ToolGroup[]): ToolDeclaration[] {
        const wanted = groups ? new Set(groups) : undefined;
        return Array.from(this.tools.values())
            .filter(t => !wanted || wanted.has(t.group))
            .map(t => t.declaration);
    }

    async dispatch(name: string, args: Record<string, unknown> | undefined, ctx: ToolContext): Promise<ToolExecutionResult> {
        const safeArgs = args || {};
        const registration = this.tools.get(name);
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
    const isBrowserNeeded = !!(request.enableBrowserTools || request.agent ||
        (request.prompt && /browse|click|navigate|page|web|url|http|localhost/i.test(request.prompt)));

    const isLensNeeded = request.enableLensTools !== false && (
        request.enableLensTools === true ||
        !!(request.prompt && /lens|unproject|lens_project|lens_sync|codebase_lens/i.test(request.prompt))
    );

    const isWorkspaceNeeded = request.enableWorkspaceTools !== false && (
        request.enableWorkspaceTools === true ||
        request.mode === 'agent' ||
        request.mode === 'plan' ||
        request.mode === 'ask' ||
        !!request.agent ||
        !!(request.prompt && /workspace|file|edit|patch|sandbox|compile|diagnostic|symbol|semantic|search|3d|tile|photorealistic|satellite|geodetic|landmark|coordinates|address|utdra|uldra|decomposition|rectif|beautif|nano.banana|color\s*transfer|palette|recolor|omni|atmosphere|diurnal|ephemeris|scattering|god_ray|cloud_shadow|aerial_perspective|turbidity|reshape|deform|taper|twist|bend|bulge|sculpt|lattice/i.test(request.prompt))
    );

    const groups: ToolGroup[] = [];
    if (isWorkspaceNeeded) groups.push('workspace');
    if (isLensNeeded) groups.push('lens');
    if (isBrowserNeeded) groups.push('browser');

    const allFunctionDeclarations: ToolDeclaration[] = [
        ...(groups.length > 0 ? registry.declarations(groups) : []),
        ...mcpDeclarations
    ];

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

    const tools: GeminiToolConfig[] = [];
    if (request.enableGoogleSearch !== false) {
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

/** Registry pre-loaded with the workspace, lens, browser, comfyui, google 3d tiles, utdra, ai beautify, atmosphere, webxr geospatial, geobox, optics and canvas tool suites. */
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
        registry.register(decl.name, decl, panoramaHandlers[decl.name], 'workspace');
    }
    for (const decl of UTDRA_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, utdraHandlers[decl.name], 'workspace');
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
    for (const decl of ALGORITHMIC_UV_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, algorithmicUvHandlers[decl.name], 'workspace');
    }
    for (const decl of ATMOSPHERE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, atmosphereHandlers[decl.name], 'workspace');
    }
    for (const decl of MESH_SHAPING_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, meshShapingHandlers[decl.name], 'workspace');
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
    for (const decl of COMFYUI_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, comfyuiHandlers[decl.name], 'comfyui');
    }
    for (const decl of LENS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, lensHandlers[decl.name], 'lens');
    }
    for (const decl of BROWSER_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, browserHandlers[decl.name], 'browser');
    }
    return registry;
}
