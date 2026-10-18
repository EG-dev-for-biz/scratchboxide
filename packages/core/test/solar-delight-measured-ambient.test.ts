/**
 * Solar de-lighting with a measured ambient: the sun is the caller's (a vector, or a place and capture instant), the
 * ambient-to-sun ratio is fitted to the texture itself, and a fit the data cannot support changes nothing and says why.
 *
 * The box test bakes a textured box (one albedo distribution on all six faces, cross-unfolded into one chart) under a
 * known sun and an ambient-to-sun ratio the engine is not told, then checks that the de-lit albedo is the same on the
 * lit and the shaded faces. Before / after sheets go to test-results/screenshots/delight_measured/.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AlgorithmicUvEngine, SolarDelightingSunUnknownError } from '../src/node/spatial/AlgorithmicUvEngine';
import { fitSolarShading } from '../src/node/spatial/solar-shading-fit';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results/screenshots/delight_measured');
type V3 = [number, number, number];

const toLin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.min(1, c), 1 / 2.4) - 0.055));

/** Faces of the box: normal, in-plane axes, and the cell of the 4x3 cross layout they occupy. */
const FACES: Array<{ n: V3; u: V3; v: V3; cell: [number, number]; name: string }> = [
    { name: '+Y', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], cell: [1, 0] },
    { name: '-X', n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0], cell: [0, 1] },
    { name: '+Z', n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0], cell: [1, 1] },
    { name: '+X', n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0], cell: [2, 1] },
    { name: '-Z', n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0], cell: [3, 1] },
    { name: '-Y', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], cell: [1, 2] }
];
const CELL = 32, W = 4 * CELL, H = 3 * CELL;

function glbOf(texture: Buffer, faces: typeof FACES): Buffer {
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    faces.forEach((f, k) => {
        for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            for (let c = 0; c < 3; c++) pos.push(0.5 * f.n[c] + (s - 0.5) * f.u[c] + (t - 0.5) * f.v[c]);
            nor.push(...f.n);
            uv.push((f.cell[0] + s) * CELL / W, (f.cell[1] + t) * CELL / H);
        }
        idx.push(4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3);
    });
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
    push(Buffer.from(new Float32Array(pos).buffer));
    push(Buffer.from(new Float32Array(nor).buffer));
    push(Buffer.from(new Float32Array(uv).buffer));
    push(Buffer.from(new Uint16Array(idx).buffer));
    push(texture);
    const bin = Buffer.concat(parts, length);
    const nv = pos.length / 3;
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
            { bufferView: 1, componentType: 5126, count: nv, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: nv, type: 'VEC2' },
            { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' }
        ],
        bufferViews, buffers: [{ byteLength: bin.length }],
        images: [{ bufferView: 4, mimeType: 'image/png' }], textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.9 } }]
    };
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

/** Seeded textured albedo (linear), one distribution on every face; and the face index of each texel (-1 outside). */
function albedoField(): { albedo: Float64Array; face: Int8Array } {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const albedo = new Float64Array(W * H * 3), face = new Int8Array(W * H).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = FACES.findIndex(f => f.cell[0] === Math.floor(x / CELL) && f.cell[1] === Math.floor(y / CELL));
        const i = y * W + x;
        face[i] = k;
        // stone grain with blocky mottling: brightness 0.22..0.6, a warm tint
        const g = 0.22 + 0.38 * (0.6 * rnd() + 0.4 * (((x >> 3) * 7 + (y >> 3) * 13) % 5) / 4);
        albedo[i * 3] = g; albedo[i * 3 + 1] = g * 0.92; albedo[i * 3 + 2] = g * 0.8;
    }
    return { albedo, face };
}

