/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as path from 'path';
import type { GeminiGenerateRequest } from '../../common/gemini-protocol';
import type { SymbolKind } from '../../common/context-graph-protocol';
import type { McpExecutionState } from '../../browser/generative-canvas/canvas-types';
import type { ContainerSandboxService } from '../container-sandbox-service';
import type { LspDiagnosticFeedbackService } from '../lsp-diagnostic-feedback-service';
import type { ProjectContextGraphService } from '../project-context-graph-service';
import type { BrowserProxyService } from '../browser-proxy-service';
import type { LensBridge, LensContext, LensSourceContent, LensSyncMode } from './lens-bridge';
import { errorMessage } from './gemini-client';

// ----------------------------------------------------------------------
// Declaration & call shapes (Vertex AI function-calling JSON)
// ----------------------------------------------------------------------

export type ToolParameterType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';

export interface ToolParameterSchema {
    type: ToolParameterType;
    description?: string;
    properties?: Record<string, ToolParameterSchema>;
    required?: string[];
    items?: ToolParameterSchema;
}

export interface ToolDeclaration {
    name: string;
    description: string;
    parameters?: ToolParameterSchema;
}

export interface GeminiFunctionCall {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
}

export type GeminiToolConfig =
    | { googleSearch: Record<string, never> }
    | { codeExecution: Record<string, never> }
    | { functionDeclarations: ToolDeclaration[] };

export type ToolGroup = 'workspace' | 'lens' | 'browser' | 'mcp';

export type ToolResultPayload = Record<string, unknown>;

export interface ToolExecutionResult {
    exec: McpExecutionState;
    resultPayload: ToolResultPayload;
}

/** What a handler returns; the registry wraps it into `McpExecutionState` telemetry. */
export interface ToolHandlerOutcome {
    resultPayload: ToolResultPayload;
    status?: 'completed' | 'failed';
    summaryResult?: string;
}

