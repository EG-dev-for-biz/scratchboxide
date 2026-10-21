import { test } from 'vitest';
import * as assert from 'assert';
import { morphScene3DToNodeGraph, parseGlbNodeHierarchy } from '../src/browser/generative-canvas/primitive-transformer-engine';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

/** Hand-builds a minimal valid binary glTF (.glb) with a named 2-mesh node hierarchy, no geometry/BIN chunk. */
function buildTestGlb(): string {
    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
            { name: 'Hull', mesh: 0, translation: [0, 0, 0], children: [1] },
            { name: 'Turret', mesh: 1, translation: [0, 1.2, 0] }
        ],
        meshes: [{ name: 'HullMesh' }, { name: 'TurretMesh' }]
    };
    const jsonText = JSON.stringify(json);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const paddedLength = Math.ceil(jsonBytes.length / 4) * 4;
    const jsonChunkBytes = new Uint8Array(paddedLength);
    jsonChunkBytes.set(jsonBytes);
    jsonChunkBytes.fill(0x20, jsonBytes.length); // pad with spaces per glTF spec

    const totalLength = 12 + 8 + jsonChunkBytes.length;
    const buf = new ArrayBuffer(totalLength);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true); // version
    dv.setUint32(8, totalLength, true);
    dv.setUint32(12, jsonChunkBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    new Uint8Array(buf, 20).set(jsonChunkBytes);

    return Buffer.from(buf).toString('base64');
}

test('parseGlbNodeHierarchy extracts a hand-built .glb node graph', () => {
    const glbBase64 = buildTestGlb();
    const parsed = parseGlbNodeHierarchy(glbBase64);
    assert.ok(parsed, 'should parse a valid .glb JSON chunk');
    assert.strictEqual(parsed!.nodes.length, 2);
    assert.strictEqual(parsed!.nodes[0].name, 'Hull');
    assert.strictEqual(parsed!.nodes[1].name, 'Turret');
    assert.deepStrictEqual(parsed!.rootNodeIndices, [0]);
});

test('morphScene3DToNodeGraph falls back to real .glb node decomposition when customMeshes is empty', () => {
    const scene: Scene3DData = {
        title: 'Rover',
        customMeshes: [],
        pythonGenerator: { enabled: true, glbBase64: buildTestGlb() }
    } as any;

    const graph = morphScene3DToNodeGraph(scene);
    const glbNodes = graph.nodes.filter(n => n.id.startsWith('glb-node-'));
    assert.strictEqual(glbNodes.length, 2,
        'should decompose the compiled .glb into real named nodes, not report 0 mesh nodes');
    const hullNode = glbNodes.find(n => n.label === 'Hull');
    assert.ok(hullNode, 'should use the real node name from the .glb, not a placeholder');
    assert.deepStrictEqual(hullNode!.parameters?.position, [0, 0, 0]);
    assert.strictEqual(hullNode!.parameters?.readOnly, true,
        'glb-decomposed nodes must be marked read-only since write-back cannot mutate compiled binary geometry yet');

    const hullToTurretEdge = graph.edges.find(e => e.source === 'glb-node-0' && e.target === 'glb-node-1');
    assert.ok(hullToTurretEdge, 'parent/child hierarchy from the .glb should produce a real edge, not a flat list');
});
