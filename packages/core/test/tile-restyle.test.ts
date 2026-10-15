/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile restyle: continuous fields and forms applied to a textured tile by the native engine
 * (scratchbox_tile_restyle.hpp via scripts/run_tile_restyle.cpp), written back with the
 * texture-preserving patcher. Runs the real CLI on a small textured GLB built here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileRestyleService } from '../src/node/3d-engine/tile-restyle-service';
import { parseGlb, readSceneGeometry, serializeGlb, type GlbDocument } from '../src/node/3d-engine/glb-geometry-patcher';
import { meshShapingHandlers } from '../src/node/gemini/tools/mesh-shaping-tools';

// 2x2 PNG, enough to prove the image bytes travel through untouched.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

/** A 40 m x 40 m textured ground grid (41 x 41 vertices) with a 6 m high box-shaped mound at +x. */
function buildTexturedTile(): GlbDocument {
    const n = 41, size = 40;
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = -size / 2 + (size * i) / (n - 1), z = -size / 2 + (size * j) / (n - 1);
        const y = x > 8 && x < 16 && Math.abs(z) < 4 ? 6 : 0;
        pos.push(x, y, z); nrm.push(0, 1, 0); uv.push(i / (n - 1), j / (n - 1));
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
    }
    const parts = [Float32Array.from(pos), Float32Array.from(nrm), Float32Array.from(uv), Uint32Array.from(idx)];
    const chunks: Buffer[] = [];
    const views: any[] = [];
    let offset = 0;
    for (const p of parts) {
        const b = Buffer.from(p.buffer);
        views.push({ buffer: 0, byteOffset: offset, byteLength: b.length });
        chunks.push(b);
        offset += b.length;
    }
    views.push({ buffer: 0, byteOffset: offset, byteLength: PNG.length });
    chunks.push(PNG);
    offset += PNG.length;
    const bin = Buffer.concat([...chunks, Buffer.alloc((4 - (offset % 4)) % 4)]);
    const count = n * n;
    return {
        bin,
        json: {
            asset: { version: '2.0' },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
            textures: [{ source: 0 }],
            images: [{ bufferView: 4, mimeType: 'image/png' }],
            accessors: [
                { bufferView: 0, componentType: 5126, count, type: 'VEC3', min: [-20, 0, -20], max: [20, 6, 20] },
                { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
                { bufferView: 2, componentType: 5126, count, type: 'VEC2' },
                { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' }
            ],
            bufferViews: views,
            buffers: [{ byteLength: bin.length }]
        } as any
    };
}

function imageBytes(doc: GlbDocument): Buffer {
    const v = (doc.json.bufferViews as any[])[(doc.json.images as any[])[0].bufferView];
    return doc.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
}

describe('tile restyle (native fields + forms, texture-preserving)', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_restyle_test_'));
    const input = path.join(work, 'tile.glb');
    const service = new TileRestyleService();

    beforeAll(async () => {
        fs.writeFileSync(input, serializeGlb(buildTexturedTile()));
        await service.ensureBinary();
    }, 600_000);
    afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

    it('terraces the mound inside the field, leaves the rest alone, adds forms and keeps the texture', async () => {
        const output = path.join(work, 'tile_restyled.glb');
        // Field over the mound (u = 0.6 is x = 12 m), forms: a fluted revolve ringed 4x and a tapered sweep.
        const result = await service.restyle({
            inputGlbPath: input,
            outputGlbPath: output,
            fields: [{ center: [0.6, 0], radiusMeters: 5, blendMeters: 0, terraceStepMeters: 4 }],
            forms: [
                { center: [-0.5, -0.5], profile: [[1, 0], [0.8, 5], [0.2, 6]], segments: 24, lobes: 6, lobeAmplitude: 0.1, replicate: { count: 4, ringRadiusMeters: 3 } },
                { center: [-0.5, 0.5], path: [[0, 0, 0], [0, 3, 1], [2, 5, 2]], radiusStartMeters: 0.4, radiusEndMeters: 0.1, sides: 8, twistTurns: 0.5 }
            ]
        });

        const before = parseGlb(fs.readFileSync(input));
        const after = parseGlb(fs.readFileSync(output));
        expect(fs.readFileSync(output).toString('latin1', 0, 4)).toBe('glTF');
        expect(imageBytes(after).equals(imageBytes(before))).toBe(true);

        // The tile's own vertices: 6 m mound tops quantise down to the 4 m terrace inside the radius only.
        const g0 = readSceneGeometry(before).positions;
        const tile = { ...after, json: { ...after.json, scenes: [{ nodes: [0] }] } };
        const g1 = readSceneGeometry(tile).positions;
        expect(g1.length).toBe(g0.length);
        let terraced = 0, movedOutside = 0;
        for (let i = 0; i < g0.length; i += 3) {
            const d = Math.hypot(g0[i] - 12, g0[i + 2]);
            if (d < 5 && g0[i + 1] === 6) { expect(g1[i + 1]).toBeCloseTo(4, 4); terraced++; }
            if (d > 5.01 && (g1[i] !== g0[i] || g1[i + 1] !== g0[i + 1] || g1[i + 2] !== g0[i + 2])) movedOutside++;
        }
        expect(terraced).toBeGreaterThan(10);
        expect(movedOutside).toBe(0);
        expect(result.movedVertices).toBe(terraced);

        // Forms: 4 ringed revolves + 1 sweep, appended as one extra root.
        expect(result.formMeshes).toBe(2);
        const revolveVerts = 4 * (3 * 25 + 2);
        const sweepVerts = 3 * 9;
        expect(result.formVertices).toBe(revolveVerts + sweepVerts);
        expect((after.json.scenes as any[])[0].nodes.length).toBe(2);
    }, 600_000);

    it('rejects non-numeric parameters before running anything', async () => {
        await expect(service.restyle({
            inputGlbPath: input,
            outputGlbPath: path.join(work, 'bad.glb'),
            fields: [{ center: [0, 0], radiusMeters: 'huge' as any }]
        })).rejects.toThrow(/must be numeric/);
        await expect(service.restyle({ inputGlbPath: input, outputGlbPath: path.join(work, 'none.glb') })).rejects.toThrow(/at least one/);
    });

    it('tile_restyle swaps the restyled GLB into the open scene', async () => {
        const modelsDir = path.join(process.cwd(), 'public', 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        const stem = `_test_restyle_${process.pid}_${Date.now()}`;
        const tilePath = path.join(modelsDir, `${stem}.glb`);
        fs.copyFileSync(input, tilePath);
        let written: string | undefined;
        try {
            const artifact: any = {
                id: 'scene-1', type: '3d-scene', title: 'Tile', version: 3,
                data: {
                    title: 'Tile',
                    objects: [{ id: 'tile', content: { type: '3d-scene', durableUri: `/models/${stem}.glb`, mimeType: 'model/gltf-binary', metadata: { role: 'environment' } } }]
                }
            };
            const outcome = await meshShapingHandlers.tile_restyle(
                { fields: [{ center: [0.6, 0], radiusMeters: 5, blendMeters: 0, offsetMeters: -1 }] },
                { request: { prompt: 'sink the mound', activeArtifact: artifact } } as any
            );
            expect(outcome.status).toBe('completed');
            const updated = (outcome.resultPayload as any).artifact;
            expect(updated.id).toBe('scene-1');
            expect(updated.version).toBe(4);
            const uri = updated.data.objects[0].content.durableUri as string;
            expect(uri).toMatch(new RegExp(`^/models/${stem}_restyled_\\d+\\.glb$`));
            expect(updated.data.objects[0].content.metadata.restyledFrom).toBe(`/models/${stem}.glb`);
            written = path.join(process.cwd(), 'public', uri);
            expect(fs.existsSync(written)).toBe(true);
            expect((outcome.resultPayload as any).movedVertices).toBeGreaterThan(0);
        } finally {
            fs.rmSync(tilePath, { force: true });
            if (written) fs.rmSync(written, { force: true });
        }
    }, 600_000);
});
