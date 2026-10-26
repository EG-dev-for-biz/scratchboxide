/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * sb.read_glb (python/scratchbox/glb_read.py): a GLB written here by hand, one unit quad mesh used by two nodes, the second
 * a child of a parent translated (10, 0, 0) and itself rotated 90 degrees about y and scaled 2, comes back as two meshes in
 * world space (the child's corners where the transforms put them), named after their nodes, in their material's base
 * colour; a script can add to them and write them out again.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectVenvPython } from '../src/node/process/repo-python';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PYTHONPATH = [path.join(REPO_ROOT, 'packages/core/src/python'), path.join(REPO_ROOT, 'packages/core/src/native/3d-engine/build_py')].join(':');
const PY = process.env.SCRATCHBOX_PYTHON ?? projectVenvPython(REPO_ROOT);

/** A GLB of one quad (x, z in [0, 1], y = 0) used by node "base" and by node "child" under node "parent". */
function handMadeGlb(): Buffer {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const idx = new Uint16Array([0, 2, 1, 0, 3, 2]);
    const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
    const s = Math.SQRT1_2;
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
        nodes: [
            { name: 'base', mesh: 0 },
            { name: 'parent', translation: [10, 0, 0], children: [2] },
            { name: 'child', mesh: 0, rotation: [0, s, 0, s], scale: [2, 2, 2] }
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.125, 1] } }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] },
            { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }
        ]
    };
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + b.length, 8);
    jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([head, jh, js, bh, b]);
}

describe.skipIf(!PY)('sb.read_glb', () => {
    it('reads every mesh in world space, named after its node, in its base colour, and writes it back', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-read-glb-'));
        const src = path.join(dir, 'in.glb'), out = path.join(dir, 'out.glb'), script = path.join(dir, 'read.py');
        fs.writeFileSync(src, handMadeGlb());
        fs.writeFileSync(script, `
import json, sys
import scratchbox as sb
ms = sb.read_glb(sys.argv[1])
rows = []
for m in ms:
    b = m.bounds
    v = m.vertices[0]
    rows.append({"name": m.name, "tris": m.triangle_count, "min": [b.min.x, b.min.y, b.min.z], "max": [b.max.x, b.max.y, b.max.z], "colour": [v.color.x, v.color.y, v.color.z]})
box = sb.create_beveled_box(size=(1.0, 1.0, 1.0), bevel=0.05)
sb.write_glb(sys.argv[2], ms + [box])
again = sb.read_glb(sys.argv[2])
print(json.dumps({"meshes": rows, "again": len(again), "io": sb.io.read_glb is sb.read_glb}))
`);
        const r = JSON.parse(execFileSync(PY!, [script, src, out], { env: { ...process.env, PYTHONPATH }, encoding: 'utf8' }).trim().split('\n').pop()!);
        expect(r.meshes.map((m: { name: string }) => m.name)).toEqual(['base', 'child']);
        expect(r.meshes[0].min).toEqual([0, 0, 0]);
        expect(r.meshes[0].max).toEqual([1, 0, 1]);
        // the child: scaled 2, rotated 90 degrees about y (x -> -z, z -> x), then moved 10 along x
        const [mn, mx] = [r.meshes[1].min, r.meshes[1].max];
        expect(mn[0]).toBeCloseTo(10, 5); expect(mx[0]).toBeCloseTo(12, 5);
        expect(mn[2]).toBeCloseTo(-2, 5); expect(mx[2]).toBeCloseTo(0, 5);
        expect(r.meshes[1].tris).toBe(2);
        expect(r.meshes[0].colour).toEqual([0.5, 0.25, 0.125]);
        expect(r.again).toBe(3);
        expect(r.io).toBe(true);
    });
});
