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
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import {
    CanvasArtifact,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    NodeGraphData
} from '../src/browser/generative-canvas/canvas-types';

async function runWorkspaceOrganizationTests() {
    console.log('🧪 Running Workspace Organization, Project Rules & Artifact Sync Test Suite...');

    // Create a temporary sandbox workspace directory
    const tempDir = path.join(os.tmpdir(), `sb-workspace-test-${Date.now()}`);
    await fs.ensureDir(tempDir);

    const workspaceService = new WorkspaceConfigService();

    try {
        // Setup mock project structure in tempDir
        const sbDir = path.join(tempDir, '.scratchbox');
        const rulesDir = path.join(sbDir, 'rules');
        const skillsDir = path.join(sbDir, 'skills');
        await fs.ensureDir(rulesDir);
        await fs.ensureDir(skillsDir);

        // 1. Create project rule files
        await fs.writeFile(
            path.join(tempDir, 'SCRATCHBOX.md'),
            '# Project Directives\nAlways use strict TypeScript and Apple HIG 8-pt spacing.'
        );
        await fs.writeFile(
            path.join(rulesDir, 'code-style.md'),
            '# Coding Style\nPrefer functional React components with spring micro-interactions.'
        );

        // 2. Create custom project skill file
        await fs.writeFile(
            path.join(skillsDir, 'database-architect.md'),
            `---
name: Database Architect
description: Specialized superpower for PostgreSQL relational modeling & schema migrations
category: Engineering
accentColor: cyan
tags: [PostgreSQL, Schema, SQL]
---
# Database Architecture Superpower Rules
Ensure all foreign keys have indexes and validate schema constraints.`
        );

        // 3. Create workspace-level mcp.json
        await fs.writeFile(
            path.join(sbDir, 'mcp.json'),
            JSON.stringify({
                servers: [
                    {
                        id: 'mcp-local-postgres',
                        name: 'Local PostgreSQL',
                        tagline: 'Direct schema access to local development database',
                        category: 'Data Storage',
                        status: 'connected',
                        toolsCount: 3,
                        isEnabled: true,
                        accentColor: 'blue',
                        endpoint: 'postgresql://localhost:5432/dev_db',
                        tools: [
                            {
                                id: 'pg-tables',
                                name: 'list_tables',
                                humanTitle: 'List DB Tables',
                                description: 'List all public schema tables',
                                samplePrompt: 'Inspect database tables'
                            }
                        ]
                    }
                ]
            }, null, 2)
        );

        // Test 1: Discover and parse project rules (.scratchbox/rules/*.md + SCRATCHBOX.md)
        const projectRules = await workspaceService.discoverProjectRules(tempDir);
        assert.ok(projectRules.length >= 2, 'Should discover at least SCRATCHBOX.md and code-style.md');
        assert.ok(projectRules.some((r: { path: string }) => r.path.includes('SCRATCHBOX.md')));
        assert.ok(projectRules.some((r: { title: string }) => r.title.includes('code-style')));
        console.log('  ✓ Test 1 Passed: Project rules (.scratchbox/rules/*.md & SCRATCHBOX.md) discovered and parsed');

        // Test 2: Discover and parse project skills (.scratchbox/skills/*.md)
        const customSkills = await workspaceService.discoverProjectSkills(tempDir);
        assert.strictEqual(customSkills.length, 1);
        assert.strictEqual(customSkills[0].name, 'Database Architect');
        assert.strictEqual(customSkills[0].category, 'Engineering');
        assert.strictEqual(customSkills[0].isCustom, true);
        assert.ok(customSkills[0].tags.includes('PostgreSQL'));
        console.log('  ✓ Test 2 Passed: Project-level superpowers (.scratchbox/skills/*.md) loaded dynamically');

        // Test 3: Load workspace-specific MCP servers (.scratchbox/mcp.json)
        const mcpServers = await workspaceService.loadWorkspaceMcpServers(tempDir);
        assert.strictEqual(mcpServers.length, 1);
        assert.strictEqual(mcpServers[0].id, 'mcp-local-postgres');
        assert.strictEqual(mcpServers[0].toolsCount, 3);
        console.log('  ✓ Test 3 Passed: Workspace-aware MCP integrations (.scratchbox/mcp.json) loaded');

        // Test 4: Workspace config persistence (User preferences vs Workspace settings)
        await workspaceService.saveWorkspaceConfig(tempDir, {
            settings: {
                glassBlur: 'vibrant',
                enableSpringMotion: true,
                defaultModel: 'gemini-3.8-flash',
                thinkingBudget: 2048
            }
        });
        const loadedConfig = await workspaceService.loadFullWorkspaceConfig(tempDir);
        assert.strictEqual(loadedConfig.settings?.glassBlur, 'vibrant');
        assert.strictEqual(loadedConfig.settings?.thinkingBudget, 2048);
        assert.ok(loadedConfig.rules.length >= 2);
        assert.strictEqual(loadedConfig.customSkills.length, 1);
        console.log('  ✓ Test 4 Passed: Workspace settings (.scratchbox/config.json) saved and loaded hierarchically');

        // Test 5: Bi-directional Artifact Sync - Sync Live Code Sandbox to workspace files
        const sandboxArtifact: CanvasArtifact = {
            id: 'art-sync-sandbox',
            type: 'live-code-sandbox',
            title: 'Metric Card Component',
            summary: 'Live React component',
            version: 1,
            createdAt: '12:00 PM',
            data: {
                title: 'Metric Card Component',
                files: [
                    { id: 'f1', name: 'MetricCard.tsx', language: 'react', content: 'export const MetricCard = () => <div>KPI</div>;', isEntry: true },
                    { id: 'f2', name: 'MetricCard.css', language: 'css', content: '.kpi { color: blue; }' }
                ]
            } as LiveCodeSandboxData
        };

        const syncSandboxResult = await workspaceService.syncArtifactToWorkspace(tempDir, sandboxArtifact, 'src/components');
        assert.strictEqual(syncSandboxResult.success, true);
        assert.ok(await fs.pathExists(path.join(tempDir, 'src/components/MetricCard.tsx')));
        assert.ok(await fs.pathExists(path.join(tempDir, 'src/components/MetricCard.css')));
        const writtenTsx = await fs.readFile(path.join(tempDir, 'src/components/MetricCard.tsx'), 'utf-8');
        assert.ok(writtenTsx.includes('export const MetricCard'));
        console.log('  ✓ Test 5 Passed: Live Code Sandbox multi-tab files synced to workspace directory');

        // Test 6: Bi-directional Artifact Sync - Sync Markdown Document to docs/
        const docArtifact: CanvasArtifact = {
            id: 'art-sync-doc',
            type: 'markdown-document',
            title: 'Architecture Spec',
            summary: 'Architecture specification',
            version: 1,
            createdAt: '12:00 PM',
            data: {
                title: 'Scratchbox Architecture Blueprint',
                subtitle: 'Modular AI canvas spec',
                sections: [
                    { id: 's1', type: 'heading', level: 1, content: '1. Architecture Blueprint' },
                    { id: 's2', type: 'paragraph', content: 'The system uses live WebSocket pipes.' },
                    { id: 's3', type: 'callout', calloutType: 'info', calloutTitle: 'MCP Gateway', content: 'Typed MCP tools.' },
                    { id: 's4', type: 'table', tableHeaders: ['Feature', 'Status'], tableRows: [['MCP', 'Live'], ['Canvas', 'Active']] }
                ]
            } as MarkdownDocumentData
        };

        const syncDocResult = await workspaceService.syncArtifactToWorkspace(tempDir, docArtifact, 'docs');
        assert.strictEqual(syncDocResult.success, true);
        assert.ok(await fs.pathExists(path.join(tempDir, 'docs/architecture-spec.md')));
        const docContent = await fs.readFile(path.join(tempDir, 'docs/architecture-spec.md'), 'utf-8');
        assert.ok(docContent.includes('# 1. Architecture Blueprint'));
        assert.ok(docContent.includes('| Feature | Status |'));
        console.log('  ✓ Test 6 Passed: Markdown Document artifact synced to formatted workspace markdown file');

        // Test 7: Bi-directional Artifact Sync - Sync Node Graph to JSON workflow file
        const graphArtifact: CanvasArtifact = {
            id: 'art-sync-graph',
            type: 'node-graph',
            title: 'Data Ingestion Pipeline',
            summary: 'N8N workflow graph',
            version: 1,
            createdAt: '12:00 PM',
            data: {
                title: 'Data Ingestion Pipeline',
                nodes: [{ id: 'n1', label: 'Webhook', category: 'input', x: 100, y: 100 }],
                edges: []
            } as NodeGraphData
        };

        const syncGraphResult = await workspaceService.syncArtifactToWorkspace(tempDir, graphArtifact, 'workflows');
        assert.strictEqual(syncGraphResult.success, true);
        assert.ok(await fs.pathExists(path.join(tempDir, 'workflows/data-ingestion-pipeline.workflow.json')));
        const graphJson = await fs.readJson(path.join(tempDir, 'workflows/data-ingestion-pipeline.workflow.json'));
        assert.strictEqual(graphJson.title, 'Data Ingestion Pipeline');
        console.log('  ✓ Test 7 Passed: Visual Node Graph synced to workspace workflow JSON file');

        console.log('\n🎉 ALL WORKSPACE ORGANIZATION & ARTIFACT SYNC TESTS PASSED SUCCESSFULLY!');
    } finally {
        await fs.remove(tempDir);
    }
}

test('workspace-organization.test', async () => {
    await runWorkspaceOrganizationTests();
}, 180_000);