/** Services a tool handler may need. Passed explicitly instead of reaching into `GeminiService`. */
export interface ToolContext {
    request: GeminiGenerateRequest;
    workspaceRoot: string;
    sandbox: ContainerSandboxService;
    lsp: LspDiagnosticFeedbackService;
    contextGraph: ProjectContextGraphService;
    browserProxy: BrowserProxyService;
    lens: LensBridge;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolHandlerOutcome> | ToolHandlerOutcome;

export type ToolFallbackHandler = (call: GeminiFunctionCall, ctx: ToolContext) => Promise<ToolExecutionResult> | ToolExecutionResult;

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

const GROUPS: Record<Exclude<ToolGroup, 'mcp'>, GroupPresentation> = {
    workspace: {
        prefix: 'workspace_',
        mcpServerId: 'mcp-scratchbox-workspace',
        mcpName: 'Scratchbox Workspace',
        humanTitle: name => `Workspace Action: ${name}`,
        cardTitle: name => `Workspace: ${name}`,
        stepTitle: name => `Invoke ${name}`,
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
    }
};

export function inferToolGroup(name: string): ToolGroup {
    for (const [group, presentation] of Object.entries(GROUPS) as Array<[Exclude<ToolGroup, 'mcp'>, GroupPresentation]>) {
        if (name.startsWith(presentation.prefix)) return group;
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
        const group = registration.group === 'mcp' ? 'workspace' : registration.group;
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

    private wrap(group: Exclude<ToolGroup, 'mcp'>, name: string, outcome: ToolHandlerOutcome): ToolExecutionResult {
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
        request.enableWorkspaceTools === true || !!request.agent ||
        !!(request.prompt && /workspace|file|edit|patch|sandbox|compile|diagnostic|symbol/i.test(request.prompt))
    );

    const groups: ToolGroup[] = [];
    if (isWorkspaceNeeded) groups.push('workspace');
    if (isLensNeeded) groups.push('lens');
    if (isBrowserNeeded) groups.push('browser');

    const allFunctionDeclarations: ToolDeclaration[] = [
        ...(groups.length > 0 ? registry.declarations(groups) : []),
        ...mcpDeclarations
    ];

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

// ----------------------------------------------------------------------
// Built-in tool declarations
// ----------------------------------------------------------------------

const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo'];

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const resolveInRoot = (root: string, rel: string): string => (path.isAbsolute(rel) ? rel : path.join(root, rel));

export const WORKSPACE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'workspace_read_file',
        description: 'Read the contents of a file in the workspace. Supports reading specific line ranges.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Relative or absolute file path to read' },
                startLine: { type: 'NUMBER', description: 'Optional 1-based start line' },
                endLine: { type: 'NUMBER', description: 'Optional 1-based end line' }
            },
            required: ['filePath']
        }
    },
    {
        name: 'workspace_write_file',
        description: 'Create or overwrite a file in the workspace with complete content.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Relative or absolute file path to write' },
                content: { type: 'STRING', description: 'File content to write' }
            },
            required: ['filePath', 'content']
        }
    },
    {
        name: 'workspace_apply_diff',
        description: 'Replace an exact target block of text within a file with replacement text.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Relative or absolute file path to edit' },
                targetContent: { type: 'STRING', description: 'The exact string/block to replace in the file' },
                replacementContent: { type: 'STRING', description: 'The replacement string/block' }
            },
            required: ['filePath', 'targetContent', 'replacementContent']
        }
    },
    {
        name: 'workspace_list_directory',
        description: 'List files and directories in a workspace directory.',
        parameters: {
            type: 'OBJECT',
            properties: {
                directoryPath: { type: 'STRING', description: 'Directory path relative to workspace or absolute. Defaults to root if omitted.' },
                recursive: { type: 'BOOLEAN', description: 'Whether to recursively list directory contents' },
                maxDepth: { type: 'NUMBER', description: 'Maximum depth when listing recursively (default: 3)' }
            }
        }
    },
    {
        name: 'workspace_search',
        description: 'Search for text or regex patterns across files in the workspace.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: { type: 'STRING', description: 'Text or regex search query' },
                filePattern: { type: 'STRING', description: 'Optional file extension or pattern filter (e.g. "*.ts", "src/**/*.tsx")' }
            },
            required: ['query']
        }
    },
    {
        name: 'workspace_run_command',
        description: 'Execute a terminal or build command in the workspace safely inside the sandbox.',
        parameters: {
            type: 'OBJECT',
            properties: {
                command: { type: 'STRING', description: 'Shell command line to execute' },
                cwd: { type: 'STRING', description: 'Optional working directory' },
                timeoutMs: { type: 'NUMBER', description: 'Execution timeout in milliseconds (default: 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'workspace_get_diagnostics',
        description: 'Fetch compiler and linter diagnostics for the workspace or a specific file.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Optional file path to filter diagnostics for' }
            }
        }
    },
    {
        name: 'workspace_find_symbols',
        description: 'Find symbol definitions, usages, and references in the workspace AST context graph.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: { type: 'STRING', description: 'Symbol name to search for' },
                kind: { type: 'STRING', description: 'Optional symbol kind (e.g. "function", "class", "interface")' }
            },
            required: ['query']
        }
    }
];

export const LENS_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'lens_project',
        description: 'Project disk files or codebase paths into an interactive visual primitive canvas artifact with bidirectional synchronization.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'The primary disk file or workspace directory path to project (e.g. docs/spec.md, src/App.tsx, ROADMAP.md, workflows/deploy.workflow.json, scenes/world.scene.json, analytics.csv, session.browser.json)' },
                options: {
                    type: 'OBJECT',
                    description: 'Optional projection options including syncMode, targetSubdirectory, and context metadata'
                }
            },
            required: ['filePath']
        }
    },
    {
        name: 'lens_unproject',
        description: 'Unproject modified visual canvas primitive data back into exact, AST/syntax-preserving disk files.',
        parameters: {
            type: 'OBJECT',
            properties: {
                artifactId: { type: 'STRING', description: 'The unique artifact ID to unproject back to disk files' },
                diskContent: { type: 'STRING', description: 'Optional baseline disk content string or file map JSON' }
            },
            required: ['artifactId']
        }
    },
    {
        name: 'lens_list_bindings',
        description: 'List all active file-to-artifact codebase lens bindings and their live synchronization statuses (synced, dirty-ui, dirty-disk).',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'lens_sync',
        description: 'Force bidirectional synchronization between disk files and the visual primitive canvas artifact in either direction.',
        parameters: {
            type: 'OBJECT',
            properties: {
                artifactId: { type: 'STRING', description: 'The unique artifact ID of the binding to synchronize' },
                direction: { type: 'STRING', description: 'Synchronization direction: "in" (disk -> visual UI) or "out" (visual UI -> disk)' }
            },
            required: ['artifactId', 'direction']
        }
    }
];

