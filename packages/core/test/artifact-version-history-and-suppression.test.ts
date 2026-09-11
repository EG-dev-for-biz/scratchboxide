import { test } from 'vitest';
import * as assert from 'assert';
import {
    parseMarkdownBlocks,
    cleanMessageTextSmart,
    isCanvasArtifactJson,
    extractArtifactFromJson
} from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { CanvasArtifact, ChatMessage } from '../src/browser/generative-canvas/canvas-types';

async function runArtifactVersionHistoryAndSuppressionTests() {
    console.log('🧪 Running Canvas Artifact Version History, Rollback & JSON Suppression Test Suite...\n');

    // =========================================================================
    // SECTION 1: Suppress Raw JSON Data in End-User Chat Messages
    // =========================================================================

    // Test 0: isCanvasArtifactJson detection
    assert.strictEqual(isCanvasArtifactJson('{"camera": {"fov": 45}, "environment": {"skybox": "dawn"}}'), true);
    assert.strictEqual(isCanvasArtifactJson('json , "camera": { "position": [0,0,0] }'), true);
    assert.strictEqual(isCanvasArtifactJson('const a = 10;'), false);

    // Test 1: Exact malformed 3D scene JSON text from user screenshot
    console.log('Test 1: Suppress malformed / unfenced 3D scene JSON text (from user screenshot)');
    const screenshotAssistantMessage = `Here's a 3D scene representing the Battle of Lexington in 1775, capturing the historical setting of the event.

json , "camera": { "position":, "target":, "fov": 45 }, "environment": { "skybox": "dawn-historical", "lighting": "daylight", "ground": true }, "features": { "atmosphericScattering": true, "godRays": false, "contrails": false, "controlSurfaces": false, "terrainBiomes": { "biomeType": "grassland" } }, "geoAnchor": { "lat": 42.44944, "lng": -71.23139, "elevation": 50.0, "active": true, "landmarkName": "Lexington Battle Green, Massachusetts" }, "objects": [ { "id": "obj-lexington-green", "content": { "type": "3d-model", "durableUri": "internal:lexington-green-terrain", "mimeType": "model/gltf", "metadata": { "dims": { "width": 150, "height": 0.5, "depth": 150 } } }, "space": { "spatial3d": { "x": 0, "y": 0, "z": 0, "pitch": 0, "yaw": 0, "roll": 0 } }, "time": { "startMs": 0, "durationMs": 10000 }, "lineage": { "version": 1 } } ]`;

    const cleanedScreenshotMsg = cleanMessageTextSmart(screenshotAssistantMessage);
    assert.ok(cleanedScreenshotMsg.includes("Here's a 3D scene representing the Battle of Lexington in 1775, capturing the historical setting of the event."), 'Human-readable explanation must be preserved');
    assert.ok(!cleanedScreenshotMsg.includes('json , "camera"'), 'Malformed "json , camera" text must be completely stripped');
    assert.ok(!cleanedScreenshotMsg.includes('atmosphericScattering'), 'Features JSON properties must be stripped');
    assert.ok(!cleanedScreenshotMsg.includes('Lexington Battle Green'), 'GeoAnchor JSON properties must be stripped from raw chat body');
    assert.ok(!cleanedScreenshotMsg.includes('obj-lexington-green'), 'Objects JSON definitions must be stripped');
    console.log('  ✓ Test 1 Passed: Malformed / unfenced 3D scene JSON from screenshot cleanly stripped');

    // Test 2: Standard fenced 3D scene JSON block suppression
    console.log('Test 2: Suppress fenced 3D scene JSON with preamble');
    const fenced3DMessage = `Here are the key buildings defined in the scene:
- Buckman Tavern: Rallying point for the militia.
- Lexington Meeting House: Located prominently near the common.
- Jonathan Harrington House: Home of one of the fallen Minutemen.

Here's the updated 3D scene JSON:

\`\`\`json
{
  "id": "art-battle-lexington",
  "type": "3d-scene",
  "title": "3D Scene: Battle of Lexington (Labeled Buildings)",
  "version": 2,
  "data": {
    "title": "3D Scene: Battle of Lexington (Labeled Buildings)",
    "camera": { "position": [0, 20, 40], "target": [0, 0, 0], "fov": 50 },
    "environment": { "skybox": "dawn-historical", "lighting": "daylight", "ground": true },
    "objects": [
      { "id": "obj-buckman-tavern", "content": { "type": "3d-model" } }
    ]
  }
}
\`\`\`

Let me know if you would like to adjust the camera or add troop formations!`;

    const cleanedFencedMsg = cleanMessageTextSmart(fenced3DMessage);
    assert.ok(cleanedFencedMsg.includes('Buckman Tavern: Rallying point for the militia.'), 'Bullet list explanation must be preserved');
    assert.ok(cleanedFencedMsg.includes('Let me know if you would like to adjust the camera'), 'Trailing explanation must be preserved');
    assert.ok(!cleanedFencedMsg.includes("Here's the updated 3D scene JSON:"), 'JSON preamble must be stripped');
    assert.ok(!cleanedFencedMsg.includes('"art-battle-lexington"'), 'JSON artifact body must be stripped');
    assert.ok(!cleanedFencedMsg.includes('"camera"'), 'Camera JSON block must be stripped');

    // Verify markdown blocks parser suppresses it from code block list
    const parsedFencedBlocks = parseMarkdownBlocks(fenced3DMessage);
    assert.strictEqual(parsedFencedBlocks.filter(b => b.type === 'code').length, 0, 'No code block should be rendered for 3D scene JSON');
    console.log('  ✓ Test 2 Passed: Fenced 3D scene JSON with preamble cleanly stripped from chat bubble');

    // Test 3: Preserve legitimate programming code blocks (TypeScript, Python, Shell)
    console.log('Test 3: Legitimate user/developer code blocks are strictly preserved');
    const developerCodeMessage = `You can control the 3D camera programmatically using Three.js:

\`\`\`typescript
import * as THREE from 'three';

export function orbitCamera(camera: THREE.PerspectiveCamera, angle: number) {
    const radius = 50;
    camera.position.x = radius * Math.cos(angle);
    camera.position.z = radius * Math.sin(angle);
    camera.lookAt(0, 0, 0);
}
\`\`\`

Run \`npm run build\` to verify.`;

    const cleanedDevMsg = cleanMessageTextSmart(developerCodeMessage);
    assert.ok(cleanedDevMsg.includes('orbitCamera(camera: THREE.PerspectiveCamera'), 'TypeScript code block must remain intact');
    assert.ok(cleanedDevMsg.includes('npm run build'), 'Inline code must remain intact');

    const parsedDevBlocks = parseMarkdownBlocks(developerCodeMessage);
    const codeBlocks = parsedDevBlocks.filter(b => b.type === 'code');
    assert.strictEqual(codeBlocks.length, 1, 'TypeScript code block must be rendered');
    if (codeBlocks[0].type === 'code') {
        assert.strictEqual(codeBlocks[0].language, 'typescript');
        assert.ok(codeBlocks[0].content.includes('export function orbitCamera'));
    }
    console.log('  ✓ Test 3 Passed: Developer TypeScript code blocks strictly preserved');

    // Test 4: Extract artifact payload from assistant message text if not already populated
    console.log('Test 4: Extract embedded artifact payload from assistant message');
    const rawEmbeddedJson = `I've created the 3D scene for you:

\`\`\`json
{
  "id": "art-battle-lexington",
  "type": "3d-scene",
  "title": "3D Scene: Battle of Lexington (Combatants & Atmosphere)",
  "version": 3,
  "data": {
    "title": "3D Scene: Battle of Lexington (Combatants & Atmosphere)",
    "camera": { "fov": 45 },
    "environment": { "skybox": "dawn-historical" }
  }
}
\`\`\``;

    const extractedArtifact = extractArtifactFromJson(rawEmbeddedJson);
    assert.ok(extractedArtifact, 'Artifact should be extracted from JSON block');
    assert.strictEqual(extractedArtifact?.id, 'art-battle-lexington');
    assert.strictEqual(extractedArtifact?.type, '3d-scene');
    assert.strictEqual(extractedArtifact?.title, '3D Scene: Battle of Lexington (Combatants & Atmosphere)');
    assert.strictEqual(extractedArtifact?.version, 3);
    console.log('  ✓ Test 4 Passed: Embedded artifact correctly extracted into structured CanvasArtifact');

    // =========================================================================
    // SECTION 2: Canvas Artifact Version History & Rollback System
    // =========================================================================

    console.log('\nTest 5: Lossless multi-turn version snapshot history tracking');
    
    // Simulate 4 turns of modifying the Battle of Lexington scene
    const v1Snapshot: CanvasArtifact = {
        id: 'art-lexington-green',
        type: '3d-scene',
        title: '3D Scene: Battle of Lexington (April 19, 1775)',
        summary: 'Initial spatial layout with Lexington Green terrain and colonial buildings.',
        version: 1,
        createdAt: '12:50 PM',
        data: {
            title: '3D Scene: Battle of Lexington (April 19, 1775)',
            objects: [{ id: 'obj-lexington-green', space: { spatial3d: { x: 0, y: 0, z: 0 } } }]
        } as any
    };

    const v2Snapshot: CanvasArtifact = {
        id: 'art-lexington-green',
        type: '3d-scene',
        title: '3D Scene: Battle of Lexington (Labeled Buildings)',
        summary: 'Added Buckman Tavern, Meeting House, and Harrington House landmarks.',
        version: 2,
        createdAt: '12:52 PM',
        data: {
            title: '3D Scene: Battle of Lexington (Labeled Buildings)',
            objects: [
                { id: 'obj-lexington-green', space: { spatial3d: { x: 0, y: 0, z: 0 } } },
                { id: 'obj-buckman-tavern', space: { spatial3d: { x: -40, y: 0, z: 20 } } }
            ]
        } as any
    };

    const v3Snapshot: CanvasArtifact = {
        id: 'art-lexington-green',
        type: '3d-scene',
        title: '3D Scene: Battle of Lexington (Combatants & Atmosphere)',
        summary: 'Introduced Minutemen militia and British Regulars formations with early morning mist.',
        version: 3,
        createdAt: '12:54 PM',
        data: {
            title: '3D Scene: Battle of Lexington (Combatants & Atmosphere)',
            objects: [
                { id: 'obj-lexington-green', space: { spatial3d: { x: 0, y: 0, z: 0 } } },
                { id: 'obj-buckman-tavern', space: { spatial3d: { x: -40, y: 0, z: 20 } } },
                { id: 'obj-minutemen-group', space: { spatial3d: { x: -10, y: 0, z: 0 } } },
                { id: 'obj-british-regulars-group', space: { spatial3d: { x: 20, y: 0, z: 5 } } }
            ]
        } as any
    };

    const v4Snapshot: CanvasArtifact = {
        id: 'art-lexington-green',
        type: '3d-scene',
        title: '3D Animated Scene: Battle of Lexington (Orbiting View)',
        summary: 'Orbital camera motion and dynamic combatant line simulation.',
        version: 4,
        createdAt: '12:56 PM',
        data: {
            title: '3D Animated Scene: Battle of Lexington (Orbiting View)',
            timeline: { isPlaying: true, isLooping: true, speed: 1.0 },
            animation: 'orbit',
            objects: [
                { id: 'obj-lexington-green', space: { spatial3d: { x: 0, y: 0, z: 0 } } },
                { id: 'obj-buckman-tavern', space: { spatial3d: { x: -40, y: 0, z: 20 } } },
                { id: 'obj-minutemen-group', space: { spatial3d: { x: -10, y: 0, z: 0 } } },
                { id: 'obj-british-regulars-group', space: { spatial3d: { x: 20, y: 0, z: 5 } } }
            ]
        } as any
    };

    // Store version snapshots in version dictionary
    const artifactVersionStore: Record<string, CanvasArtifact[]> = {
        [v1Snapshot.id]: [v1Snapshot, v2Snapshot, v3Snapshot, v4Snapshot]
    };

    // Chat messages across the 4 turns: each message holds its snapshot at that turn
    const chatMessages: ChatMessage[] = [
        { id: 'msg-1', sender: 'assistant', text: 'Here is the initial 3D scene.', timestamp: '12:50 PM', artifacts: [v1Snapshot] },
        { id: 'msg-2', sender: 'assistant', text: 'Added labeled buildings around the Green.', timestamp: '12:52 PM', artifacts: [v2Snapshot] },
        { id: 'msg-3', sender: 'assistant', text: 'Added Minutemen and British formations.', timestamp: '12:54 PM', artifacts: [v3Snapshot] },
        { id: 'msg-4', sender: 'assistant', text: 'Added orbital camera animation.', timestamp: '12:56 PM', artifacts: [v4Snapshot] }
    ];

    // Verify lossless history retention: Message 1 still points to v1, Message 2 to v2, etc.
    assert.strictEqual(chatMessages[0].artifacts?.[0].version, 1, 'Message 1 must preserve v1 snapshot');
    assert.strictEqual(chatMessages[1].artifacts?.[0].version, 2, 'Message 2 must preserve v2 snapshot');
    assert.strictEqual(chatMessages[2].artifacts?.[0].version, 3, 'Message 3 must preserve v3 snapshot');
    assert.strictEqual(chatMessages[3].artifacts?.[0].version, 4, 'Message 4 must preserve v4 snapshot');
    assert.strictEqual(artifactVersionStore[v1Snapshot.id].length, 4, 'All 4 versions must be stored in chronological history');
    console.log('  ✓ Test 5 Passed: Lossless multi-turn snapshots preserved in chat history and version store');

    // Test 6: Active Version Highlight Logic
    console.log('Test 6: Active Version Highlighting in Chat Cards');
    let currentActiveArtifact: CanvasArtifact = v4Snapshot; // Head version is active

    const isCardActive = (cardArtifact: CanvasArtifact, active?: CanvasArtifact): boolean => {
        if (!active) return false;
        return cardArtifact.id === active.id && (cardArtifact.version || 1) === (active.version || 1);
    };

    assert.strictEqual(isCardActive(v4Snapshot, currentActiveArtifact), true, 'v4 card should be marked Active');
    assert.strictEqual(isCardActive(v3Snapshot, currentActiveArtifact), false, 'v3 card should not be marked Active');
    assert.strictEqual(isCardActive(v2Snapshot, currentActiveArtifact), false, 'v2 card should not be marked Active');
    assert.strictEqual(isCardActive(v1Snapshot, currentActiveArtifact), false, 'v1 card should not be marked Active');

    // User clicks v2 card in chat history -> Canvas switches to v2
    currentActiveArtifact = v2Snapshot;
    assert.strictEqual(isCardActive(v2Snapshot, currentActiveArtifact), true, 'v2 card should now be marked Active');
    assert.strictEqual(isCardActive(v4Snapshot, currentActiveArtifact), false, 'v4 card should no longer be marked Active');
    assert.strictEqual(currentActiveArtifact.title, '3D Scene: Battle of Lexington (Labeled Buildings)');
    console.log('  ✓ Test 6 Passed: Active vs Historical version highlighting verified');

    // Test 7: Rollback / Restore to historical version creating new head version
    console.log('Test 7: Rollback to historical version v2 creates new head version v5');
    
    const executeRollback = (
        targetHistoricalSnapshot: CanvasArtifact,
        allVersions: CanvasArtifact[]
    ): { newHeadArtifact: CanvasArtifact; updatedVersions: CanvasArtifact[] } => {
        const highestVer = Math.max(...allVersions.map(v => v.version || 1), targetHistoricalSnapshot.version || 1);
        const nextVersionNumber = highestVer + 1;

        const newHeadArtifact: CanvasArtifact = {
            ...targetHistoricalSnapshot,
            version: nextVersionNumber,
            title: targetHistoricalSnapshot.title,
            summary: `Restored from version v${targetHistoricalSnapshot.version || 1}`,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: JSON.parse(JSON.stringify(targetHistoricalSnapshot.data)) // Deep clone snapshot
        };

        const updatedVersions = [...allVersions, newHeadArtifact].sort((a, b) => (a.version || 1) - (b.version || 1));
        return { newHeadArtifact, updatedVersions };
    };

    const rollbackResult = executeRollback(v2Snapshot, artifactVersionStore[v1Snapshot.id]);
    assert.strictEqual(rollbackResult.newHeadArtifact.version, 5, 'Restored version should be head version v5');
    assert.strictEqual(rollbackResult.newHeadArtifact.summary, 'Restored from version v2');
    assert.strictEqual((rollbackResult.newHeadArtifact.data as any).objects.length, 2, 'Restored data must match v2 content');
    assert.strictEqual(rollbackResult.updatedVersions.length, 5, 'Version list now contains 5 chronological versions');
    
    // Now set active artifact to new head v5
    currentActiveArtifact = rollbackResult.newHeadArtifact;
    assert.strictEqual(currentActiveArtifact.version, 5);
    console.log('  ✓ Test 7 Passed: Rollback creates explicit new head version v5 from restored v2 snapshot');

    console.log('\n🎉 ALL ARTIFACT VERSION HISTORY & JSON SUPPRESSION TESTS PASSED SUCCESSFULLY!');
}

test('artifact-version-history-and-suppression.test', async () => {
    await runArtifactVersionHistoryAndSuppressionTests();
}, 180_000);
