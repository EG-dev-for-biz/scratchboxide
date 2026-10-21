import { test } from 'vitest';
import * as assert from 'assert';
import { morphScene3DToNodeGraph } from '../src/browser/generative-canvas/primitive-transformer-engine';
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

test('morphScene3DToNodeGraph: a scene with no operatorStack at all shows zero operator nodes, not fabricated ones', () => {
    // A hand-built scene (as a real Python-script-generated scene looks on this
    // front: execute_3d_python_script never touches operatorStack) rather than
    // synthesizeContextual3DScene, which — a real discovery made while writing
    // this test — dispatches operators internally during its own construction,
    // so its fixtures start with real (non-empty) history already.
    const scene = { title: 'Rover', customMeshes: [{ id: 'm1', name: 'Body', type: 'box' as const, position: [0, 0, 0] as [number, number, number] }] };
    assert.ok(!scene.operatorStack, 'sanity check: this fixture has no operatorStack field at all');

    const graph = morphScene3DToNodeGraph(scene as any);
    const opNodes = graph.nodes.filter(n => n.id.startsWith('op-'));
    assert.strictEqual(opNodes.length, 0, 'a scene with no real edit history should show zero operator nodes, not fabricate any');
});

test('morphScene3DToNodeGraph: real operator dispatches become a real chronological DAG, linked to the mesh they touched', () => {
    const scene = synthesizeContextual3DScene('build me a 3d scene of the battle at lexington', {});
    const targetMesh = scene.customMeshes![0];
    const baselineOpCount = scene.operatorStack?.length ?? 0;

    const engine = createOperatorEngine(scene);
    engine.dispatch('sb_translate', { objectId: targetMesh.id, delta: [1, 0, 0] });
    engine.dispatch('sb_rotate', { objectId: targetMesh.id, delta: [0, 0.1, 0] });
    const editedScene = engine.getSceneData();

    assert.strictEqual(editedScene.operatorStack?.length, baselineOpCount + 2, 'both real dispatches should be appended to whatever history already existed');

    const graph = morphScene3DToNodeGraph(editedScene);
    const opNodes = graph.nodes.filter(n => n.id.startsWith('op-'));
    assert.strictEqual(opNodes.length, baselineOpCount + 2, 'should be one real node per real operator in the stack, not a placeholder count');

    const lastTwo = opNodes.slice(-2);
    assert.strictEqual(lastTwo[0].parameters?.operator, 'sb_translate');
    assert.strictEqual(lastTwo[1].parameters?.operator, 'sb_rotate');
    assert.ok(lastTwo[0].parameters?.readOnly, 'operator-history nodes must be marked read-only');

    const translateIdx = baselineOpCount;
    const rotateIdx = baselineOpCount + 1;
    const chainEdge = graph.edges.find(e => e.source === `op-${translateIdx}` && e.target === `op-${rotateIdx}`);
    assert.ok(chainEdge, 'operators should be chained in true execution order, not left as a disconnected list');

    const meshNodeId = `mesh-${targetMesh.id}`;
    const linkEdge = graph.edges.find(e => e.source === meshNodeId && e.target.startsWith('op-'));
    assert.ok(linkEdge, 'the first operator touching a mesh should link back to that real mesh node');

    assert.ok(graph.subtitle.includes(`${baselineOpCount + 2} edits in history`), 'subtitle should report the real edit count');
});

test('morphScene3DToNodeGraph: operator history nodes are read-only (write-back skips them)', () => {
    const scene = synthesizeContextual3DScene('build me a 3d scene of the battle at lexington', {});
    const targetMesh = scene.customMeshes![0];
    const engine = createOperatorEngine(scene);
    engine.dispatch('sb_translate', { objectId: targetMesh.id, delta: [1, 0, 0] });
    const editedScene = engine.getSceneData();

    const graph = morphScene3DToNodeGraph(editedScene);
    const opNodes = graph.nodes.filter(n => n.id.startsWith('op-'));
    const lastOpNode = opNodes[opNodes.length - 1];
    assert.strictEqual(lastOpNode.parameters?.operator, 'sb_translate');
    // Mirrors morphNodeGraphToScene3D's own meshId-resolution rule: an id that
    // doesn't start with "mesh-" and carries no parameters.meshId is skipped.
    assert.ok(!lastOpNode.id.startsWith('mesh-'));
    assert.strictEqual(lastOpNode.parameters?.meshId, undefined);
});
