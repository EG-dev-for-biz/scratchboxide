import { test } from 'vitest';
import * as assert from 'assert';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type { CanvasArtifact, NodeGraphData } from '../src/browser/generative-canvas/canvas-types';

function stubCtx(activeArtifact: CanvasArtifact | undefined): any {
    return { request: { activeArtifact, prompt: '', chatHistory: [] } };
}

test('morph_canvas_primitive tool: converts the active 3d-scene into a real node-graph', async () => {
    const scene = synthesizeContextual3DScene('build me a 3d scene of the battle at lexington', {});
    assert.ok(scene.customMeshes && scene.customMeshes.length > 0);

    const activeArtifact: CanvasArtifact = {
        id: 'art-active-scene',
        type: '3d-scene',
        title: scene.title,
        summary: scene.subtitle || '',
        data: scene,
        createdAt: new Date().toISOString(),
        version: 1
    };

    const outcome: any = await canvasHandlers.morph_canvas_primitive(
        { targetType: 'node-graph' },
        stubCtx(activeArtifact)
    );

    assert.strictEqual(outcome.resultPayload.status, 'success');
    assert.strictEqual(outcome.resultPayload.primitiveType, 'node-graph');
    const graphData = outcome.resultPayload.artifact.data as NodeGraphData;
    const expectedMeshCount = scene.customMeshes!.length;
    const meshNodes = graphData.nodes.filter(n => n.id.startsWith('mesh-'));
    assert.strictEqual(meshNodes.length, expectedMeshCount,
        'tool should produce one real node per mesh, not a fixed/fake count');
    assert.strictEqual(graphData.sourceArtifact?.type, '3d-scene',
        'tool-produced graph should remember its source scene for write-back');
});

test('morph_canvas_primitive tool: fails cleanly with no active artifact, rather than crashing or faking success', async () => {
    const outcome: any = await canvasHandlers.morph_canvas_primitive(
        { targetType: 'node-graph' },
        stubCtx(undefined)
    );
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.resultPayload.status, 'error');
});
