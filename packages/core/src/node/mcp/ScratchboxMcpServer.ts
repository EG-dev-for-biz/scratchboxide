/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real MCP server for Scratchbox IDE.
 *
 * Adapts the existing ToolDeclaration/ToolHandler pairs from the Gemini tool registry
 * into proper MCP Tool definitions (JSON-Schema inputSchema) and registers them on an
 * @modelcontextprotocol/sdk Server instance.
 *
 * Transport: the server supports both stdio (for Claude Code / Claude Desktop integration)
 * and Express-based SSE/StreamableHTTP (for in-process use within the desktop-app server).
 *
 * Supersedes the cosmetic McpBridge.pingMcpServer() / buildFunctionDeclarations() fakes:
 * those remain in place for the UI telemetry cards but this file provides the actual
 * JSON-RPC 2.0 MCP protocol implementation.
 *
 * Claude Desktop config entry (add to ~/Library/Application Support/Claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "scratchbox": {
 *       "command": "node",
 *       "args": ["<repo>/packages/core/dist/node/mcp/scratchbox-mcp.js"]
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    type Tool,
    type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { ToolDeclaration, ToolHandler, ToolParameterSchema, ToolContext } from '../gemini/tools/types';

// ============================================================================
// Type utilities
// ============================================================================

/**
 * Converts a Gemini ToolParameterSchema (using type strings like 'STRING', 'NUMBER') into
 * a JSON Schema object suitable for MCP inputSchema.
 */
function toJsonSchema(schema: ToolParameterSchema): Record<string, unknown> {
    const typeMap: Record<string, string> = {
        STRING: 'string',
        NUMBER: 'number',
        BOOLEAN: 'boolean',
        OBJECT: 'object',
        ARRAY: 'array'
    };

    const jsonType = typeMap[schema.type] ?? 'string';
    const result: Record<string, unknown> = { type: jsonType };

    if (schema.description) {
        result.description = schema.description;
    }

    if (schema.enum) {
        result.enum = schema.enum;
    }

    if (jsonType === 'object' && schema.properties) {
        result.properties = Object.fromEntries(
            Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)])
        );
        if (schema.required && schema.required.length > 0) {
            result.required = schema.required;
        }
    }

    if (jsonType === 'array' && schema.items) {
        result.items = toJsonSchema(schema.items);
    }

    return result;
}

/**
 * Converts a ToolDeclaration into an MCP Tool definition.
 */
function toMcpTool(decl: ToolDeclaration): Tool {
    const inputSchema: Record<string, unknown> = { type: 'object' };

    if (decl.parameters?.properties) {
        inputSchema.properties = Object.fromEntries(
            Object.entries(decl.parameters.properties).map(([k, v]) => [k, toJsonSchema(v)])
        );
        if (decl.parameters.required && decl.parameters.required.length > 0) {
            inputSchema.required = decl.parameters.required;
        }
    }

    return {
        name: decl.name,
        description: decl.description,
        inputSchema: inputSchema as Tool['inputSchema']
    };
}

// ============================================================================
// MCP Tool context
// ============================================================================

/**
 * Builds the ToolContext for MCP-dispatched tools. MCP calls have no Gemini session, so the IDE services (sandbox,
 * LSP, context graph, browser proxy, lenses) are absent: calling any of them throws a clear error instead of
 * answering with a fake success (an exit-0 command, no diagnostics, an empty page).
 */
export function buildMcpToolContext(workspaceRoot: string): ToolContext {
    const noop = () => { /* progress has no listener over MCP */ };
    const unavailable = (service: string) => new Proxy({}, {
        get: (_t, prop) => {
            if (prop === 'then') return undefined; // not a Promise
            if (prop === 'workspaceRoot') return workspaceRoot;
            return (..._args: unknown[]) => {
                throw new Error(`Scratchbox MCP: ${service}.${String(prop)} is not available over MCP; it requires the IDE to be running`);
            };
        }
    });
    return {
        workspaceRoot,
        request: {} as ToolContext['request'],
        sandbox: unavailable('sandbox') as ToolContext['sandbox'],
        lsp: unavailable('lsp') as ToolContext['lsp'],
        contextGraph: unavailable('contextGraph') as ToolContext['contextGraph'],
        browserProxy: unavailable('browserProxy') as ToolContext['browserProxy'],
        lens: unavailable('lens') as ToolContext['lens'],
        reportProgress: noop,
    };
}

// ============================================================================
// ScratchboxMcpServer
// ============================================================================