function bake(albedo: Float64Array, face: Int8Array, sun: V3, k: number): Buffer {
    const rgba = Buffer.alloc(W * H * 4);
    const sl = Math.hypot(...sun);
    for (let i = 0; i < W * H; i++) {
        const f = face[i];
        const e = f < 0 ? 1 : Math.max(0, FACES[f].n[0] * sun[0] / sl + FACES[f].n[1] * sun[1] / sl + FACES[f].n[2] * sun[2] / sl) + k;
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = f < 0 ? 128 : toSrgb(albedo[i * 3 + c] * e / (1 + k));
        rgba[i * 4 + 3] = 255;
    }
    return encodePng(W, H, rgba);
}

function outputImage(glbBuffer: Buffer): Buffer {
    const glb = AlgorithmicUvEngine.parseGlb(glbBuffer);
    const bv = glb.json.bufferViews[glb.json.images[0].bufferView];
    return glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
}

/** Mean of observed / true linear luminance per face, over the inner texels of each cell (edges may hold conflicting normals). */
function faceRatios(rgba: Uint8Array, albedo: Float64Array, face: Int8Array): number[] {
    const sum = FACES.map(() => 0), cnt = FACES.map(() => 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, f = face[i];
        if (f < 0 || x % CELL < 2 || x % CELL > CELL - 3 || y % CELL < 2 || y % CELL > CELL - 3) continue;
        const obs = 0.2126 * toLin(rgba[i * 4]) + 0.7152 * toLin(rgba[i * 4 + 1]) + 0.0722 * toLin(rgba[i * 4 + 2]);
        const tru = 0.2126 * albedo[i * 3] + 0.7152 * albedo[i * 3 + 1] + 0.0722 * albedo[i * 3 + 2];
        sum[f] += obs / tru; cnt[f]++;
    }
    return sum.map((s, f) => s / cnt[f]);
}

const SUN: V3 = [0.35, 0.8, 0.48];
const K_TRUE = 0.2;
const solarOnly = (solarDelighting: any) => ({
    enableSolarInverseDelighting: true, solarDelighting,
    generateNormalMaps: false, generateRoughnessMaps: false, generateAoMaps: false
});

