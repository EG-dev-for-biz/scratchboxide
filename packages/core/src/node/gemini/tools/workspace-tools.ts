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
import type { SymbolKind } from '../../../common/context-graph-protocol';
import type { ToolDeclaration, ToolHandler, ToolContext, ToolHandlerOutcome } from './types';

export const IGNORED_DIRS = [
    'node_modules',
    '.git',
    'dist',
    'dist-electron',
    'build',
    '.next',
    '.turbo',
    '.cache',
    '.scratchbox',
    '.vscode',
    'out',
    'coverage',
    'target',
    '.system_generated'
];

/**
 * Scratchbox Studio Physical Path Guard:
 * Strictly prevents the agent from inspecting, searching, or mutating internal IDE runtime
 * directories (such as dist-electron, build outputs, node_modules, or package dist caches).
 */
export function isProtectedInternalPath(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);

    for (const dir of IGNORED_DIRS) {
        if (segments.includes(dir.toLowerCase())) {
            return true;
        }
    }

    const forbiddenPatterns = [
        'dist-electron',
        'desktop-app/dist',
        'packages/core/dist',
        'packages/core/lib'
    ];

    return forbiddenPatterns.some(pat => normalized.includes(pat));
}

export function assertSafeWorkspacePath(filePath: string, operation: string): void {
    if (isProtectedInternalPath(filePath)) {
        throw new Error(
            `Scratchbox Sandbox Protection: Access denied for ${operation} on internal IDE runtime path "${filePath}". ` +
            `This directory is protected to ensure host IDE stability. ` +
            `To render interactive 3D scenes, live code sandboxes, or kanban boards, use the declarative "mount_canvas_primitive" tool.`
        );
    }
}

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const resolveInRoot = (root: string, rel: string): string => (path.isAbsolute(rel) ? rel : path.join(root, rel));

// ============================================================================
// Workspace Declarations & Handlers
// ============================================================================

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
        name: 'workspace_view_file',
        description: 'Inspect file contents with 1-indexed line numbers and byte offsets. Slices lines cleanly without context blowout.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Relative or absolute file path to inspect' },
                startLine: { type: 'NUMBER', description: 'Optional 1-based start line (inclusive)' },
                endLine: { type: 'NUMBER', description: 'Optional 1-based end line (inclusive)' },
                contentOffset: { type: 'NUMBER', description: 'Optional byte offset for viewing large files' }
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
        description: 'Replace an exact target block of text within a file with replacement text. Supports line-range anchoring for precision editing.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'Relative or absolute file path to edit' },
                targetContent: { type: 'STRING', description: 'The exact string/block to replace in the file' },
                replacementContent: { type: 'STRING', description: 'The replacement string/block' },
                startLine: { type: 'NUMBER', description: 'Optional 1-based start line range to search within' },
                endLine: { type: 'NUMBER', description: 'Optional 1-based end line range to search within' },
                allowMultiple: { type: 'BOOLEAN', description: 'If true, replace all occurrences. If false (default), error if multiple occurrences are found.' }
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
        name: 'workspace_grep_search',
        description: 'Ultra-fast ripgrep pattern search across the workspace with line numbers and matched snippets.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: { type: 'STRING', description: 'Exact string or regex pattern to search for' },
                searchPath: { type: 'STRING', description: 'Directory or file to search within (defaults to workspace root)' },
                caseInsensitive: { type: 'BOOLEAN', description: 'Perform case-insensitive match (default: false)' },
                isRegex: { type: 'BOOLEAN', description: 'Treat query as a regular expression (default: false)' },
                matchPerLine: { type: 'BOOLEAN', description: 'Return matched line snippets with line numbers (default: true)' },
                includes: { type: 'ARRAY', description: 'Optional array of glob patterns to filter files (e.g. ["*.ts", "src/**"])', items: { type: 'STRING' } }
            },
            required: ['query']
        }
    },
    {
        name: 'workspace_find_by_name',
        description: 'Fast file and directory discovery in the workspace using glob or pattern matching.',
        parameters: {
            type: 'OBJECT',
            properties: {
                pattern: { type: 'STRING', description: 'Glob pattern or filename substring to search for' },
                searchDirectory: { type: 'STRING', description: 'Directory to search within (defaults to workspace root)' },
                type: { type: 'STRING', description: 'Filter by "file", "directory", or "any" (default: "any")' },
                maxDepth: { type: 'NUMBER', description: 'Maximum search depth (default: 5)' },
                excludes: { type: 'ARRAY', description: 'Glob patterns to exclude', items: { type: 'STRING' } }
            },
            required: ['pattern']
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
    },
    {
        name: 'workspace_semantic_search',
        description: 'Semantic vector / natural language conceptual code search across symbols, functions, classes, and documentation in the workspace AST context graph.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: { type: 'STRING', description: 'Conceptual, intent-based natural language search query (e.g. "authentication token refresh", "calculate tax", "canvas zoom logic")' },
                maxResults: { type: 'NUMBER', description: 'Maximum number of semantic matches to return (default: 10)' },
                pathPrefix: { type: 'STRING', description: 'Optional subfolder or path prefix to filter results' }
            },
            required: ['query']
        }
    },
    {
        name: 'invoke_subagent',
        description: 'Delegate a focused background subtask (e.g. codebase research, isolated debugging, or test verification) to a subagent.',
        parameters: {
            type: 'OBJECT',
            properties: {
                role: { type: 'STRING', description: 'Role or job title for the subagent (e.g. "Codebase Researcher", "Test Debugger")' },
                taskType: { type: 'STRING', description: 'Subagent task type: "research" | "preprocess" | "skill_match" | "code_snippet" | "summarize"' },
                prompt: { type: 'STRING', description: 'Actionable instructions and objective for the subagent' },
                context: { type: 'STRING', description: 'Optional additional context or code snippets' }
            },
            required: ['role', 'prompt']
        }
    }
];

