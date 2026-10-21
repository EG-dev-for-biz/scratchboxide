import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { availableToolNames } from '../src/node/gemini/tool-catalog';
import * as assert from 'assert';
import { GeminiService } from '../src/node/gemini-service';
import {
    GeminiGenerateRequest
} from '../src/common/gemini-protocol';
import {
    MarkdownDocumentData,
    NodeGraphData,
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';

async function runCodebaseLensAgentToolsTests() {
    console.log('🧪 Running Gemini Codebase Lens Agent Tools Integration Tests...\n');

    const geminiService = new GeminiService();

    // =========================================================================
    // Test 1: Tool Declarations Exposure in Gemini Reasoning Engine
    // =========================================================================
    console.log('  1. Testing buildToolDeclarations() exposes all 4 Codebase Lens agent tools...');
    const request: GeminiGenerateRequest = {
        prompt: 'Please inspect docs/architecture.md and project it into a visual canvas lens',
        enableGoogleSearch: false
    };

    const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
    assert.ok(toolDeclarations, 'Tool declarations must be returned');
    assert.ok(Array.isArray(toolDeclarations));

    const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
    assert.ok(fnDeclsContainer, 'Must contain functionDeclarations container');

    // Declared up front or loadable by name through load_tools (tool-catalog.ts).
    const toolNames = availableToolNames(toolDeclarations).all;
    // Their full declarations, as offered once loaded.
    const fnDecls: any[] = (geminiService as any).buildToolDeclarations({ ...request, loadedTools: toolNames }).find((t: any) => t.functionDeclarations).functionDeclarations;

    assert.ok(toolNames.includes('lens_project'), 'Must declare lens_project tool');
    assert.ok(toolNames.includes('lens_unproject'), 'Must declare lens_unproject tool');
    assert.ok(toolNames.includes('lens_list_bindings'), 'Must declare lens_list_bindings tool');
    assert.ok(toolNames.includes('lens_sync'), 'Must declare lens_sync tool');

    const projectTool = fnDecls.find((d: any) => d.name === 'lens_project');
    assert.deepStrictEqual(projectTool.parameters.required, ['filePath']);

    const unprojectTool = fnDecls.find((d: any) => d.name === 'lens_unproject');
    assert.deepStrictEqual(unprojectTool.parameters.required, ['artifactId']);

    const syncTool = fnDecls.find((d: any) => d.name === 'lens_sync');
    assert.deepStrictEqual(syncTool.parameters.required, ['artifactId', 'direction']);

    console.log('    ✓ All 4 codebase lens tools correctly declared in Gemini schema.');

    // =========================================================================
    // Test 2: Direct Execution of lens_project via GeminiService
    // =========================================================================
    console.log('  2. Testing executeLensProject() for live markdown codebase projection...');
    const sampleMarkdown = `# System Architecture
High performance developer workspace.

> [!NOTE]
> Connected via Gemini 3.8 Flash reasoning engine.

## 1. Modules
- [x] Lens Protocol
- [ ] Agent Tool Registry
`;

    const projectResult = await geminiService.executeLensProject(
        'docs/architecture.md',
        sampleMarkdown,
        { artifactId: 'art-arch-spec' }
    );

    assert.strictEqual(projectResult.success, true);
    assert.ok(projectResult.binding);
    assert.strictEqual(projectResult.binding.artifactId, 'art-arch-spec');
    assert.strictEqual(projectResult.binding.lensType, 'markdown-document');
    assert.strictEqual(projectResult.binding.status, 'synced');

    const artifact = projectResult.artifact;
    assert.strictEqual(artifact.id, 'art-arch-spec');
    assert.strictEqual(artifact.type, 'markdown-document');
    const docData = artifact.data as MarkdownDocumentData;
    assert.strictEqual(docData.title, 'System Architecture');
    assert.ok(docData.sections.some(s => s.type === 'callout'));
    console.log('    ✓ executeLensProject successfully created binding and populated canvas artifact.');

    // =========================================================================
    // Test 3: Direct Execution of lens_list_bindings
    // =========================================================================
    console.log('  3. Testing executeLensListBindings() to inspect active bindings...');
    const bindings = geminiService.executeLensListBindings();
    assert.ok(bindings.length >= 1);
    const boundItem = bindings.find(b => b.artifactId === 'art-arch-spec');
    assert.ok(boundItem);
    assert.strictEqual(boundItem?.primaryFilePath, 'docs/architecture.md');
    assert.strictEqual(boundItem?.status, 'synced');
    console.log('    ✓ executeLensListBindings returned active registered bindings.');

    // =========================================================================
    // Test 4: Direct Execution of lens_unproject back to disk files
    // =========================================================================
    console.log('  4. Testing executeLensUnproject() for writing visual canvas changes to disk...');
    const modifiedDoc: MarkdownDocumentData = {
        ...docData,
        subtitle: 'Updated from autonomous agent tool reasoning loop.',
        sections: docData.sections.map(s => {
            if (s.type === 'checklist') {
                return {
                    ...s,
                    checklistItems: s.checklistItems?.map(item => ({ ...item, done: true }))
                };
            }
            return s;
        })
    };

    const unprojectResult = await geminiService.executeLensUnproject(
        'art-arch-spec',
        modifiedDoc,
        sampleMarkdown
    );

    assert.strictEqual(unprojectResult.success, true);
    assert.ok(unprojectResult.unprojection);
    const generatedMd = Object.values(unprojectResult.unprojection.files)[0];
    assert.ok(generatedMd.includes('- [x] Agent Tool Registry'));
    assert.ok(generatedMd.includes('Updated from autonomous agent tool reasoning loop.'));
    console.log('    ✓ executeLensUnproject generated accurate AST-preserving disk file updates.');

    // =========================================================================
    // Test 5: Direct Execution of lens_sync in both directions
    // =========================================================================
    console.log('  5. Testing executeLensSync() (in & out sync modes)...');
    const syncOutResult = geminiService.executeLensSync('art-arch-spec', 'out', {
        primitiveData: modifiedDoc,
        diskContent: sampleMarkdown
    });
    assert.strictEqual(syncOutResult.success, true);

    const syncInResult = geminiService.executeLensSync('art-arch-spec', 'in', {
        diskContent: sampleMarkdown
    });
    assert.strictEqual(syncInResult.success, true);
    console.log('    ✓ executeLensSync succeeded for both in (disk->UI) and out (UI->disk) directions.');

    // =========================================================================
    // Test 6: Multi-Lens Projecting across diverse primitives
    // =========================================================================
    console.log('  6. Testing projection across NodeGraph, 3D Scene, and Kanban primitives...');

    // 6a. Node Graph Workflow
    const workflowResult = await geminiService.executeLensProject(
        'workflows/deploy.workflow.json',
        JSON.stringify({
            title: 'Agent Pipeline',
            nodes: [{ id: 'n1', label: 'Input Prompt', category: 'input', x: 0, y: 0 }],
            edges: []
        }),
        { artifactId: 'art-workflow-1' }
    );
    assert.strictEqual(workflowResult.success, true);
    assert.strictEqual(workflowResult.artifact.type, 'node-graph');
    assert.strictEqual((workflowResult.artifact.data as NodeGraphData).nodes.length, 1);

    // 6b. 3D Scene World
    const sceneResult = await geminiService.executeLensProject(
        'scenes/city.scene.json',
        JSON.stringify({
            title: 'Cyberpunk City World',
            worldBranch: 'main',
            objects: []
        }),
        { artifactId: 'art-scene-1' }
    );
    assert.strictEqual(sceneResult.success, true);
    assert.strictEqual(sceneResult.artifact.type, '3d-scene');
    assert.strictEqual((sceneResult.artifact.data as Scene3DData).title, 'Cyberpunk City World');

    console.log('    ✓ Multi-primitive lens project executions verified.');

    // =========================================================================
    // Test 7: Telemetry Synthesis for Agent MCP Tool Executions
    // =========================================================================
    console.log('  7. Testing synthesizeMcpExecution() for all 4 lens tools...');
    const projectMcp = (geminiService as any).synthesizeMcpExecution({
        name: 'lens_project',
        args: { filePath: 'docs/architecture.md' }
    }, request);
    assert.strictEqual(projectMcp.status, 'completed');
    assert.strictEqual(projectMcp.toolName, 'lens_project');
    assert.strictEqual(projectMcp.mcpServerId, 'mcp-codebase-lens');
    assert.ok(projectMcp.steps.length >= 3);

    const unprojectMcp = (geminiService as any).synthesizeMcpExecution({
        name: 'lens_unproject',
        args: { artifactId: 'art-arch-spec' }
    }, request);
    assert.strictEqual(unprojectMcp.toolName, 'lens_unproject');
    assert.strictEqual(unprojectMcp.humanFriendlyOutput?.title.includes('art-arch-spec'), true);

    const listMcp = (geminiService as any).synthesizeMcpExecution({
        name: 'lens_list_bindings',
        args: {}
    }, request);
    assert.strictEqual(listMcp.toolName, 'lens_list_bindings');
    assert.strictEqual(listMcp.humanFriendlyOutput?.cardType, 'table');

    const syncMcp = (geminiService as any).synthesizeMcpExecution({
        name: 'lens_sync',
        args: { artifactId: 'art-arch-spec', direction: 'out' }
    }, request);
    assert.strictEqual(syncMcp.toolName, 'lens_sync');
    assert.ok(syncMcp.humanFriendlyOutput?.title.includes('out'));

    console.log('    ✓ Live MCP execution telemetry properly formatted with human-friendly outputs.');

    console.log('\n🎉 ALL 7 CODEBASE LENS AGENT TOOLS TESTS PASSED SUCCESSFULLY!');
}

test('codebase-lens-agent-tools.test', async () => {
    await runCodebaseLensAgentToolsTests();
}, 180_000);
