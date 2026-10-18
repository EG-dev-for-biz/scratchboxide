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
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import http from 'http';
import { createStandaloneServer, createToolsServer } from '../server/app';

async function runStandaloneServerTests() {
    console.log('🧪 Running Standalone Express Server Backend Tests...\n');

    // Deep-write pipeline test writes into a temp workspace; allow it explicitly.
    process.env.SCRATCHBOX_WORKSPACE_ROOTS = os.tmpdir();
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;

    const app = createStandaloneServer({ port: 0, toolsPort: 3999 });
    const token: string = app.locals.launchToken;
    assert.ok(token && token.length >= 64, 'launch token must be exposed on app.locals.launchToken');
    const server = http.createServer(app);

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as { port: number; address: string };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Every API call carries the per-launch token.
    const rawFetch = globalThis.fetch;
    const fetch: typeof rawFetch = (input: any, init: any = {}) => {
        const headers = new Headers(init.headers || {});
        headers.set('X-Scratchbox-Token', token);
        // Fresh socket per request: under heavy parallel test load the server's
        // keep-alive idle timeout can close a pooled socket while undici reuses it (ECONNRESET).
        headers.set('Connection', 'close');
        return rawFetch(input, { ...init, headers });
    };

    try {
        // Test 1: Browser Proxy Gateway Status
        console.log('  Testing GET /api/browser/status ...');
        const browserStatusRes = await fetch(`${baseUrl}/api/browser/status`);
        assert.strictEqual(browserStatusRes.status, 200, '/api/browser/status should return 200');
        const browserStatusData = await browserStatusRes.json();
        assert.strictEqual(browserStatusData.success, true);
        assert.strictEqual(browserStatusData.engine, 'Chromium Proxy Gateway');
        assert.strictEqual(browserStatusData.status, 'ready');
        console.log('  ✓ Test 1 Passed: /api/browser/status returns ready status');

        // Test 2: Gemini Models List
        console.log('  Testing GET /gemini/models ...');
        const modelsRes = await fetch(`${baseUrl}/gemini/models`);
        assert.strictEqual(modelsRes.status, 200, '/gemini/models should return 200');
        const modelsData = await modelsRes.json();
        assert.ok(Array.isArray(modelsData.models), 'models should be an array');
        assert.ok(modelsData.models.some((m: any) => m.id === 'gemini-3.8-flash'), 'gemini-3.8-flash must be present');
        console.log('  ✓ Test 2 Passed: /gemini/models returns Google GenAI models');

        // Test 3: Gemini Status
        console.log('  Testing GET /gemini/status ...');
        const statusRes = await fetch(`${baseUrl}/gemini/status`);
        assert.strictEqual(statusRes.status, 200, '/gemini/status should return 200');
        const statusData = await statusRes.json();
        assert.strictEqual(statusData.activeModel, 'gemini-4-argon');
        assert.ok(Array.isArray(statusData.availableModels));
        console.log('  ✓ Test 3 Passed: /gemini/status returns active model and availability');

        // Test 4: Workspace Config
        console.log('  Testing GET /workspace/config ...');
        const configRes = await fetch(`${baseUrl}/workspace/config`);
        assert.strictEqual(configRes.status, 200, '/workspace/config should return 200');
        const configData = await configRes.json();
        assert.ok(configData !== null && typeof configData === 'object');
        console.log('  ✓ Test 4 Passed: /workspace/config returns workspace configuration');

        // Test 5: Media Generation Capabilities
        console.log('  Testing GET /media/capabilities ...');
        const mediaRes = await fetch(`${baseUrl}/media/capabilities`);
        assert.strictEqual(mediaRes.status, 200, '/media/capabilities should return 200');
        const mediaData = await mediaRes.json();
        assert.ok(mediaData.image !== undefined);
        console.log('  ✓ Test 5 Passed: /media/capabilities returns media generator metadata');

        // Test 6: Project Artifacts Graph
        console.log('  Testing GET /workspace/project-artifacts ...');
        const artifactsRes = await fetch(`${baseUrl}/workspace/project-artifacts?projectId=test-proj`);
        assert.strictEqual(artifactsRes.status, 200, '/workspace/project-artifacts should return 200');
        const artifactsData = await artifactsRes.json();
        assert.strictEqual(artifactsData.project?.id, 'test-proj');
        assert.ok(artifactsData.artifacts !== undefined);
        console.log('  ✓ Test 6 Passed: /workspace/project-artifacts returns project artifact graph');

        // Test 7: Create Workspace Endpoint
        console.log('  Testing POST /workspace/create ...');
        const createRes = await fetch(`${baseUrl}/workspace/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'test-created-workspace'
            })
        });
        assert.strictEqual(createRes.status, 200, '/workspace/create should return 200');
        const createData = await createRes.json();
        assert.strictEqual(createData.success, true);
        assert.strictEqual(createData.workspace?.name, 'test-created-workspace');
        console.log('  ✓ Test 7 Passed: /workspace/create successfully creates new workspace structure on disk');

        // Test 8: Codebase Lens Project, Bindings, and Unproject Endpoints
        console.log('  Testing POST /gemini/lens/project ...');
        const lensProjRes = await fetch(`${baseUrl}/gemini/lens/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filePath: 'docs/architecture.md',
                sourceContent: '# Server Architecture\nStandalone server running on Express.\n\n- [x] Lens endpoints\n',
                options: { artifactId: 'art-server-test' }
            })
        });
        assert.strictEqual(lensProjRes.status, 200, '/gemini/lens/project should return 200');
        const lensProjData = await lensProjRes.json();
        assert.strictEqual(lensProjData.success, true);
        assert.strictEqual(lensProjData.binding.artifactId, 'art-server-test');
        assert.strictEqual(lensProjData.artifact.type, 'markdown-document');
        console.log('  ✓ Test 8 Passed: POST /gemini/lens/project projected artifact and registered binding');

        console.log('  Testing GET /gemini/lens/bindings ...');
        const lensBindingsRes = await fetch(`${baseUrl}/gemini/lens/bindings`);
        assert.strictEqual(lensBindingsRes.status, 200, '/gemini/lens/bindings should return 200');
        const lensBindingsData = await lensBindingsRes.json();
        assert.strictEqual(lensBindingsData.success, true);
        assert.ok(lensBindingsData.bindings.some((b: any) => b.artifactId === 'art-server-test'));
        console.log('  ✓ Test 9 Passed: GET /gemini/lens/bindings returned active lens bindings');

        console.log('  Testing POST /gemini/lens/unproject ...');
        const lensUnprojRes = await fetch(`${baseUrl}/gemini/lens/unproject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                artifactId: 'art-server-test',
                primitiveData: {
                    title: 'Server Architecture',
                    subtitle: 'Updated from standalone server test',
                    sections: [
                        { id: 'sec-1', type: 'heading', level: 1, content: 'Server Architecture' },
                        { id: 'sec-2', type: 'checklist', checklistItems: [{ id: 'c1', text: 'Lens endpoints', done: true }, { id: 'c2', text: 'Verified', done: true }] }
                    ]
                },
                currentDiskContent: '# Server Architecture\n'
            })
        });
        assert.strictEqual(lensUnprojRes.status, 200, '/gemini/lens/unproject should return 200');
        const lensUnprojData = await lensUnprojRes.json();
        assert.strictEqual(lensUnprojData.success, true);
        assert.ok(lensUnprojData.unprojection.files['document.md'] || lensUnprojData.unprojection.files['docs/architecture.md'] || Object.values(lensUnprojData.unprojection.files)[0]);
        console.log('  ✓ Test 10 Passed: POST /gemini/lens/unproject unprojected modified AST back to disk');

        console.log('  Testing POST /gemini/deep-write/pipeline ...');
        const tmpDwRoot = path.join(os.tmpdir(), 'scratchbox-dw-test-' + Date.now());
        const dwPipeRes = await fetch(`${baseUrl}/gemini/deep-write/pipeline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: 'Plan a high-performance C++ WASM physics simulation',
                sessionId: 'sess-dw-test',
                workspaceRoot: tmpDwRoot
            })
        });
        assert.strictEqual(dwPipeRes.status, 200, '/gemini/deep-write/pipeline should return 200 SSE stream');
        assert.strictEqual(dwPipeRes.headers.get('content-type'), 'text/event-stream');
        await dwPipeRes.body?.cancel();
        console.log('  ✓ Test 11 Passed: POST /gemini/deep-write/pipeline returns SSE stream');

        console.log('  Testing POST /gemini/deep-write/resume validation ...');
        const dwResumeRes = await fetch(`${baseUrl}/gemini/deep-write/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'nonexistent-session',
                feedback: 'test feedback'
            })
        });
        // Returns 500 when session is not found in memory
        assert.strictEqual(dwResumeRes.status, 500);
        console.log('  ✓ Test 12 Passed: POST /gemini/deep-write/resume handles session validation');

        console.log('  Testing POST /api/tools/export + isolated tools origin ...');
        const exportRes = await fetch(`${baseUrl}/api/tools/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolId: 'server-test-tool', title: 'Server Test Tool', html: '<!doctype html><html><body>exported tool body</body></html>' })
        });
        assert.strictEqual(exportRes.status, 200, '/api/tools/export should return 200');
        const exportData = await exportRes.json();
        assert.strictEqual(exportData.success, true);
        assert.strictEqual(exportData.url, 'http://127.0.0.1:3999/server-test-tool', 'export URL must point at the tools origin');

        // The API origin no longer serves tool HTML.
        const toolOnApi = await fetch(`${baseUrl}/tools/server-test-tool`);
        assert.notStrictEqual(toolOnApi.status, 200, 'API origin must not serve /tools/:id');
        const toolOnApiBody = await toolOnApi.text();
        assert.ok(!toolOnApiBody.includes('exported tool body'), 'API origin must not leak tool HTML');

        // The tools server shares the store and applies the sandboxing CSP.
        const toolsServer = http.createServer(createToolsServer(app.locals.exportedToolsStore));
        await new Promise<void>(resolve => toolsServer.listen(0, '127.0.0.1', () => resolve()));
        try {
            const toolsPort = (toolsServer.address() as { port: number }).port;
            const toolRes = await rawFetch(`http://127.0.0.1:${toolsPort}/server-test-tool`);
            assert.strictEqual(toolRes.status, 200);
            assert.ok((toolRes.headers.get('content-security-policy') || '').includes('sandbox allow-scripts'));
            assert.strictEqual(toolRes.headers.get('cross-origin-resource-policy'), 'cross-origin');
            assert.ok((await toolRes.text()).includes('exported tool body'));
        } finally {
            (toolsServer as any).closeAllConnections?.();
            toolsServer.close();
        }
        console.log('  ✓ Test 13 Passed: exported tools served from isolated origin with sandbox CSP');

        // Test 14: 3D Photogrammetry & Tile Cleanup Pipeline Endpoints
        console.log('  Testing GET /api/3d/tiles/status ...');
        const tileStatusRes = await fetch(`${baseUrl}/api/3d/tiles/status`);
        assert.strictEqual(tileStatusRes.status, 200, '/api/3d/tiles/status should return 200');
        const tileStatusData = await tileStatusRes.json();
        assert.strictEqual(tileStatusData.success, true);
        assert.strictEqual(tileStatusData.cloudRunReady, true);
        assert.ok(Array.isArray(tileStatusData.pipeline));
        assert.ok(tileStatusData.pipeline.includes('PlanarDecimation'));
        assert.ok(tileStatusData.pipeline.includes('CornerStraightener'));

        console.log('  Testing POST /api/3d/tiles/cleanup ...');
        // No tile in the request: a typed 400, not a cleaned built-in model.
        const noInputRes = await fetch(`${baseUrl}/api/3d/cleanup-tiles/cleanup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ angleThresholdDegrees: 4.0 })
        });
        assert.strictEqual(noInputRes.status, 400, '/api/3d/tiles/cleanup without a tile should return 400');
        assert.strictEqual((await noInputRes.json()).error, 'missing_input');

        const inputGlb = fs.readFileSync(
            path.resolve(__dirname, '../../deploy/cloud-run/spatial-separator/assets/temple_venus_roma_sb_archi.glb')
        );
        const cleanupRes = await fetch(`${baseUrl}/api/3d/cleanup-tiles/cleanup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                glbBase64: inputGlb.toString('base64'),
                angleThresholdDegrees: 4.0,
                snapToleranceMeters: 0.85,
                roadWidthMeters: 8.0
            })
        });
        assert.strictEqual(cleanupRes.status, 200, '/api/3d/tiles/cleanup should return 200');
        const cleanupData = await cleanupRes.json();
        assert.strictEqual(cleanupData.success, true);
        assert.ok(cleanupData.metrics);
        // The temple GLB has 9180 triangles; the counts come from the uploaded tile.
        assert.strictEqual(cleanupData.metrics.rawTriangles, 9180);
        assert.ok(cleanupData.glbBase64 && cleanupData.glbBase64.length > 1000);
        console.log('  ✓ Test 14 Passed: 3D tile cleanup pipeline endpoints respond with validated GLB & metrics');

        console.log('\n🎉 ALL STANDALONE SERVER BACKEND TESTS PASSED SUCCESSFULLY!\n');
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
        delete process.env.SCRATCHBOX_WORKSPACE_ROOTS;
    }

}

test('standalone-server.test', async () => {
    await runStandaloneServerTests();
}, 180_000);