export interface ScratchboxMcpServerOptions {
    /** Absolute path to the workspace root used for ToolContext stubs. */
    workspaceRoot?: string;
    /**
     * Allowlist of tool names to expose. If omitted, all registered tools are exposed.
     * Pass an explicit list to restrict which tools are available via MCP.
     */
    allowedTools?: string[];
}

export class ScratchboxMcpServer {
    private server: Server;
    private declarations: ToolDeclaration[];
    private handlers: Record<string, ToolHandler>;
    private workspaceRoot: string;
    private allowedTools: Set<string> | null;

    constructor(
        declarations: ToolDeclaration[],
        handlers: Record<string, ToolHandler>,
        options: ScratchboxMcpServerOptions = {}
    ) {
        this.declarations = declarations;
        this.handlers = handlers;
        this.workspaceRoot = options.workspaceRoot ?? process.cwd();
        this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;

        this.server = new Server(
            { name: 'scratchbox-ide', version: '1.0.0' },
            { capabilities: { tools: {} } }
        );

        this.registerHandlers();
    }

    /** Returns the underlying Server for advanced use (e.g. adding custom handlers). */
    get rawServer(): Server {
        return this.server;
    }

    /** Connect this server to the given transport and begin serving. */
    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    /** Gracefully close the transport. */
    async close(): Promise<void> {
        await this.server.close();
    }

    private effectiveDeclarations(): ToolDeclaration[] {
        if (!this.allowedTools) return this.declarations;
        return this.declarations.filter(d => this.allowedTools!.has(d.name));
    }

    private registerHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: this.effectiveDeclarations().map(toMcpTool)
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args = {} } = request.params;

            const decl = this.effectiveDeclarations().find(d => d.name === name);
            if (!decl) {
                const result: CallToolResult = {
                    content: [{
                        type: 'text',
                        text: `Unknown tool: ${name}`
                    }],
                    isError: true
                };
                return result;
            }

            const handler = this.handlers[name];
            if (!handler) {
                const result: CallToolResult = {
                    content: [{
                        type: 'text',
                        text: `Tool '${name}' has no registered handler`
                    }],
                    isError: true
                };
                return result;
            }

            const ctx = buildMcpToolContext(this.workspaceRoot);

            try {
                const outcome = await handler(args as Record<string, unknown>, ctx);
                const isError = outcome.status === 'failed';
                const payload = outcome.resultPayload ?? {};
                const result: CallToolResult = {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(payload, null, 2)
                    }],
                    isError
                };
                return result;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                const result: CallToolResult = {
                    content: [{
                        type: 'text',
                        text: `Tool execution error: ${msg}`
                    }],
                    isError: true
                };
                return result;
            }
        });
    }
}

// ============================================================================
// Convenience factory: expose the full VFX tool subset via MCP
// ============================================================================

/**
 * Creates a ScratchboxMcpServer pre-loaded with the provided declarations and handlers.
 * Intended for use by scratchbox-mcp.ts where the caller supplies the tool set.
 *
 * Usage (in scratchbox-mcp.ts or any server entry point):
 *   import { VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers } from '../gemini/tools/vfx-video-tools';
 *   const server = createVfxMcpServer(VFX_VIDEO_TOOL_DECLARATIONS, vfxVideoHandlers, { workspaceRoot });
 */
export function createVfxMcpServer(
    declarations: ToolDeclaration[],
    handlers: Record<string, ToolHandler>,
    options: ScratchboxMcpServerOptions = {}
): ScratchboxMcpServer {
    return new ScratchboxMcpServer(declarations, handlers, options);
}

/**
 * Claude Desktop claude_desktop_config.json snippet to connect to this server via stdio:
 *
 * {
 *   "mcpServers": {
 *     "scratchbox": {
 *       "command": "node",
 *       "args": ["<repo>/packages/core/dist/node/mcp/scratchbox-mcp.js"]
 *     }
 *   }
 * }
 *
 * Claude Code .claude/mcp.json snippet:
 *
 * {
 *   "scratchbox": {
 *     "type": "stdio",
 *     "command": "node",
 *     "args": ["<repo>/packages/core/dist/node/mcp/scratchbox-mcp.js"]
 *   }
 * }
 */
export const SCRATCHBOX_MCP_CONFIG_EXAMPLE = {
    scratchbox: {
        type: 'stdio',
        command: 'node',
        args: ['<repo>/packages/core/dist/node/mcp/scratchbox-mcp.js']
    }
} as const;
