/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scratchbox IDE MCP Server
 *
 * Exposes Scratchbox's node-side tool handlers as MCP tools so that Claude Code
 * (or any other MCP client) can invoke them directly.
 *
 * Transport: stdio (spawned by the MCP client)
 * Context:   standalone — no IDE canvas / lens / browser proxy required.
 *            Tools that need those services will return a clear error message
 *            rather than crashing.
 *
 * Usage (add to .claude/mcp_settings.json):
 * {
 *   "mcpServers": {
 *     "scratchbox": {
 *       "command": "npx",
 *       "args": ["tsx", "packages/core/src/node/mcp/scratchbox-mcp-server.ts"],
 *       "env": { "SCRATCHBOX_WORKSPACE": "/path/to/scratchbox-ide-master" }
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Standalone-safe tool packs (no IDE canvas / lens / browser proxy required)
// ---------------------------------------------------------------------------
import {
    WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers,
    VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers,
    ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers,
    MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers,
    UTDRA_TOOL_DECLARATIONS, utdraHandlers,
    TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers,
    ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS, adaptiveMatchmoveHandlers,
    GEOBOX_PRECISION_TOOL_DECLARATIONS, geoboxPrecisionHandlers,
    BOTANICAL_TREE_TOOL_DECLARATIONS, botanicalTreeHandlers,
    LIGHTING_TOOL_DECLARATIONS, lightingHandlers,
    POSE_DEPTH_TOOL_DECLARATIONS, poseDepthHandlers,
    PHYSICAL_CAMERA_TOOL_DECLARATIONS, physicalCameraHandlers,

    UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS, universal3DStructureHandlers,
    PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers,
    IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers,
    PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers,
    LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers,
    TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers,
    type ToolDeclaration,
    type ToolHandler,
    type ToolContext,
    type ToolParameterSchema,
} from '../gemini/tools/index.js';

// ---------------------------------------------------------------------------
// Build the combined registry
// ---------------------------------------------------------------------------

const STANDALONE_PACKS: Array<[ToolDeclaration[], Record<string, ToolHandler>]> = [
    [WORKSPACE_TOOL_DECLARATIONS, workspaceHandlers],
    [VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers],
    [ATMOSPHERE_TOOL_DECLARATIONS, atmosphereHandlers],
    [MESH_SHAPING_TOOL_DECLARATIONS, meshShapingHandlers],
    [UTDRA_TOOL_DECLARATIONS, utdraHandlers],
    [TILE_REFINE_TOOL_DECLARATIONS, tileRefineHandlers],
    [ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS, adaptiveMatchmoveHandlers],
    [GEOBOX_PRECISION_TOOL_DECLARATIONS, geoboxPrecisionHandlers],
    [BOTANICAL_TREE_TOOL_DECLARATIONS, botanicalTreeHandlers],
    [LIGHTING_TOOL_DECLARATIONS, lightingHandlers],
    [POSE_DEPTH_TOOL_DECLARATIONS, poseDepthHandlers],
    [PHYSICAL_CAMERA_TOOL_DECLARATIONS, physicalCameraHandlers],

    [UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS, universal3DStructureHandlers],
    [PYTHON_3D_TOOL_DECLARATIONS, python3DHandlers],
    [IMAGE_TO_PBR_TOOL_DECLARATIONS, imageToPbrHandlers],
    [PBR_MATERIAL_TOOL_DECLARATIONS, pbrMaterialHandlers],
    [LOCAL_SF3D_TOOL_DECLARATIONS, localSf3DHandlers],
    [TURNAROUND_TOOL_DECLARATIONS, turnaroundHandlers],
];

const allDeclarations: ToolDeclaration[] = [];
const allHandlers: Record<string, ToolHandler> = {};

for (const [decls, handlers] of STANDALONE_PACKS) {
    for (const decl of decls) {
        if (!allHandlers[decl.name]) {
            allDeclarations.push(decl);
            if (handlers[decl.name]) {
                allHandlers[decl.name] = handlers[decl.name];
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Type adapter: ToolParameterSchema (uppercase) → MCP JSON Schema (lowercase)
// ---------------------------------------------------------------------------

function toJsonSchema(schema: ToolParameterSchema): Record<string, unknown> {
    const result: Record<string, unknown> = {
        type: schema.type.toLowerCase(),
    };
    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            props[key] = toJsonSchema(val);
        }
        result.properties = props;
    }
    if (schema.required) result.required = schema.required;
    if (schema.items) result.items = toJsonSchema(schema.items);
    return result;
}

function toMcpTool(decl: ToolDeclaration): McpTool {
    return {
        name: decl.name,
        description: decl.description,
        inputSchema: decl.parameters
            ? (toJsonSchema(decl.parameters) as McpTool['inputSchema'])
            : { type: 'object', properties: {} },
    };
}

// ---------------------------------------------------------------------------
// Minimal standalone ToolContext
// Handlers that require IDE-specific services will receive no-op stubs and
// should gracefully return an error or degrade; they shouldn't crash.
// ---------------------------------------------------------------------------

function makeStandaloneContext(workspaceRoot: string): ToolContext {
    const noop = () => { /* no-op */ };
    const stub = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === 'then') return undefined; // not a Promise
            // Return a function that throws with a clear error
            return (..._args: unknown[]) => {
                throw new Error(`Scratchbox MCP standalone: '${String(prop)}' requires the IDE to be running`);
            };
        }
    });

    return {
        workspaceRoot,
        request: {
            prompt: '',
            mode: 'chat',
        } as ToolContext['request'],
        sandbox: stub as ToolContext['sandbox'],
        lsp: stub as ToolContext['lsp'],
        contextGraph: stub as ToolContext['contextGraph'],
        browserProxy: stub as ToolContext['browserProxy'],
        lens: stub as ToolContext['lens'],
        reportProgress: noop,
    };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
    { name: 'scratchbox-ide', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allDeclarations.map(toMcpTool) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const handler = allHandlers[toolName];
    if (!handler) {
        return {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
        };
    }

    const workspaceRoot = process.env.SCRATCHBOX_WORKSPACE
        ?? path.resolve(__dirname, '../../../../..');

    const ctx = makeStandaloneContext(workspaceRoot);

    try {
        const outcome = await handler(args, ctx);
        return {
            content: [
                {
                    type: 'text',
                    text: outcome.summaryResult
                        ?? JSON.stringify(outcome.resultPayload, null, 2),
                },
            ],
            isError: outcome.status === 'failed',
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: 'text', text: `Error in ${toolName}: ${message}` }],
            isError: true,
        };
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr so it doesn't corrupt the stdio MCP channel
    process.stderr.write(`Scratchbox MCP server started (${allDeclarations.length} tools)\n`);
}

main().catch((err) => {
    process.stderr.write(`Scratchbox MCP server fatal: ${err}\n`);
    process.exit(1);
});
