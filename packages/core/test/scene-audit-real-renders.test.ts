import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { auditModelAgainstRequest } from '../src/node/3d-engine/visual-review';
import { canvasHandlers } from '../src/node/gemini/tools/canvas-tools';

/** A one-triangle GLB whose material base color is pure red. */
function redTriangleGlb(): Buffer {
    const pos = Buffer.alloc(36);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].flat().forEach((v, i) => pos.writeFloatLE(v, i * 4));
    const gltf = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
        buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }]
    };
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + 36, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.write('JSON', 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(36, 0); bh.write('BIN\0', 4);
    return Buffer.concat([header, jh, json, bh, pos]);
}

/** Count strongly red pixels in an 8-bit RGBA PNG made by our encoder. */
function redPixels(png: Buffer): number {
    const chunks: Buffer[] = []; let o = 8; let width = 0;
    while (o < png.length) {
        const len = png.readUInt32BE(o), type = png.toString('ascii', o + 4, o + 8);
        if (type === 'IHDR') width = png.readUInt32BE(o + 8);
        if (type === 'IDAT') chunks.push(png.subarray(o + 8, o + 8 + len));
        o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(chunks)); const rowLen = 1 + width * 4; let n = 0;
    for (let r = 0; r * rowLen < raw.length; r++) for (let x = 0; x < width; x++) {
        const p = r * rowLen + 1 + x * 4; if (raw[p] > 120 && raw[p + 1] < 40 && raw[p + 2] < 40) n++;
    }
    return n;
}

test('the audit sends four real renders in the model\'s own colors to the vision check', async () => {
    const soup = glbToTriangleSoup(redTriangleGlb())!;
    assert.deepStrictEqual(Array.from(soup.colors!.slice(0, 3)), [1, 0, 0]);
    let sent: Buffer[] = []; let prompt = '';
    const { result } = await auditModelAgainstRequest(soup, 'a white triangle', async (p, images) => {
        prompt = p; sent = images;
        return '{"verdict":"problems","checked":["one triangle"],"problems":[{"problem":"It is red, not white","confidence":"high"}]}';
    });
    assert.strictEqual(sent.length, 4);
    assert.ok(redPixels(sent[0]) > 100, 'the render shows the red material');
    assert.match(prompt, /a white triangle/);
    assert.deepStrictEqual(result.problems, [{ view: undefined, problem: 'It is red, not white' }]);
    assert.deepStrictEqual(result.checked, ['one triangle']);
});

test('the audit tool fails honestly when the scene has no model file', async () => {
    const out: any = await canvasHandlers.audit_3d_scene_viewport({ targetPrompt: 'a stool' }, {
        request: { prompt: 'audit', activeArtifact: { id: 'a', type: '3d-scene', title: 't', data: { objects: [] } } }
    } as any);
    assert.strictEqual(out.status, 'failed');
    assert.match(out.resultPayload.error, /No generated model file/);
});
