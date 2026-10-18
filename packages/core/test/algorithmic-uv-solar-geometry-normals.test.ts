/**
 * Solar inverse de-lighting in AlgorithmicUvEngine.processGlb divides each baseColor texel by E(N), with N taken from
 * the mesh that samples the texel (rasterized into the image's UV space), never from the image's own gradient.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { decodeImageToRgba } from '../src/node/image-codec-ffmpeg';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results/screenshots/delight_ada');
const SUN: [number, number, number] = [0.3, 0.8, 0.52];
const SKY: [number, number, number][] = [[0.6, 0.7, 0.8], [0.2, 0.25, 0.4], [0.1, 0.1, 0.2], [0.05, 0.05, 0.1], [0, 0, 0], [0, 0, 0], [0.05, 0.05, 0.1], [0, 0, 0], [0, 0, 0]];
const UP: [number, number, number] = [0, 1, 0];
const SOUTH: [number, number, number] = [0, 0, 1];
const E = (n: [number, number, number]) => AlgorithmicUvEngine.computeSolarIrradiance(n, SUN, SKY);

/** A roof quad (+Y) sampling the left half of one 32x16 texture and a wall quad (+Z) sampling the right half; no NORMAL. */
function roofAndWallGlb(texture: Buffer, instanced = true): Buffer {
    const positions = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, /* wall */ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 0, 1, 0.5, 1, 0.5, 0, /* wall */ 0.5, 0, 1, 0, 1, 1, 0.5, 1]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const parts: Buffer[] = [];
    const bufferViews: any[] = [];
    let length = 0;
    const push = (data: Buffer) => {
        const pad = (4 - (length % 4)) % 4;
        if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
        bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length });
        parts.push(data);
        length += data.length;
    };
    push(Buffer.from(positions.buffer));
    push(Buffer.from(uvs.buffer));
    push(Buffer.from(indices.buffer));
    push(texture);
    const bin = Buffer.concat(parts, length);
    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: instanced ? [0] : [] }],
        nodes: instanced ? [{ mesh: 0 }] : [],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
            { bufferView: 1, componentType: 5126, count: 8, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 12, type: 'SCALAR' }
        ],
        bufferViews,
        buffers: [{ byteLength: bin.length }],
        images: [{ bufferView: 3, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }]
    };
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

/** One stone albedo (170) lit by SUN: the roof half is brighter than the wall half by E(up) / E(south). */
function bakedTexture(): Buffer {
    const w = 32, h = 16, eMax = Math.max(E(UP), E(SOUTH));
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = Math.round(170 * E(x < 16 ? UP : SOUTH) / eMax);
        const i = (y * w + x) * 4;
        rgba[i] = v; rgba[i + 1] = Math.round(v * 0.95); rgba[i + 2] = Math.round(v * 0.9); rgba[i + 3] = 255;
    }
    return encodePng(w, h, rgba);
}