export const BROWSER_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'browser_navigate',
        description: 'Navigate the active canvas web browser to a specified URL.',
        parameters: {
            type: 'OBJECT',
            properties: {
                url: { type: 'STRING', description: 'The target absolute HTTP/HTTPS URL' }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_snapshot',
        description: 'Get the compact accessibility tree and indexed element IDs of the active web page.',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'browser_extract_content',
        description: 'Extract the full active web page content converted into clean, readable Markdown.',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'browser_click',
        description: 'Perform a mouse click on an interactive element by its numerical data-sb-id or selector.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elementId: { type: 'STRING', description: 'The data-sb-id of the element to click (obtained from browser_snapshot)' },
                selector: { type: 'STRING', description: 'Optional CSS selector of the element' }
            },
            required: ['elementId']
        }
    },
    {
        name: 'browser_type',
        description: 'Type or fill text into an input or textarea element by its numerical data-sb-id.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elementId: { type: 'STRING', description: 'The data-sb-id of the input/textarea element to fill' },
                text: { type: 'STRING', description: 'The text value to type/fill' }
            },
            required: ['elementId', 'text']
        }
    },
    {
        name: 'browser_evaluate',
        description: 'Execute a custom JavaScript expression within the active page context.',
        parameters: {
            type: 'OBJECT',
            properties: {
                expression: { type: 'STRING', description: 'The JavaScript expression to evaluate' }
            },
            required: ['expression']
        }
    }
];

// ----------------------------------------------------------------------
// Built-in tool handlers
// ----------------------------------------------------------------------

