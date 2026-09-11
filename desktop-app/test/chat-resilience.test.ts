import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import {
    extractArtifactFromJson,
    cleanMessageTextSmart,
    parseMarkdownBlocks,
    tokenizeCode,
    isCanvasArtifactJson
} from '@scratchbox/core/browser/generative-canvas/ChatMarkdownRenderer';
import { createStandaloneServer } from '../server/app';
import http from 'http';

async function runChatResilienceTests() {
    console.log('🧪 Running Chat Stream, Markdown, and Artifact Resilience Tests...\n');

    // 1. extractArtifactFromJson resilience
    console.log('  Testing extractArtifactFromJson edge cases & null safety...');
    assert.strictEqual(extractArtifactFromJson(undefined as any), null);
    assert.strictEqual(extractArtifactFromJson(null as any), null);
    assert.strictEqual(extractArtifactFromJson(''), null);
    assert.strictEqual(extractArtifactFromJson('   '), null);
    assert.strictEqual(extractArtifactFromJson('null'), null);
    assert.strictEqual(extractArtifactFromJson('undefined'), null);
    assert.strictEqual(extractArtifactFromJson('12345'), null);
    assert.strictEqual(extractArtifactFromJson('{"type": "3d-scene", invalid json'), null);
    assert.strictEqual(extractArtifactFromJson('```json\n{"type": "3d-scene", in flight json'), null);
    assert.strictEqual(extractArtifactFromJson('[1, 2, 3]'), null);

    // Valid 3D Scene JSON extraction
    const valid3DJson = `Here is the scene:
\`\`\`json
{
  "type": "3d-scene",
  "title": "Battle of Lexington",
  "data": {
    "title": "Battle of Lexington Green",
    "camera": { "position": [10, 10, 10], "target": [0, 0, 0] },
    "objects": []
  }
}
\`\`\``;
    const extracted3D = extractArtifactFromJson(valid3DJson);
    assert.ok(extracted3D, 'Must extract valid 3D scene artifact');
    assert.strictEqual(extracted3D?.type, '3d-scene');
    assert.strictEqual(extracted3D?.title, 'Battle of Lexington');

    // Unfenced JSON extraction
    const unfencedJson = `I generated your canvas artifact:
{
  "type": "3d-scene",
  "title": "Solar System",
  "summary": "Planetary orbits",
  "camera": { "position": [15, 12, 15] }
}`;
    const extractedUnfenced = extractArtifactFromJson(unfencedJson);
    assert.ok(extractedUnfenced, 'Must extract unfenced 3D scene artifact');
    assert.strictEqual(extractedUnfenced?.type, '3d-scene');

    console.log('  ✓ Test 1 Passed: extractArtifactFromJson is null-safe and handles malformed/in-flight JSON');

    // 2. cleanMessageTextSmart resilience
    console.log('  Testing cleanMessageTextSmart with streaming chunks and edge cases...');
    assert.strictEqual(cleanMessageTextSmart(undefined as any), '');
    assert.strictEqual(cleanMessageTextSmart(null as any), '');
    assert.strictEqual(cleanMessageTextSmart(''), '');

    const streamingChunkWithJson = `Connected to Studio AI Engine with Thinking active...
Here is the 3D scene JSON for your visual canvas:
\`\`\`json
{
  "type": "3d-scene",
  "title": "Lexington Battlefield",
  "camera": { "position": [15, 12, 15] }
}
\`\`\`
Let me know if you would like me to adjust the troop formations or lighting!`;

    const cleanedText = cleanMessageTextSmart(streamingChunkWithJson, {
        id: 'art-1',
        type: '3d-scene',
        title: 'Lexington Battlefield',
        summary: '3D Scene',
        version: 1,
        createdAt: 'Now',
        data: {
            title: 'Lexington Battlefield',
            camera: { position: [15, 12, 15], target: [0, 0, 0] },
            objects: []
        }
    });
    assert.ok(!cleanedText.includes('Connected to Studio AI Engine'));
    assert.ok(!cleanedText.includes('"type": "3d-scene"'));
    assert.ok(cleanedText.includes('Let me know if you would like me to adjust the troop formations'));

    // Verify code block retention
    const mixedMsg = `Here is sample code:
\`\`\`python
print("Hello Scratchbox")
\`\`\``;
    const cleanedCode = cleanMessageTextSmart(mixedMsg);
    assert.ok(cleanedCode.includes('print("Hello Scratchbox")'), 'Actual non-artifact code must be preserved');

    console.log('  ✓ Test 2 Passed: cleanMessageTextSmart cleanly filters artifacts and protects real code');

    // 3. parseMarkdownBlocks resilience
    console.log('  Testing parseMarkdownBlocks with in-flight streaming chunks...');
    assert.deepStrictEqual(parseMarkdownBlocks(undefined as any), []);
    assert.deepStrictEqual(parseMarkdownBlocks(null as any), []);
    assert.deepStrictEqual(parseMarkdownBlocks(''), []);

    // Streaming incomplete code block
    const streamingIncompleteCode = `Analyzing request:\n\`\`\`typescript\nconst scene = new THREE.Scene();`;
    const streamingBlocks = parseMarkdownBlocks(streamingIncompleteCode);
    assert.ok(streamingBlocks.length >= 2, 'Should parse leading text and in-flight code block');
    assert.strictEqual(streamingBlocks[1].type, 'code');

    // Suppress artifact JSON in markdown blocks
    const artifactCodeBlock = `\`\`\`json\n{\n  "type": "3d-scene",\n  "camera": {}\n}\n\`\`\``;
    const artifactBlocks = parseMarkdownBlocks(artifactCodeBlock);
    assert.strictEqual(artifactBlocks.filter(b => b.type === 'code').length, 0, 'Artifact JSON code box should be suppressed');

    console.log('  ✓ Test 3 Passed: parseMarkdownBlocks safely handles streaming chunks and suppresses raw artifact boxes');

    // 4. tokenizeCode resilience
    console.log('  Testing tokenizeCode edge cases...');
    assert.deepStrictEqual(tokenizeCode(undefined as any), []);
    assert.deepStrictEqual(tokenizeCode(null as any), []);
    assert.deepStrictEqual(tokenizeCode(''), []);
    assert.ok(tokenizeCode('const x = "unclosed string').length > 0);
    assert.ok(tokenizeCode('const x = "ends with slash\\').length > 0);
    assert.ok(tokenizeCode('/* unclosed block comment\nlet y = 1;').length > 0);
    console.log('  ✓ Test 4 Passed: tokenizeCode does not throw on unexpected/malformed code');

    // 5. Backend /gemini/generate-stream and /gemini/stream endpoints
    console.log('  Testing Standalone Server /gemini/generate-stream & /gemini/stream endpoints...');
    const app = createStandaloneServer({ port: 0, toolsPort: 3998 });
    // Every non-open route requires the per-launch token (see server-auth.test.ts).
    const authHeaders = { 'Content-Type': 'application/json', 'X-Scratchbox-Token': app.locals.launchToken as string };
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as any;
    const testPort = address.port;

    try {
        // Unauthenticated streaming must be rejected before any model work happens
        const resNoToken = await fetch(`http://127.0.0.1:${testPort}/gemini/generate-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'test prompt' })
        });
        assert.strictEqual(resNoToken.status, 401, 'stream endpoints must require the launch token');

        // Test /gemini/generate-stream
        const resGenStream = await fetch(`http://127.0.0.1:${testPort}/gemini/generate-stream`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ prompt: 'test prompt' })
        });
        assert.strictEqual(resGenStream.status, 200);
        assert.ok(resGenStream.headers.get('content-type')?.includes('text/event-stream'));

        // Test /gemini/stream
        const resStream = await fetch(`http://127.0.0.1:${testPort}/gemini/stream`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ prompt: 'test prompt' })
        });
        assert.strictEqual(resStream.status, 200);
        assert.ok(resStream.headers.get('content-type')?.includes('text/event-stream'));

        // Cancel stream readers so connections close cleanly
        await resGenStream.body?.cancel();
        await resStream.body?.cancel();

        console.log('  ✓ Test 5 Passed: Standalone server supports both /gemini/stream and /gemini/generate-stream cleanly');
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
    }

    console.log('\n🎉 ALL CHAT RESILIENCE TESTS PASSED SUCCESSFULLY!\n');

}

test('chat-resilience.test', async () => {
    await runChatResilienceTests();
}, 180_000);