describe('solar de-lighting measures the ambient-to-sun ratio from the texture', () => {
    it('a textured box lit by a known sun and an unknown ambient comes out at one albedo on every face', async () => {
        const { albedo, face } = albedoField();
        const input = bake(albedo, face, SUN, K_TRUE);
        const before = faceRatios(decodePng(input).data, albedo, face);
        // the input really is lit: the shaded faces are several times darker than the sunlit top
        expect(Math.max(...before) / Math.min(...before)).toBeGreaterThan(4);

        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: glbOf(input, FACES), pbrDecomposition: solarOnly({ sunVector: SUN }) });
        expect(res.success).toBe(true);
        expect(res.solarDelightingApplied).toBe(true);
        expect(res.solarSunSource).toEqual({ kind: 'sun-vector' });
        const sd = res.images[0].solarDelighting!;
        expect(sd).toMatchObject({ applied: true, normalSource: 'vertex-normals', clippedTexels: 0 });
        expect(sd.fit!.status).toBe('fitted');
        const fit = sd.fit as Extract<typeof sd.fit, { status: 'fitted' }>;
        expect(Math.abs(fit.ambientToSun / K_TRUE - 1)).toBeLessThan(0.1);
        expect(fit.charts).toBe(1);

        const out = decodePng(outputImage(res.outputGlbBuffer!));
        const after = faceRatios(out.data, albedo, face);
        // recovered albedo / true albedo is the same on lit and shaded faces (within 4 %)
        const mean = after.reduce((a, b) => a + b, 0) / after.length;
        for (const r of after) expect(Math.abs(r / mean - 1)).toBeLessThan(0.04);

        // before / after sheet: input | de-lit | true albedo (scaled to the de-lit mean)
        const sheet = Buffer.alloc(W * 3 * H * 4);
        const inPx = decodePng(input).data;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            for (let c = 0; c < 3; c++) {
                sheet[(y * W * 3 + x) * 4 + c] = inPx[i * 4 + c];
                sheet[(y * W * 3 + W + x) * 4 + c] = out.data[i * 4 + c];
                sheet[(y * W * 3 + 2 * W + x) * 4 + c] = face[i] < 0 ? 128 : toSrgb(albedo[i * 3 + c] * mean);
            }
            for (let p = 0; p < 3; p++) sheet[(y * W * 3 + p * W + x) * 4 + 3] = 255;
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'synthetic_box_input_delit_truth.png'), encodePng(W * 3, H, sheet));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_box_face_ratios.json'), JSON.stringify({ faces: FACES.map(f => f.name), before, after, fit }, null, 2));
    }, 60_000);

    it('refuses without a sun: no vector, no capture instant, or a date with no time of day is a typed error', async () => {
        const { albedo, face } = albedoField();
        const glb = glbOf(bake(albedo, face, SUN, K_TRUE), FACES);
        for (const cfg of [undefined, {}, { latitude: 41.89, longitude: 12.49 }, { latitude: 41.89, longitude: 12.49, timestampIso: '2024-07' }]) {
            await expect(AlgorithmicUvEngine.processGlb({ inputGlbBuffer: glb, pbrDecomposition: solarOnly(cfg) })).rejects.toBeInstanceOf(SolarDelightingSunUnknownError);
        }
        // a place and capture instant gives the NOAA sun, and the result records it
        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: glb, pbrDecomposition: solarOnly({ latitude: 41.89, longitude: 12.49, timestampIso: '2024-07-15T10:00:00Z' }) });
        const src = res.images[0].solarDelighting!.sunSource!;
        expect(src).toMatchObject({ kind: 'noaa-ephemeris', latitude: 41.89, longitude: 12.49, timestampIso: '2024-07-15T10:00:00Z' });
        expect((src as any).elevationDeg).toBeGreaterThan(40);
    }, 60_000);

    it('skips with a recorded reason when the faces do not span lit and shaded orientations', async () => {
        // only the three sunlit faces: nothing turned away from the sun, so the ambient cannot be separated from albedo
        const { albedo, face } = albedoField();
        const lit = FACES.filter(f => ['+Y', '+Z', '+X'].includes(f.name));
        const input = bake(albedo, face, SUN, K_TRUE);
        const res = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: glbOf(input, lit), pbrDecomposition: solarOnly({ sunVector: SUN }) });
        const sd = res.images[0].solarDelighting!;
        expect(sd.applied).toBe(false);
        expect(sd.skippedReason).toMatch(/too few texels on charts that are seen both facing the sun and turned away from it \(0 shaded/);
        expect(sd.fit).toMatchObject({ status: 'skipped', shadedSamples: 0 });
        expect(res.solarDelightingApplied).toBe(false);
        expect(res.images[0].albedoRewritten).toBe(false);
        expect(outputImage(res.outputGlbBuffer!).equals(input)).toBe(true);
    }, 60_000);

    it('fitSolarShading refuses a ratio the data do not bound, and measures one they do', () => {
        // two charts, each one face: every chart sits in one N.L bin, so the albedo per chart absorbs the shading
        const n = 400;
        const lum = new Float64Array(n), cos = new Float64Array(n), group = new Int32Array(n);
        for (let i = 0; i < n; i++) { const lit = i < n / 2; cos[i] = lit ? 0.8 : 0; lum[i] = 0.3 * (cos[i] + 0.25); group[i] = lit ? 0 : 1; }
        const apart = fitSolarShading({ luminance: lum, cosSun: cos, group });
        expect(apart.status).toBe('skipped');
        // the same texels as one chart: k is measured
        group.fill(0);
        for (let i = 0; i < n / 4; i++) { cos[i] = 0.4; lum[i] = 0.3 * (0.4 + 0.25); }
        const together = fitSolarShading({ luminance: lum, cosSun: cos, group });
        expect(together.status).toBe('fitted');
        if (together.status === 'fitted') expect(together.ambientToSun).toBeCloseTo(0.25, 3);
    });
});