const workspaceHandlers: Record<string, ToolHandler> = {
    async workspace_read_file(args, ctx) {
        const relPath = asString(args.filePath);
        const fullPath = resolveInRoot(ctx.workspaceRoot, relPath);
        if (!await fs.pathExists(fullPath)) {
            throw new Error(`File not found: ${relPath}`);
        }
        const rawContent = await fs.readFile(fullPath, 'utf-8');
        const lines = rawContent.split('\n');
        const totalLines = lines.length;
        const startArg = asNumber(args.startLine);
        const endArg = asNumber(args.endLine);
        const startLine = startArg !== undefined ? Math.max(1, startArg) : 1;
        const endLine = endArg !== undefined ? Math.min(totalLines, endArg) : totalLines;
        const selectedContent = (args.startLine !== undefined || args.endLine !== undefined)
            ? lines.slice(startLine - 1, endLine).join('\n')
            : rawContent;

        return {
            resultPayload: { status: 'success', filePath: relPath, totalLines, startLine, endLine, content: selectedContent },
            summaryResult: `Read ${relPath} (lines ${startLine}-${endLine} of ${totalLines}).`
        };
    },

    async workspace_write_file(args, ctx) {
        const relPath = asString(args.filePath);
        const fullPath = resolveInRoot(ctx.workspaceRoot, relPath);
        const content = args.content !== undefined ? String(args.content) : '';
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content, 'utf-8');
        const bytesWritten = Buffer.byteLength(content, 'utf-8');
        return {
            resultPayload: { status: 'success', filePath: relPath, bytesWritten },
            summaryResult: `Wrote ${bytesWritten} bytes to ${relPath}.`
        };
    },

    async workspace_apply_diff(args, ctx) {
        const relPath = asString(args.filePath);
        const fullPath = resolveInRoot(ctx.workspaceRoot, relPath);
        if (!await fs.pathExists(fullPath)) {
            throw new Error(`File not found: ${relPath}`);
        }
        const current = await fs.readFile(fullPath, 'utf-8');
        const target = args.targetContent;
        const replacement = args.replacementContent !== undefined ? String(args.replacementContent) : '';

        if (typeof target !== 'string' || !current.includes(target)) {
            throw new Error(`Target content block was not found in ${relPath}.`);
        }

        await fs.writeFile(fullPath, current.replace(target, replacement), 'utf-8');
        return {
            resultPayload: { status: 'success', filePath: relPath, message: 'Successfully applied diff patch.' },
            summaryResult: `Applied diff patch to ${relPath}.`
        };
    },

    async workspace_list_directory(args, ctx) {
        const root = ctx.workspaceRoot;
        const relDir = asString(args.directoryPath);
        const targetDir = resolveInRoot(root, relDir);
        if (!await fs.pathExists(targetDir)) {
            throw new Error(`Directory not found: ${relDir}`);
        }

        const maxDepth = Math.min(asNumber(args.maxDepth) || 3, 5);
        const recursive = !!args.recursive;
        const results: Array<{ path: string; type: 'file' | 'directory'; size?: number }> = [];

        const scan = async (currentDir: string, currentDepth: number): Promise<void> => {
            if (currentDepth > maxDepth || results.length >= 200) return;
            const entries = await fs.readdir(currentDir);
            for (const entry of entries) {
                if (results.length >= 200) break;
                if (IGNORED_DIRS.includes(entry)) continue;
                const full = path.join(currentDir, entry);
                const rel = path.relative(root, full).replace(/\\/g, '/');
                const stat = await fs.stat(full);
                if (stat.isDirectory()) {
                    results.push({ path: rel, type: 'directory' });
                    if (recursive) {
                        await scan(full, currentDepth + 1);
                    }
                } else {
                    results.push({ path: rel, type: 'file', size: stat.size });
                }
            }
        };

        await scan(targetDir, 1);
        return {
            resultPayload: { status: 'success', directory: relDir || '.', entriesCount: results.length, entries: results },
            summaryResult: `Listed ${results.length} items in ${relDir || '.'}.`
        };
    },

    async workspace_search(args, ctx) {
        const root = ctx.workspaceRoot;
        const query = asString(args.query);
        if (!query) throw new Error('Search query is required.');
        const filePattern = asString(args.filePattern);
        const fileFilter = filePattern ? new RegExp(filePattern.replace(/\*/g, '.*')) : null;
        const matches: Array<{ file: string; line: number; content: string }> = [];

        const walkSearch = async (dir: string): Promise<void> => {
            if (matches.length >= 50) return;
            const entries = await fs.readdir(dir);
            for (const entry of entries) {
                if (matches.length >= 50) break;
                if (IGNORED_DIRS.includes(entry)) continue;
                const full = path.join(dir, entry);
                const stat = await fs.stat(full);
                if (stat.isDirectory()) {
                    await walkSearch(full);
                } else if (stat.isFile()) {
                    const rel = path.relative(root, full).replace(/\\/g, '/');
                    if (fileFilter && !fileFilter.test(rel)) continue;
                    try {
                        const text = await fs.readFile(full, 'utf-8');
                        if (text.includes(query)) {
                            const lines = text.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(query)) {
                                    matches.push({ file: rel, line: i + 1, content: lines[i].trim() });
                                    if (matches.length >= 50) break;
                                }
                            }
                        }
                    } catch {
                        // Skip unreadable/binary files
                    }
                }
            }
        };

        await walkSearch(root);
        return {
            resultPayload: { status: 'success', query, matchesCount: matches.length, matches },
            summaryResult: `Found ${matches.length} matches for "${query}".`
        };
    },

    async workspace_run_command(args, ctx) {
        const root = ctx.workspaceRoot;
        const cmd = asString(args.command);
        if (!cmd) throw new Error('command is required.');
        const timeoutMs = asNumber(args.timeoutMs) || 30000;
        const cwdArg = asString(args.cwd);
        const envId = `ws-run-${Date.now()}`;
        await ctx.sandbox.createEnvironment({
            environmentId: envId,
            isolationLevel: 'process-jail',
            workspaceRoot: root,
            timeoutMs
        });

        const res = await ctx.sandbox.executeCommand(envId, {
            command: cmd,
            cwd: cwdArg ? resolveInRoot(root, cwdArg) : root,
            timeoutMs
        });

        return {
            resultPayload: {
                status: res.exitCode === 0 ? 'success' : 'failed',
                exitCode: res.exitCode,
                stdout: res.stdout,
                stderr: res.stderr,
                timedOut: res.timedOut,
                durationMs: res.durationMs
            },
            status: res.exitCode === 0 ? 'completed' : 'failed',
            summaryResult: `Executed "${cmd}" (exit code ${res.exitCode}).`
        };
    },

    workspace_get_diagnostics(args, ctx) {
        const filePath = asString(args.filePath);
        if (filePath) {
            const fileDiags = ctx.lsp.getDiagnosticsForFile(filePath);
            return {
                resultPayload: {
                    status: 'success',
                    filePath,
                    totalCount: fileDiags.length,
                    errorCount: fileDiags.filter(d => d.severity === 'error').length,
                    warningCount: fileDiags.filter(d => d.severity === 'warning').length,
                    diagnostics: fileDiags
                },
                summaryResult: `File diagnostics for ${filePath}: ${fileDiags.length} issues.`
            };
        }
        const summary = ctx.lsp.getSummary();
        return {
            resultPayload: { status: 'success', ...summary },
            summaryResult: `Workspace diagnostics: ${summary.errorCount} error(s), ${summary.warningCount} warning(s).`
        };
    },

    workspace_find_symbols(args, ctx) {
        const query = asString(args.query);
        if (!query) throw new Error('query is required.');
        const kind = asString(args.kind);
        const symResult = ctx.contextGraph.retrieveSymbolGraph({
            query,
            kinds: kind ? [kind as SymbolKind] : undefined,
            minRelevanceScore: 0.1,
            maxSymbols: 25
        });
        return {
            resultPayload: {
                status: 'success',
                query,
                count: symResult.matchingSymbols.length,
                symbols: symResult.matchingSymbols.map(s => ({ name: s.name, kind: s.kind, filePath: s.filePath, range: s.range }))
            },
            summaryResult: `Found ${symResult.matchingSymbols.length} symbol(s) matching "${query}".`
        };
    }
};