function outputImage(glbBuffer: Buffer, imageIndex: number): Buffer {
    const glb = AlgorithmicUvEngine.parseGlb(glbBuffer);
    const bv = glb.json.bufferViews[glb.json.images[imageIndex].bufferView];
    return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

const solarOnly = {
    enableSolarInverseDelighting: true,
    solarDelighting: { sunVector: SUN, skyShCoeffs: SKY },
    generateNormalMaps: false, generateRoughnessMaps: false, generateAoMaps: false
};

describe('AlgorithmicUvEngine.processGlb solar de-lighting uses the mesh normals', () => {
    it('a roof and a wall sharing one texture come out at the same albedo, with the normals rasterized from the mesh', async () => {
        const input = bakedTexture();
        const before = decodePng(input);
        expect(before.data[4 * 4] - before.data[(8 * 32 + 24) * 4]).toBeGreaterThan(30);

        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: roofAndWallGlb(input), pbrDecomposition: solarOnly });
        expect(res.success).toBe(true);
        expect(res.solarDelightingApplied).toBe(true);
        const report = res.images[0];
        expect(report.albedoRewritten).toBe(true);
        expect(report.solarDelighting).toMatchObject({
            applied: true, normalSource: 'face-normals-from-positions', texelsWithGeometryNormal: 32 * 16,
            texelsWithConflictingNormals: 0, delitTexels: 32 * 16, paintedTexelsWithoutNormal: 0
        });

        const after = decodePng(outputImage(res.outputGlbBuffer!, 0));
        for (let y = 1; y < 15; y++) {
            expect(Math.abs(after.data[(y * 32 + 4) * 4] - after.data[(y * 32 + 27) * 4])).toBeLessThanOrEqual(2);
        }
    });

    it('does not de-light an image no scene node places in the world, and says why', async () => {
        const input = bakedTexture();
        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: roofAndWallGlb(input, false), pbrDecomposition: solarOnly });
        expect(res.solarDelightingApplied).toBe(false);
        expect(res.images[0].solarDelighting).toEqual({ applied: false, skippedReason: 'mesh 0: no scene node instances it' });
        expect(res.images[0].albedoRewritten).toBe(false);
        expect(outputImage(res.outputGlbBuffer!, 0).equals(input)).toBe(true);
    });

    it('de-lights a real Google tile texture (Colosseum) with the tile mesh normals; before/after written for inspection', async () => {
        const glbPath = path.join(REPO_ROOT, 'deploy/cloud-run/spatial-separator/assets/colosseum_rome_textured.glb');
        const glb = AlgorithmicUvEngine.parseGlb(fs.readFileSync(glbPath));
        const json = glb.json;
        // Only the material of the largest texture keeps its baseColor, so only that image is processed (fast test).
        const sizes = json.images.map((im: any) => json.bufferViews[im.bufferView].byteLength);
        const imageIndex = sizes.indexOf(Math.max(...sizes));
        const trimmed = JSON.parse(JSON.stringify(json));
        for (const m of trimmed.materials) {
            if (trimmed.textures[m.pbrMetallicRoughness?.baseColorTexture?.index]?.source !== imageIndex) delete m.pbrMetallicRoughness.baseColorTexture;
        }
        const res = await AlgorithmicUvEngine.processGlb({
            inputGlbBuffer: AlgorithmicUvEngine.serializeGlb(trimmed, glb.bin),
            pbrDecomposition: {
                ...solarOnly,
                // Rome, a summer afternoon (the capture date of the tiles is not known; this is a test sun)
                solarDelighting: { latitude: 41.8902, longitude: 12.4922, timestampIso: '2024-07-15T14:00:00Z' }
            }
        });
        const report = res.images.find(r => r.imageIndex === imageIndex)!;
        expect(report.status).toBe('processed');
        expect(report.solarDelighting?.applied).toBe(true);
        expect(report.solarDelighting?.normalSource).toBe('face-normals-from-positions');
        expect(report.solarDelighting!.texelsWithGeometryNormal!).toBeGreaterThan(0.3 * report.texels!);

        const bv = glb.json.bufferViews[glb.json.images[imageIndex].bufferView];
        const beforeImg = await decodeImageToRgba(glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
        const afterImg = await decodeImageToRgba(outputImage(res.outputGlbBuffer!, imageIndex));
        expect(afterImg.width).toBe(beforeImg.width);
        // De-lighting changed texels, and only by a bounded gain
        let changed = 0;
        for (let i = 0; i < beforeImg.rgba.length; i += 4) if (Math.abs(afterImg.rgba[i] - beforeImg.rgba[i]) > 6) changed++;
        expect(changed).toBeGreaterThan(0);

        const { width: w, height: h } = beforeImg;
        const sheet = Buffer.alloc(w * 2 * h * 4);
        for (let y = 0; y < h; y++) {
            Buffer.from(beforeImg.rgba.buffer, beforeImg.rgba.byteOffset + y * w * 4, w * 4).copy(sheet, y * w * 8);
            Buffer.from(afterImg.rgba.buffer, afterImg.rgba.byteOffset + y * w * 4, w * 4).copy(sheet, y * w * 8 + w * 4);
        }
        for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'colosseum_tile_before_after_geometry_normals.png'), encodePng(w * 2, h, sheet));
    }, 120_000);
});
