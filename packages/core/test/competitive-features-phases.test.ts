import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    parseContextMentions,
    resolveContextMentionQuery,
    CONTEXT_MENTION_TAGS
} from '../src/browser/generative-canvas/context-mention-engine';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import {
    generateMultiFileDiff,
    applyMultiFilePatch,
    MultiFilePatch,
    FileDiffEntry
} from '../src/browser/generative-canvas/multi-file-diff-engine';
import {
    extractStackTraceAndDiagnostics,
    synthesizeTerminalDebugPrompt,
    TerminalExecutionError
} from '../src/browser/generative-canvas/terminal-debug-bridge';
import { CodeFileTab, McpServerItem } from '../src/browser/generative-canvas/canvas-types';

async function runCompetitiveFeaturesPhasesTestSuite() {
    console.log('🧪 Running Competitive Features (Phase 1 & Phase 2) Comprehensive Test Suite...');

    // =========================================================================
    // SECTION 1: Phase 1 - Extended `@` Context Mention Engine
    // =========================================================================
    console.log('\n--- Phase 1.1: Extended @ Context Mention Engine ---');

    // Test 1.1.1: Mention tags exist for all required targets (@file, @folder, @git, @terminal, @web, @docs, @mcp)
    const expectedTags = ['file', 'files', 'folder', 'git', 'terminal', 'web', 'docs', 'mcp'];
    for (const tag of expectedTags) {
        assert.ok(
            CONTEXT_MENTION_TAGS.includes(tag as any),
            `Expected CONTEXT_MENTION_TAGS to include "${tag}"`
        );
    }
    console.log('  ✓ Test 1 Passed: CONTEXT_MENTION_TAGS includes all required @ tags (@file, @folder, @git, @terminal, @web, @docs, @mcp)');

    // Test 1.1.2: Parse prompt with multiple @ mentions
    const samplePrompt = 'Please inspect @file:App.tsx and check @git status alongside @terminal errors before querying @web:apple-hig';
    const parsed = parseContextMentions(samplePrompt);
    assert.strictEqual(parsed.mentions.length, 4, 'Should parse 4 distinct @ mentions');
    assert.strictEqual(parsed.mentions[0].type, 'file');
    assert.strictEqual(parsed.mentions[0].query, 'App.tsx');
    assert.strictEqual(parsed.mentions[1].type, 'git');
    assert.strictEqual(parsed.mentions[2].type, 'terminal');
    assert.strictEqual(parsed.mentions[3].type, 'web');
    assert.strictEqual(parsed.mentions[3].query, 'apple-hig');
    assert.ok(parsed.cleanPrompt.length > 0, 'Clean prompt should be generated');
    console.log('  ✓ Test 2 Passed: parseContextMentions correctly parses multi-target @ tags and queries');

    // Test 1.1.3: Real-time search query resolution across workspace files, git status, and MCP tools
    const mockFiles = [
        'src/App.tsx',
        'src/components/MetricCard.tsx',
        'src/components/KanbanBoard.tsx',
        'docs/ARCH_SPEC.md',
        'package.json'
    ];
    const mockGitStatus = {
        branch: 'feature/competitive-phases',
        modified: ['src/App.tsx', 'package.json'],
        staged: ['docs/ARCH_SPEC.md'],
        untracked: ['src/components/KanbanBoard.tsx']
    };
    const mockMcpServers: McpServerItem[] = [
        {
            id: 'mcp-stripe',
            name: 'Stripe Payments',
            tagline: 'Live balances and checkout',
            category: 'Payments',
            status: 'connected',
            toolsCount: 3,
            isEnabled: true,
            accentColor: 'indigo',
            tools: []
        }
    ];

    const fileResults = resolveContextMentionQuery('file', 'App', mockFiles, mockGitStatus, mockMcpServers);
    assert.ok(fileResults.length >= 1, 'Should resolve matching file for query "App"');
    assert.strictEqual(fileResults[0].name, 'App.tsx');
    assert.strictEqual(fileResults[0].type, 'file');

    const gitResults = resolveContextMentionQuery('git', '', mockFiles, mockGitStatus, mockMcpServers);
    assert.ok(gitResults.length >= 3, 'Should resolve branch and modified git status entries');
    assert.ok(gitResults.some(r => r.name.includes('feature/competitive-phases')));

    const mcpResults = resolveContextMentionQuery('mcp', 'Stripe', mockFiles, mockGitStatus, mockMcpServers);
    assert.strictEqual(mcpResults.length, 1);
    assert.strictEqual(mcpResults[0].name, 'Stripe Payments');

    console.log('  ✓ Test 3 Passed: resolveContextMentionQuery resolves real-time file searches, git status, and MCP tools');

    // =========================================================================
    // SECTION 2: Phase 1 - 1-Click External MCP Importer (Claude Desktop & Cursor)
    // =========================================================================
    console.log('\n--- Phase 1.2: External MCP Discovery & Auto-Importer ---');

    const tempDir = path.join(os.tmpdir(), `sb-ext-mcp-test-${Date.now()}`);
    await fs.ensureDir(tempDir);

    const mockClaudeConfigPath = path.join(tempDir, 'claude_desktop_config.json');
    const mockCursorConfigPath = path.join(tempDir, 'cursor_mcp.json');

    // Write Claude Desktop MCP config
    await fs.writeJson(mockClaudeConfigPath, {
        mcpServers: {
            'claude-github': {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { GITHUB_TOKEN: 'mock_gh_token_123' }
            },
            'claude-weather': {
                url: 'https://weather-api.internal/mcp/sse'
            }
        }
    });

    // Write Cursor MCP config
    await fs.writeJson(mockCursorConfigPath, {
        mcpServers: {
            'cursor-postgres': {
                command: 'docker',
                args: ['run', '-i', '--rm', 'mcp/postgres', 'postgresql://localhost:5432/main_db']
            },
            'cursor-filesystem': {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/dev/workspace']
            }
        }
    });

    const workspaceService = new WorkspaceConfigService();

    // Test 1.2.1: Discover and parse external MCP configs from custom mock paths
    const discovered = await workspaceService.discoverExternalMcpConfigs({
        claudePath: mockClaudeConfigPath,
        cursorPath: mockCursorConfigPath
    });

    assert.strictEqual(discovered.length, 2, 'Should discover both Claude Desktop and Cursor configs');
    const claudeSource = discovered.find(d => d.source === 'claude_desktop');
    const cursorSource = discovered.find(d => d.source === 'cursor');

    assert.ok(claudeSource, 'Claude Desktop source found');
    assert.strictEqual(claudeSource!.servers.length, 2, 'Claude should have 2 servers');
    assert.ok(claudeSource!.servers.some(s => s.name.includes('claude-github')));
    assert.ok(claudeSource!.servers.some(s => s.endpoint?.includes('weather-api.internal')));

    assert.ok(cursorSource, 'Cursor source found');
    assert.strictEqual(cursorSource!.servers.length, 2, 'Cursor should have 2 servers');
    assert.ok(cursorSource!.servers.some(s => s.name.includes('cursor-postgres')));

    console.log('  ✓ Test 4 Passed: External MCP config discovery accurately parses claude_desktop_config.json and cursor mcp.json');

    // Test 1.2.2: Import discovered servers into workspace .scratchbox/mcp.json
    const allDiscoveredServers = [...claudeSource!.servers, ...cursorSource!.servers];
    const imported = await workspaceService.importExternalMcpServers(tempDir, allDiscoveredServers);

    assert.strictEqual(imported.length, 4, 'Should import all 4 discovered external servers');
    const savedMcpFile = path.join(tempDir, '.scratchbox', 'mcp.json');
    assert.ok(await fs.pathExists(savedMcpFile), '.scratchbox/mcp.json should be created');
    const loadedSaved = await fs.readJson(savedMcpFile);
    assert.strictEqual(loadedSaved.servers.length, 4, 'Saved mcp.json should contain 4 servers');

    console.log('  ✓ Test 5 Passed: 1-Click external MCP importer successfully saves merged server configurations to .scratchbox/mcp.json');

    // =========================================================================
    // SECTION 3: Phase 2 - Multi-File Diff Generation & Batch Patch Apply Engine
    // =========================================================================
    console.log('\n--- Phase 2.1: Multi-File Diff Reviewer & Batch Apply Engine ---');

    const originalFiles: CodeFileTab[] = [
        {
            id: 'file-1',
            name: 'App.tsx',
            path: 'src/App.tsx',
            language: 'react',
            content: `import React from 'react';\n\nexport default function App() {\n  return <div>Old App</div>;\n}`
        },
        {
            id: 'file-2',
            name: 'styles.css',
            path: 'src/styles.css',
            language: 'css',
            content: `body { background: #000; }`
        }
    ];

    const proposedFiles = [
        {
            path: 'src/App.tsx',
            content: `import React, { useState } from 'react';\nimport { Sparkles } from 'lucide-react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <div className="p-4"><Sparkles /> New App {count}</div>;\n}`
        },
        {
            path: 'src/styles.css',
            content: `body { background: #09090b; color: #f4f4f5; }\n.btn { border-radius: 8px; }`
        },
        {
            path: 'src/components/Header.tsx',
            content: `import React from 'react';\nexport const Header = () => <header>Scratchbox</header>;`
        }
    ];

    // Test 2.1.1: Generate multi-file diff entries with accurate additions, deletions, and status
    const diffEntries: FileDiffEntry[] = generateMultiFileDiff(originalFiles, proposedFiles);

    assert.strictEqual(diffEntries.length, 3, 'Should generate diff entries for all 3 files');

    const appDiff = diffEntries.find(d => d.path === 'src/App.tsx');
    assert.ok(appDiff, 'App.tsx diff exists');
    assert.strictEqual(appDiff!.status, 'modified');
    assert.ok(appDiff!.additions > 0, 'App.tsx should have additions');
    assert.ok(appDiff!.deletions > 0, 'App.tsx should have deletions');

    const headerDiff = diffEntries.find(d => d.path === 'src/components/Header.tsx');
    assert.ok(headerDiff, 'Header.tsx diff exists');
    assert.strictEqual(headerDiff!.status, 'added');
    assert.strictEqual(headerDiff!.deletions, 0);

    console.log('  ✓ Test 6 Passed: generateMultiFileDiff accurately calculates modified and added files with additions/deletions metrics');

    // Test 2.1.2: Batch apply patch selectively (partial accept / reject)
    const patch: MultiFilePatch = {
        id: `patch-${Date.now()}`,
        title: 'Refactor UI with Sparkles and Header',
        summary: 'Added Header component and updated styles',
        timestamp: 'Just now',
        files: diffEntries
    };

    // Apply only App.tsx and Header.tsx (reject styles.css)
    const appliedFiles = applyMultiFilePatch(originalFiles, patch, ['src/App.tsx', 'src/components/Header.tsx']);

    assert.strictEqual(appliedFiles.length, 3, 'Should contain 3 total files after applying additions');
    const updatedApp = appliedFiles.find(f => f.path === 'src/App.tsx');
    const unchangedStyles = appliedFiles.find(f => f.path === 'src/styles.css');
    const addedHeader = appliedFiles.find(f => f.path === 'src/components/Header.tsx');

    assert.ok(updatedApp!.content.includes('Sparkles'), 'App.tsx should be updated with new content');
    assert.strictEqual(unchangedStyles!.content, 'body { background: #000; }', 'styles.css should remain unchanged when rejected');
    assert.ok(addedHeader, 'Header.tsx should be added to the file set');

    console.log('  ✓ Test 7 Passed: applyMultiFilePatch accurately applies selective batch patches while strictly preserving unselected files');

    // =========================================================================
    // SECTION 4: Phase 2 - Terminal Error Capture & AI Debug Prompt Synthesis
    // =========================================================================
    console.log('\n--- Phase 2.2: Terminal Error Capture & AI Debug Bridge ---');

    const sampleTerminalFailureOutput = `
$ tsc -b
src/browser/generative-canvas/GenerativeCanvasStudio.tsx:412:15 - error TS2339: Property 'nonExistentProp' does not exist on type 'StudioLayoutMode'.
412     if (mode.nonExistentProp) {
                 ~~~~~~~~~~~~~~~

src/node/workspace-config-service.ts:88:9 - error TS2322: Type 'number' is not assignable to type 'string'.
88         const id: string = 12345;
           ~~
Error: Command failed with exit code 2.
    at Process.ChildProcess._handle.onexit (node:internal/child_process:291:12)
    at runTscBuild (/Users/dev/scratchbox/scripts/build.ts:45:10)
`;

    // Test 2.2.1: Extract diagnostics and stack frames from raw terminal failure output
    const extracted = extractStackTraceAndDiagnostics(sampleTerminalFailureOutput);
    assert.ok(extracted.diagnostics.length >= 2, 'Should extract at least 2 compiler error diagnostics');
    assert.ok(extracted.diagnostics.some((d: string) => d.includes('TS2339')), 'Should capture TS2339 error code');
    assert.ok(extracted.diagnostics.some((d: string) => d.includes('TS2322')), 'Should capture TS2322 error code');
    assert.ok(extracted.stackFrames.length >= 1, 'Should capture stack trace frames');
    assert.ok(extracted.rootCauseSummary.includes('TypeScript compiler diagnostics'), 'Should synthesize root cause summary');

    console.log('  ✓ Test 8 Passed: extractStackTraceAndDiagnostics isolates TypeScript errors, line numbers, and stack frames');

    // Test 2.2.2: Synthesize comprehensive grounded AI self-healing debug prompt
    const mockFailure: TerminalExecutionError = {
        command: 'yarn build:extensions',
        exitCode: 2,
        output: sampleTerminalFailureOutput,
        stackTrace: 'Error: Command failed with exit code 2\n    at runTscBuild (/Users/dev/scratchbox/scripts/build.ts:45:10)'
    };

    const debugPrompt = synthesizeTerminalDebugPrompt(mockFailure);

    assert.ok(debugPrompt.includes('TERMINAL_SELF_HEALING_CONTEXT'), 'Prompt must contain structured self-healing header');
    assert.ok(debugPrompt.includes('yarn build:extensions'), 'Prompt must include failing command');
    assert.ok(debugPrompt.includes('Exit Code: 2'), 'Prompt must include exit code');
    assert.ok(debugPrompt.includes('TS2339'), 'Prompt must include captured diagnostics');
    assert.ok(debugPrompt.includes('Root Cause Analysis'), 'Prompt must instruct AI on self-healing repair steps');

    console.log('  ✓ Test 9 Passed: synthesizeTerminalDebugPrompt constructs high-reasoning Gemini self-healing debug prompt');

    // Cleanup temp directory
    await fs.remove(tempDir);

    console.log('\n🎉 ALL COMPETITIVE FEATURES (PHASE 1 & PHASE 2) TESTS PASSED SUCCESSFULLY!\n');
}

test('competitive-features-phases.test', async () => {
    await runCompetitiveFeaturesPhasesTestSuite();
}, 180_000);