const asLensSource = (value: unknown): LensSourceContent | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value as Record<string, string>;
    return undefined;
};

const lensHandlers: Record<string, ToolHandler> = {
    async lens_project(args, ctx) {
        const filePath = asString(args.filePath);
        const options = (args.options && typeof args.options === 'object')
            ? args.options as { artifactId?: string; syncMode?: LensSyncMode; context?: LensContext }
            : undefined;
        const res = await ctx.lens.executeLensProject(filePath, asLensSource(args.sourceContent), options);
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Projected ${filePath} into canvas.` : (res.error || 'Projection failed')
        };
    },

    async lens_unproject(args, ctx) {
        const artifactId = asString(args.artifactId);
        const res = await ctx.lens.executeLensUnproject(
            artifactId,
            args.primitiveData,
            asLensSource(args.currentDiskContent),
            args.context as LensContext | undefined
        );
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Unprojected ${artifactId} to disk.` : (res.error || 'Unproject failed')
        };
    },

    lens_list_bindings(_args, ctx) {
        const bindings = ctx.lens.executeLensListBindings();
        return {
            resultPayload: { success: true, bindings },
            summaryResult: `Found ${bindings.length} active lens bindings.`
        };
    },

    lens_sync(args, ctx) {
        const artifactId = asString(args.artifactId);
        const direction = args.direction === 'out' ? 'out' : 'in';
        const res = ctx.lens.executeLensSync(
            artifactId,
            direction,
            { diskContent: asLensSource(args.diskContent), primitiveData: args.primitiveData },
            args.context as LensContext | undefined
        );
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Synced ${artifactId} (${direction}).` : (res.error || 'Sync failed')
        };
    }
};

const browserOutcome = (data: unknown, name: string): ToolHandlerOutcome => ({
    resultPayload: { status: 'success', data },
    summaryResult: `Successfully executed ${name}.`
});

const browserHandlers: Record<string, ToolHandler> = {
    async browser_navigate(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('navigate', { url: asString(args.url) }), 'browser_navigate');
    },
    browser_snapshot(_args, ctx) {
        return browserOutcome(ctx.browserProxy.getActiveState(), 'browser_snapshot');
    },
    browser_extract_content(_args, ctx) {
        return browserOutcome({ markdown: ctx.browserProxy.getActiveState().markdown }, 'browser_extract_content');
    },
    async browser_click(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('click', { elementId: asString(args.elementId), selector: asString(args.selector) || undefined }), 'browser_click');
    },
    async browser_type(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('fill', { elementId: asString(args.elementId), text: asString(args.text) }), 'browser_type');
    },
    async browser_evaluate(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('evaluate', { expression: asString(args.expression) }), 'browser_evaluate');
    }
};

/** Registry pre-loaded with the workspace, lens and browser tool suites. */
export function createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const decl of WORKSPACE_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, workspaceHandlers[decl.name], 'workspace');
    }
    for (const decl of LENS_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, lensHandlers[decl.name], 'lens');
    }
    for (const decl of BROWSER_TOOL_DECLARATIONS) {
        registry.register(decl.name, decl, browserHandlers[decl.name], 'browser');
    }
    return registry;
}
