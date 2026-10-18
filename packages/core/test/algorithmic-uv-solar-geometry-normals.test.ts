/**
 * Solar inverse de-lighting in AlgorithmicUvEngine.processGlb divides each baseColor texel by E(N), with N taken from
 * the mesh that samples the texel (rasterized into the image's UV space), never from the image's own gradient.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AlgorithmicUvEngine, SolarDelightingSunUnknownError } from '../src/node/spatial/AlgorithmicUvEngine';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { REPO_ROOT } from './helpers/requirements';

const SUN: [number, number, number] = [0.3, 0.8, 0.52];
const K = 0.3; // ambient-to-sun ratio the bake uses; the engine measures it
const UP: [number, number, number] = [0, 1, 0];
const SOUTH: [number, number, number] = [0, 0, 1];
const NORTH: [number, number, number] = [0, 0, -1];
const E = (n: [number, number, number]) => AlgorithmicUvEngine.computeSolarIrradiance(n, SUN, K);
const toSrgb = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/**
 * A roof quad (+Y), a south wall (+Z, oblique to the sun) and a north wall (-Z, turned away from it) sampling the left,
 * middle and right thirds of one 48x16 texture; no NORMAL.
 */
function roofAndWallGlb(texture: Buffer, instanced = true): Buffer {
    const positions = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, /* south */ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, /* north */ 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]);
    const t = 1 / 3, u = 2 / 3;
    const uvs = new Float32Array([0, 0, 0, 1, t, 1, t, 0, /* south */ t, 0, u, 0, u, 1, t, 1, /* north */ u, 0, 1, 0, 1, 1, u, 1]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
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
            { bufferView: 0, componentType: 5126, count: 12, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
            { bufferView: 1, componentType: 5126, count: 12, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 18, type: 'SCALAR' }
        ],
        bufferViews,
        buffers: [{ byteLength: bin.length }],
        images: [{ bufferView: 3, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }]
    };
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

/** One stone albedo lit by SUN in linear light: each third is lit by E of its face. */
function bakedTexture(): Buffer {
    const w = 48, h = 16, eMax = E(UP);
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = toSrgb(0.4 * E(x < 16 ? UP : x < 32 ? SOUTH : NORTH) / eMax);
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
    solarDelighting: { sunVector: SUN },
    generateNormalMaps: false, generateRoughnessMaps: false, generateAoMaps: false
};

describe('AlgorithmicUvEngine.processGlb solar de-lighting uses the mesh normals', () => {
    it('a roof and a wall sharing one texture come out at the same albedo, with the normals rasterized from the mesh', async () => {
        const input = bakedTexture();
        const before = decodePng(input);
        expect(before.data[4 * 4] - before.data[(8 * 48 + 40) * 4]).toBeGreaterThan(30);

        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: roofAndWallGlb(input), pbrDecomposition: solarOnly });
        expect(res.success).toBe(true);
        expect(res.solarDelightingApplied).toBe(true);
        const report = res.images[0];
        expect(report.albedoRewritten).toBe(true);
        expect(report.solarDelighting).toMatchObject({
            applied: true, normalSource: 'face-normals-from-positions', texelsWithGeometryNormal: 48 * 16,
            texelsWithConflictingNormals: 0, delitTexels: 48 * 16, paintedTexelsWithoutNormal: 0, clippedTexels: 0
        });
        expect(report.solarDelighting!.fit).toMatchObject({ status: 'fitted', charts: 1 });

        const after = decodePng(outputImage(res.outputGlbBuffer!, 0));
        for (let y = 1; y < 15; y++) {
            expect(Math.abs(after.data[(y * 48 + 4) * 4] - after.data[(y * 48 + 24) * 4])).toBeLessThanOrEqual(2);
            expect(Math.abs(after.data[(y * 48 + 4) * 4] - after.data[(y * 48 + 43) * 4])).toBeLessThanOrEqual(2);
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

    it('refuses to de-light a Google tile (Colosseum): the tiles carry no capture instant, and none is invented', async () => {
        const glbPath = path.join(REPO_ROOT, 'deploy/cloud-run/spatial-separator/assets/colosseum_rome_textured.glb');
        const glb = AlgorithmicUvEngine.parseGlb(fs.readFileSync(glbPath));
        expect(JSON.stringify(glb.json.asset ?? {})).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
        const run = AlgorithmicUvEngine.processGlb({
            inputGlbBuffer: fs.readFileSync(glbPath),
            pbrDecomposition: { ...solarOnly, solarDelighting: { latitude: 41.8902, longitude: 12.4922 } }
        });
        await expect(run).rejects.toBeInstanceOf(SolarDelightingSunUnknownError);
    }, 120_000);
});