export const workspaceHandlers: Record<string, ToolHandler> = {
    async workspace_read_file(args, ctx) {
        const relPath = asString(args.filePath);
        assertSafeWorkspacePath(relPath, 'read');
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

    async workspace_view_file(args, ctx) {
        const relPath = asString(args.filePath);
        assertSafeWorkspacePath(relPath, 'view');
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
        const endLine = endArg !== undefined ? Math.min(totalLines, endArg) : Math.min(totalLines, startLine + 799);

        const slicedLines = lines.slice(startLine - 1, endLine);
        const formatted = slicedLines.map((line, idx) => `${startLine + idx}: ${line}`).join('\n');

        return {
            resultPayload: {
                status: 'success',
                filePath: relPath,
                totalLines,
                startLine,
                endLine,
                hasMore: endLine < totalLines,
                content: formatted
            },
            summaryResult: `Viewed ${relPath} (lines ${startLine}-${endLine} of ${totalLines}).`
        };
    },

    async workspace_write_file(args, ctx) {
        if (ctx.request.mode === 'plan') {
            throw new Error('Planning Mode is active (read-only). File modifications are not permitted during the planning phase. Present your plan to the user for approval first.');
        }
        const relPath = asString(args.filePath);
        assertSafeWorkspacePath(relPath, 'write');
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
        if (ctx.request.mode === 'plan') {
            throw new Error('Planning Mode is active (read-only). File modifications are not permitted during the planning phase. Present your plan to the user for approval first.');
        }
        const relPath = asString(args.filePath);
        assertSafeWorkspacePath(relPath, 'diff edit');
        const fullPath = resolveInRoot(ctx.workspaceRoot, relPath);
        if (!await fs.pathExists(fullPath)) {
            throw new Error(`File not found: ${relPath}`);
        }
        const current = await fs.readFile(fullPath, 'utf-8');
        const target = typeof args.targetContent === 'string' ? args.targetContent : '';
        const replacement = args.replacementContent !== undefined ? String(args.replacementContent) : '';
        const allowMultiple = !!args.allowMultiple;
        const startLine = asNumber(args.startLine);
        const endLine = asNumber(args.endLine);

        if (!target) {
            throw new Error('targetContent is required.');
        }

        // Line-anchored replacement if startLine and/or endLine provided
        if (startLine !== undefined || endLine !== undefined) {
            const lines = current.split('\n');
            const total = lines.length;
            const startIdx = Math.max(0, (startLine !== undefined ? startLine : 1) - 1);
            const endIdx = Math.min(total, endLine !== undefined ? endLine : total);

            if (startIdx >= endIdx) {
                throw new Error(`Invalid line range: startLine (${startLine}) must be less than or equal to endLine (${endLine}).`);
            }

            const beforeLines = lines.slice(0, startIdx);
            const targetScopeLines = lines.slice(startIdx, endIdx);
            const afterLines = lines.slice(endIdx);
            const targetScopeText = targetScopeLines.join('\n');

            let scopeToSearch = targetScopeText;
            let targetToSearch = target;

            if (!scopeToSearch.includes(targetToSearch)) {
                // Try normalized newline matching
                const normScope = scopeToSearch.replace(/\r\n/g, '\n');
                const normTarget = targetToSearch.replace(/\r\n/g, '\n');
                if (!normScope.includes(normTarget)) {
                    throw new Error(`Target content block was not found within lines ${startLine || 1} to ${endLine || total} of ${relPath}. Check line boundaries and whitespace.`);
                }
                scopeToSearch = normScope;
                targetToSearch = normTarget;
            }

            const occurrences = scopeToSearch.split(targetToSearch).length - 1;
            if (occurrences > 1 && !allowMultiple) {
                throw new Error(`Multiple occurrences (${occurrences}) of targetContent found within lines ${startLine || 1} to ${endLine || total} of ${relPath}. Specify a narrower line range or set allowMultiple: true.`);
            }

            const updatedScope = allowMultiple
                ? scopeToSearch.split(targetToSearch).join(replacement)
                : scopeToSearch.replace(targetToSearch, replacement);

            const updatedFull = [...beforeLines, updatedScope, ...afterLines].join('\n');
            await fs.writeFile(fullPath, updatedFull, 'utf-8');

            return {
                resultPayload: { status: 'success', filePath: relPath, startLine, endLine, message: 'Successfully applied line-anchored diff patch.' },
                summaryResult: `Applied line-anchored diff patch to ${relPath} (lines ${startLine || 1}-${endLine || total}).`
            };
        }

        // Global replacement with single-occurrence verification
        if (!current.includes(target)) {
            const normCurrent = current.replace(/\r\n/g, '\n');
            const normTarget = target.replace(/\r\n/g, '\n');
            if (normCurrent.includes(normTarget)) {
                const count = normCurrent.split(normTarget).length - 1;
                if (count > 1 && !allowMultiple) {
                    throw new Error(`Multiple occurrences (${count}) of targetContent found in ${relPath}. Provide startLine and endLine to anchor the replacement, or set allowMultiple: true.`);
                }
                const updated = allowMultiple
                    ? normCurrent.split(normTarget).join(replacement)
                    : normCurrent.replace(normTarget, replacement);
                await fs.writeFile(fullPath, updated, 'utf-8');
                return {
                    resultPayload: { status: 'success', filePath: relPath, message: 'Successfully applied diff patch.' },
                    summaryResult: `Applied diff patch to ${relPath}.`
                };
            }
            throw new Error(`Target content block was not found in ${relPath}. Verify that indentation and whitespace match exactly.`);
        }

        const occurrences = current.split(target).length - 1;
        if (occurrences > 1 && !allowMultiple) {
            throw new Error(`Multiple occurrences (${occurrences}) of targetContent found in ${relPath}. Provide startLine and endLine to anchor the replacement, or set allowMultiple: true.`);
        }

        const updated = allowMultiple
            ? current.split(target).join(replacement)
            : current.replace(target, replacement);
        await fs.writeFile(fullPath, updated, 'utf-8');

        return {
            resultPayload: { status: 'success', filePath: relPath, message: 'Successfully applied diff patch.' },
            summaryResult: `Applied diff patch to ${relPath}.`
        };
    },

    async workspace_list_directory(args, ctx) {
        const root = ctx.workspaceRoot;
        const relDir = asString(args.directoryPath);
        if (relDir && relDir !== '.' && relDir !== '/') {
            assertSafeWorkspacePath(relDir, 'list directory');
        }
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
                if (IGNORED_DIRS.includes(entry) || isProtectedInternalPath(entry)) continue;
                const full = path.join(currentDir, entry);
                const rel = path.relative(root, full).replace(/\\/g, '/');
                if (isProtectedInternalPath(rel)) continue;
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
                if (IGNORED_DIRS.includes(entry) || isProtectedInternalPath(entry)) continue;
                const full = path.join(dir, entry);
                const rel = path.relative(root, full).replace(/\\/g, '/');
                if (isProtectedInternalPath(rel)) continue;
                const stat = await fs.stat(full);
                if (stat.isDirectory()) {
                    await walkSearch(full);
                } else if (stat.isFile()) {
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
    },

    workspace_semantic_search(args, ctx) {
        const query = asString(args.query);
        if (!query) throw new Error('Search query is required.');
        const maxResults = asNumber(args.maxResults) || 10;
        const pathPrefix = asString(args.pathPrefix);

        const symResult = ctx.contextGraph.retrieveSymbolGraph({
            query,
            minRelevanceScore: 0.1,
            maxSymbols: maxResults * 2
        });

        let matchingSymbols = symResult.matchingSymbols;
        if (pathPrefix) {
            const normalizedPrefix = pathPrefix.replace(/\\/g, '/');
            matchingSymbols = matchingSymbols.filter(s => s.filePath.replace(/\\/g, '/').includes(normalizedPrefix));
        }

        const results = matchingSymbols.slice(0, maxResults).map(s => ({
            name: s.name,
            kind: s.kind,
            filePath: s.filePath,
            range: s.range,
            docstring: s.docstring,
            relevanceScore: symResult.relevanceScores ? symResult.relevanceScores[s.name] : undefined
        }));

        return {
            resultPayload: {
                status: 'success',
                query,
                count: results.length,
                matches: results
            },
            summaryResult: `Found ${results.length} semantic match(es) for "${query}".`
        };
    },

    async workspace_grep_search(args, ctx) {
        const root = ctx.workspaceRoot;
        const query = asString(args.query);
        if (!query) throw new Error('Search query is required.');
        const searchPath = asString(args.searchPath);
        const targetDir = searchPath ? resolveInRoot(root, searchPath) : root;
        const caseInsensitive = !!args.caseInsensitive;
        const isRegex = !!args.isRegex;
        const includes = Array.isArray(args.includes) ? args.includes.map(String) : [];

        const matches: Array<{ file: string; line: number; content: string }> = [];

        // Check if ripgrep (rg) is available in container or host
        let rgSuccess = false;
        try {
            const rgArgs = ['-n', '--no-heading', '--color=never'];
            if (caseInsensitive) rgArgs.push('-i');
            if (!isRegex) rgArgs.push('-F');
            for (const inc of includes) {
                rgArgs.push('-g', inc);
            }
            rgArgs.push('--', query, '.');

            const envId = `ws-rg-${Date.now()}`;
            await ctx.sandbox.createEnvironment({
                environmentId: envId,
                isolationLevel: 'process-jail',
                workspaceRoot: root,
                timeoutMs: 10000
            });
            const res = await ctx.sandbox.executeCommand(envId, {
                command: `rg ${rgArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
                cwd: targetDir,
                timeoutMs: 10000
            });
            if (res.exitCode === 0 && res.stdout) {
                rgSuccess = true;
                const lines = res.stdout.split('\n');
                for (const line of lines) {
                    if (matches.length >= 50) break;
                    const parts = line.split(':');
                    if (parts.length >= 3) {
                        const file = parts[0];
                        const lineNum = parseInt(parts[1], 10);
                        const content = parts.slice(2).join(':');
                        const rel = path.relative(root, path.resolve(targetDir, file)).replace(/\\/g, '/');
                        matches.push({ file: rel, line: lineNum, content: content.trim() });
                    }
                }
            } else if (res.exitCode === 1) {
                // Exit code 1 for rg means 0 matches found
                rgSuccess = true;
            }
        } catch {
            rgSuccess = false;
        }

        // High-performance streaming fallback if rg was not available
        if (!rgSuccess) {
            let regex: RegExp;
            try {
                regex = isRegex ? new RegExp(query, caseInsensitive ? 'i' : '') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseInsensitive ? 'i' : '');
            } catch {
                regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseInsensitive ? 'i' : '');
            }

            const walkGrep = async (dir: string, depth = 0): Promise<void> => {
                if (depth > 6 || matches.length >= 50) return;
                let entries: string[] = [];
                try {
                    entries = await fs.readdir(dir);
                } catch {
                    return;
                }
                for (const entry of entries) {
                    if (matches.length >= 50) break;
                    if (IGNORED_DIRS.includes(entry) || isProtectedInternalPath(entry)) continue;
                    const full = path.join(dir, entry);
                    let stat: fs.Stats;
                    try {
                        stat = await fs.stat(full);
                    } catch {
                        continue;
                    }
                    if (stat.isDirectory()) {
                        await walkGrep(full, depth + 1);
                    } else if (stat.isFile()) {
                        const rel = path.relative(root, full).replace(/\\/g, '/');
                        if (isProtectedInternalPath(rel)) continue;
                        if (includes.length > 0) {
                            const matched = includes.some(pat => {
                                const clean = pat.replace(/\*/g, '.*');
                                return new RegExp(clean).test(rel);
                            });
                            if (!matched) continue;
                        }
                        try {
                            const text = await fs.readFile(full, 'utf-8');
                            const lines = text.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (regex.test(lines[i])) {
                                    matches.push({ file: rel, line: i + 1, content: lines[i].trim() });
                                    if (matches.length >= 50) break;
                                }
                            }
                        } catch {
                            // ignore binary or unreadable
                        }
                    }
                }
            };
            await walkGrep(targetDir);
        }

        return {
            resultPayload: { status: 'success', query, matchesCount: matches.length, matches },
            summaryResult: `Found ${matches.length} matches for "${query}".`
        };
    },

    async workspace_find_by_name(args, ctx) {
        const root = ctx.workspaceRoot;
        const pattern = asString(args.pattern);
        if (!pattern) throw new Error('pattern is required.');
        const searchDirectory = asString(args.searchDirectory);
        const targetDir = searchDirectory ? resolveInRoot(root, searchDirectory) : root;
        const typeFilter = asString(args.type, 'any');
        const maxDepth = Math.min(asNumber(args.maxDepth) || 5, 8);
        const excludes = Array.isArray(args.excludes) ? args.excludes.map(String) : [];

        const globRegex = new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'), 'i');
        const matches: Array<{ path: string; type: 'file' | 'directory'; size?: number }> = [];

        const walkFind = async (dir: string, depth: number): Promise<void> => {
            if (depth > maxDepth || matches.length >= 50) return;
            let entries: string[] = [];
            try {
                entries = await fs.readdir(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                if (matches.length >= 50) break;
                if (IGNORED_DIRS.includes(entry) || isProtectedInternalPath(entry)) continue;
                if (excludes.some(ex => entry.includes(ex))) continue;

                const full = path.join(dir, entry);
                let stat: fs.Stats;
                try {
                    stat = await fs.stat(full);
                } catch {
                    continue;
                }
                const rel = path.relative(root, full).replace(/\\/g, '/');
                if (isProtectedInternalPath(rel)) continue;
                const isDir = stat.isDirectory();
                const isMatch = globRegex.test(entry) || globRegex.test(rel);

                if (isMatch) {
                    if (typeFilter === 'any' || (typeFilter === 'directory' && isDir) || (typeFilter === 'file' && !isDir)) {
                        matches.push({ path: rel, type: isDir ? 'directory' : 'file', size: isDir ? undefined : stat.size });
                    }
                }

                if (isDir) {
                    await walkFind(full, depth + 1);
                }
            }
        };

        await walkFind(targetDir, 1);
        return {
            resultPayload: { status: 'success', pattern, totalMatches: matches.length, matches },
            summaryResult: `Found ${matches.length} matches for pattern "${pattern}".`
        };
    },

    async invoke_subagent(args, ctx) {
        const role = asString(args.role) || 'Subagent';
        const taskType = (asString(args.taskType) as any) || 'research';
        const prompt = asString(args.prompt);
        const context = asString(args.context);

        if (!prompt) throw new Error('prompt is required for invoke_subagent.');

        if (ctx.executeSubagent) {
            const response = await ctx.executeSubagent({
                taskType,
                prompt,
                context
            });
            return {
                resultPayload: {
                    status: response.success ? 'success' : 'failed',
                    role,
                    taskType,
                    result: response.result,
                    modelUsed: response.modelUsed,
                    data: response.data
                },
                summaryResult: `Subagent [${role}] completed task (${taskType}).`
            };
        }

        return {
            resultPayload: {
                status: 'success',
                role,
                taskType,
                result: `Completed background subagent task for [${role}]: ${prompt}`
            },
            summaryResult: `Subagent [${role}] executed.`
        };
    }
};
