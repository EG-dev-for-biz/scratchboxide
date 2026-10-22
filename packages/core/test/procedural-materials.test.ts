/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Library materials on the procedural district (surface-materials.ts, procedural-materials.ts): the colour of a surface
 * is measured on its lit texels only; the vision model chooses among the colour ranking's leaders (and a reply naming
 * anything else falls back, labelled); the tint lands the entry on the measured colour; UVs are world-scale from the
 * entry's real size; the GLB embeds the colour, normal and metallic-roughness maps once per entry with the labels; the
 * ground splits by appearance, not by shade. A small library is written to a temp folder; no model is called.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { SURFACE_TEXTURE_SCHEMA, type SurfaceTextureEntry, type SurfaceTextureIndex } from '../src/common/spatial/surface-texture-library';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { linearToLab } from '../src/node/3d-engine/staged-location/texel-exposure';
import {
    buildLibraryMaterials, chooseSurfaceMaterials, litColour, scaleUv, surfaceLibraryFromDir, variationAt, worldUvMetres, VARIATION_PARAMS, type MeasuredColour, type SurfaceSubject
} from '../src/node/3d-engine/staged-location/surface-materials';
import { regionAt, segmentGround, writeLibraryGroundGlb, writeLibraryRoadsGlb } from '../src/node/3d-engine/staged-location/procedural-materials';
import { buildRoadMesh, type RoadStation, type RoadSurface } from '../src/node/3d-engine/staged-location/road-surfaces';
import { buildGroundSurface } from '../src/node/3d-engine/staged-location/procedural-ground';
import { hexTilingFragment } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stochasticTiling';
import { libraryFill } from '../src/node/3d-engine/staged-location/texture-library-fill';
import { addLibraryDetail } from '../src/node/3d-engine/staged-location/twin-library-detail';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { loadFillSpec, proceduralFillSpec } from '../src/node/3d-engine/staged-location/procedural-materials';
import { measuredColourField } from '../src/node/3d-engine/staged-location/surface-materials';
import { planarFrameFromAbove, planarFrameUv, type UniqueSurfaceTexture } from '../src/node/3d-engine/staged-location/surface-overrides';

const N = 16;
function jpegOf(rgb: (x: number, y: number) => [number, number, number]): Buffer {
    const data = Buffer.alloc(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const c = rgb(x, y); data.set([...c, 255], (y * N + x) * 4); }
    return Buffer.from(jpegJs.encode({ data, width: N, height: N }, 95).data);
}
const lin = (s: number) => SRGB8_TO_LINEAR[s];
function entry(id: string, srgb: [number, number, number], realSizeM: [number, number], appearance: string): SurfaceTextureEntry {
    const l = srgb.map(lin) as [number, number, number];
    return {
        id, maps: { color: `${id}/color.jpg`, normal: `${id}/normal.jpg`, roughness: `${id}/roughness.jpg` }, pixels: [N, N], realSizeM, sizeSource: 'test',
        colour: { meanLinearRgb: l, spreadLinearRgb: [0.01, 0.01, 0.01], meanLab: linearToLab(...l) as [number, number, number], spreadLab: [1, 1, 1], meanLuminance: 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] },
        surface: { normalSlopeMean: 0.1, heightRange: 0.5, reliefM: 0.01, roughnessMean: 0.8, roughnessSpread: 0.05, metallic: 0 },
        appearance, provenance: 'generated', source: { model: 'test', prompt: 'test', method: 'test' }
    };
}

function makeLibrary(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-surf-'));
    const surfaces = [
        entry('grey_slabs', [120, 120, 120], [2, 2], 'grey slabs in a grid'),
        entry('dark_tarmac', [70, 70, 72], [1.8, 1.8], 'dark tarmac with fine aggregate'),
        entry('green_lawn', [80, 130, 60], [1.2, 1.2], 'mown lawn'),
        entry('red_brick', [150, 80, 60], [1.4, 1.4], 'red brick in stretcher bond')
    ];
    for (const e of surfaces) {
        fs.mkdirSync(path.join(dir, e.id), { recursive: true });
        const [r, g, b] = e.colour.meanLinearRgb.map(v => Math.round(255 * Math.pow(v, 1 / 2.2)));
        fs.writeFileSync(path.join(dir, e.maps.color), jpegOf(() => [r, g, b]));
        fs.writeFileSync(path.join(dir, e.maps.normal), jpegOf(() => [128, 128, 255]));
        fs.writeFileSync(path.join(dir, e.maps.roughness), jpegOf(() => [204, 204, 204]));
    }
    const index: SurfaceTextureIndex = { schema: SURFACE_TEXTURE_SCHEMA, about: 'test', conventions: {}, surfaces };
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    return dir;
}

const measured = (srgb: [number, number, number]): MeasuredColour => {
    const l = srgb.map(lin) as [number, number, number];
    return { linearRgb: l, lab: linearToLab(...l) as [number, number, number], texels: 100, of: 100, shadowSplit: false, method: 'test' };
};
const subject = (key: string, srgb: [number, number, number]): SurfaceSubject => ({ key, view: 'test', image: { bytes: new Uint8Array(jpegOf(() => srgb)), mimeType: 'image/jpeg', widthM: 10, heightM: 10 }, measured: measured(srgb) });
const reply = (text: string) => ({ response: { candidates: [{ content: { parts: [{ text }] } }] }, model: 'test-model', ms: 1, remember: () => undefined });

describe('measuring a surface on the tile photo', () => {
    it('keeps the lit texels of a half-shaded surface', () => {
        // a sandstone-coloured surface, 60% of it in a bluish shadow at a quarter of the light
        const lit: [number, number, number] = [200, 170, 120], shade: [number, number, number] = [60, 58, 62];
        const px = new Uint8Array(1000 * 4);
        for (let i = 0; i < 1000; i++) px.set([...(i % 10 < 6 ? shade : lit), 255], i * 4);
        const c = litColour(px)!;
        expect(c.shadowSplit).toBe(true);
        expect(c.texels).toBeLessThanOrEqual(400);
        const want = linearToLab(...(lit.map(lin) as [number, number, number]));
        expect(Math.abs(c.lab[0] - want[0])).toBeLessThan(1.5);
        expect(Math.abs(c.lab[2] - want[2])).toBeLessThan(1.5);
    });

    it('leaves a uniformly lit surface as one population', () => {
        const px = new Uint8Array(400 * 4);
        for (let i = 0; i < 400; i++) px.set([120 + (i % 7), 120, 118, 255], i * 4);
        const c = litColour(px)!;
        expect(c.shadowSplit).toBe(false);
        expect(c.lab[0]).toBeGreaterThan(48);
    });
});

describe('choosing an entry', () => {
    const lib = surfaceLibraryFromDir(makeLibrary());

    it('takes the vision model\'s pick among the colour ranking\'s leaders', async () => {
        const chain = { generate: async () => reply('{"choices":[{"surface":1,"id":"dark_tarmac","confidence":0.8,"why":"aggregate"},{"surface":2,"id":"green_lawn"}]}') };
        const out = await chooseSurfaceMaterials({ library: lib.index, subjects: [subject('a', [110, 110, 110]), subject('b', [90, 140, 70])], chain: chain as never });
        expect(out[0]).toMatchObject({ key: 'a', entryId: 'dark_tarmac', by: 'vision', model: 'test-model', confidence: 0.8 });
        expect(out[0].candidates).toContain('dark_tarmac');
        expect(out[1]).toMatchObject({ entryId: 'green_lawn', by: 'vision' });
    });

    it('falls back to the nearest by colour, labelled, when the reply names no candidate or there is no model', async () => {
        const chain = { generate: async () => reply('{"choices":[{"surface":1,"id":"marble_floor"}]}') };
        const [a] = await chooseSurfaceMaterials({ library: lib.index, subjects: [subject('a', [150, 82, 62])], chain: chain as never }, { candidates: 2, perCall: 4, concurrency: 1, deadlineMs: 1000 });
        expect(a.by).toBe('colour-rank');
        expect(a.entryId).toBe('red_brick');
        expect(a.reason).toMatch(/marble_floor, not a candidate/);
        const [b] = await chooseSurfaceMaterials({ library: lib.index, subjects: [subject('b', [85, 135, 62])], unavailable: 'no credentials' });
        expect(b).toMatchObject({ entryId: 'green_lawn', by: 'colour-rank' });
        expect(b.reason).toMatch(/no credentials/);
    });
});

describe('tint, UVs and the GLB', () => {
    const lib = surfaceLibraryFromDir(makeLibrary());

    it('tints an entry onto the measured colour, the colour field\'s mean divided out', () => {
        const want: [number, number, number] = [0.3, 0.2, 0.1];
        const e = lib.entry('grey_slabs')!;
        const tint = want.map((w, k) => w / e.colour.meanLinearRgb[k]) as [number, number, number];
        const set = buildLibraryMaterials(lib, [{ name: 'm', entryId: 'grey_slabs', tint, extras: {} }]);
        const m = set.materials[0];
        // the embedded colour map times the factor times the field's mean gives back the measured colour
        const img = jpegJs.decode(Buffer.from(m.baseColor!.bytes), { useTArray: true });
        const mid = (8 * img.width + 8) * 4;
        for (let k = 0; k < 3; k++) expect(lin(img.data[mid + k]) * m.baseColorFactor![k] * VARIATION_PARAMS.mean).toBeCloseTo(want[k], 1);
        expect(m.baseColorFactor!.every(f => f <= 1)).toBe(true);
        expect((m.extras as any).sbStochasticTiling.tileM).toEqual([2, 2]);
    });

    it('lays world-scale UVs: planar from above on the level, along and up a wall', () => {
        // a wall facing south (+z) 4 m wide, 3 m high; a 4 m square of ground
        const wall = Float32Array.from([0, 0, 0, 4, 0, 0, 4, 3, 0]);
        const uvW = scaleUv(worldUvMetres(wall, Uint32Array.from([0, 1, 2])), [2, 1.5]);
        expect(uvW[2] - uvW[0]).toBeCloseTo(2, 5);
        expect(uvW[5] - uvW[3]).toBeCloseTo(-2, 5);
        const ground = Float32Array.from([0, 0, 0, 0, 0, 4, 4, 0, 4]);
        const uvG = scaleUv(worldUvMetres(ground, Uint32Array.from([0, 1, 2])), [2, 2]);
        expect([uvG[2] - uvG[0], uvG[3] - uvG[1], uvG[4] - uvG[2]]).toEqual([0, 2, 2]);
        const v = variationAt(10, 0, 10);
        expect(v.every(c => c > 0.75 && c <= 1)).toBe(true);
    });

    it('writes the streets with embedded maps, metre UVs, the colour field and the labels', () => {
        const st = (x: number): RoadStation => ({ x, z: 0, tx: 1, tz: 0, nx: 0, nz: 1, profile: [0, 0, 0, 0, 0], left: { halfWidthM: 4, kerb: 'measured', kerbTopY: 0.15 }, right: { halfWidthM: 4, kerb: 'measured', kerbTopY: 0.15 }, samples: 10, shiftM: 0 });
        const road: RoadSurface = { id: 'r1', stations: Array.from({ length: 51 }, (_, i) => st(i * 2)), lengthM: 100, measuredKerbShare: 1, dropped: { noSurface: 0, aboveGround: 0, uneven: 0, noKerb: 0, underTree: 0 } };
        const mesh = buildRoadMesh([road], undefined, 'metres');
        const choice = (key: string, id: string) => ({ key, entryId: id, by: 'vision' as const, candidates: [id], model: 'test-model', measured: measured([90, 90, 92]) });
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-roads-')), 'roads.glb');
        const markings = { positions: Float32Array.from([0, 0.1, -0.1, 0, 0.1, 0.1, 10, 0.1, 0.1]), indices: Uint32Array.from([0, 1, 2]), colors: Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]) };
        writeLibraryRoadsGlb(file, mesh, markings, { carriageway: choice('roads:carriageway', 'dark_tarmac'), kerbs: choice('roads:kerbs', 'grey_slabs') }, lib, { test: true });
        const glb = parseGlbBytes(fs.readFileSync(file));
        const j = glb.json;
        // maps once per entry: two entries x (colour, normal, metallic-roughness) + the confidence pixel
        expect(j.images.length).toBe(7);
        for (const im of j.images.filter((i: any) => i.mimeType === 'image/jpeg')) {
            const v = j.bufferViews[im.bufferView];
            expect([glb.bin[v.byteOffset ?? 0], glb.bin[(v.byteOffset ?? 0) + 1]]).toEqual([0xff, 0xd8]);
        }
        const cw = j.nodes.find((n: any) => n.name === 'carriageway');
        const mat = j.materials[j.meshes[cw.mesh].primitives[0].material];
        expect(mat.normalTexture).toBeDefined();
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(mat.extras.sbSurfaceMaterial).toMatchObject({ provenance: 'generated', entryId: 'dark_tarmac', chosenBy: 'vision' });
        expect(mat.extras.sbSurfaceMaterial.measuredColour.label).toBe('measured');
        expect(typeof mat.extras.sbTexture.confidenceTexture).toBe('number');
        expect(cw.extras.sbSurfaceMaterial.entryId).toBe('dark_tarmac');
        const attrs = j.meshes[cw.mesh].primitives[0].attributes;
        expect(attrs.COLOR_0).toBeDefined();
        // u runs along the road: 100 m over a 1.8 m tile
        const uvAcc = j.accessors[attrs.TEXCOORD_0], uvView = j.bufferViews[uvAcc.bufferView];
        const uv = new Float32Array(glb.bin.buffer.slice(glb.bin.byteOffset + (uvView.byteOffset ?? 0), glb.bin.byteOffset + (uvView.byteOffset ?? 0) + uvView.byteLength));
        let umax = -Infinity, umin = Infinity, vmax = -Infinity, vmin = Infinity;
        for (let i = 0; i < uv.length; i += 2) { umax = Math.max(umax, uv[i]); umin = Math.min(umin, uv[i]); vmax = Math.max(vmax, uv[i + 1]); vmin = Math.min(vmin, uv[i + 1]); }
        expect(umax - umin).toBeCloseTo(100 / 1.8, 3);
        expect(vmax - vmin).toBeCloseTo(8 / 1.8, 3);
        const paint = j.nodes.find((n: any) => n.name === 'markings');
        expect(j.materials[j.meshes[paint.mesh].primitives[0].material].extras.sbSurfaceMaterial.provenance).toBe('vector-modelled');
    });
});

describe('the ground by appearance', () => {
    const lib = surfaceLibraryFromDir(makeLibrary());
    // 80 x 40 m at 0.1 m: grass in the west half, grey paving in the east; a building's shadow over a band of both
    const frame = { x0: 0, z0: 0, widthM: 80, heightM: 40 };
    const W = 800, H = 400, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const grass = x < 400, shade = y > 150 && y < 220 ? 0.35 : 1, grain = 1 + ((x * 7 + y * 13) % 11 - 5) / 60;
        const c = grass ? [80, 130, 60] : [140, 138, 132];
        rgba.set([c[0] * shade * grain, c[1] * shade * grain, c[2] * shade * grain, 255], (y * W + x) * 4);
    }
    const photo = { width: W, height: H, rgba, texelM: 0.1, triangles: 0, ms: 0 };

    it('splits the grass from the paving, not the shade from the sun', () => {
        const g = segmentGround(photo, frame, () => true);
        expect(g.regions.length).toBe(2);
        expect(g.stats.shadowedCells).toBeGreaterThan(0);
        const west = regionAt(g, 10, 10), east = regionAt(g, 70, 10);
        expect(west).not.toBe(east);
        expect(regionAt(g, 10, 18)).toBe(west);
        expect(regionAt(g, 70, 18)).toBe(east);
        // the region colours are the lit ones
        expect(g.regions[west].measured.lab[1]).toBeLessThan(-10);
        expect(g.regions[east].measured.lab[0]).toBeGreaterThan(50);
    });

    it('writes one primitive per region, each in its own library material', () => {
        const g = segmentGround(photo, frame, () => true);
        const surf = buildGroundSurface({ ground: { groundAt: () => 0, topAt: () => 0, cellMeters: 1 }, within: () => true, bounds: { x0: 0, z0: 0, x1: 80, z1: 40 } });
        const choices = new Map(g.regions.map((r, j) => [`ground:${j}`, { key: `ground:${j}`, entryId: r.measured.lab[1] < -10 ? 'green_lawn' : 'grey_slabs', by: 'vision' as const, candidates: [], measured: r.measured }]));
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ground-')), 'ground.glb');
        const out = writeLibraryGroundGlb(file, surf, g, choices, lib, {});
        expect(out.regions.map(r => r.entryId).sort()).toEqual(['green_lawn', 'grey_slabs']);
        const j = parseGlbBytes(fs.readFileSync(file)).json;
        expect(j.meshes[0].primitives.length).toBe(2);
        expect(new Set(j.meshes[0].primitives.map((p: any) => j.materials[p.material].extras.sbSurfaceMaterial.entryId))).toEqual(new Set(['green_lawn', 'grey_slabs']));
    });
});

describe('the viewport\'s hex-tiling patch', () => {
    it('replaces the colour, roughness, metalness and normal samples', () => {
        const src = ['#include <common>', 'void main() {', 'vec4 sampledDiffuseColor = texture2D( map, vMapUv );', 'vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );', 'vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );', 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', '}'].join('\n');
        const out = hexTilingFragment(src);
        expect(out).toContain('sbHexSetup( vMapUv )');
        expect(out).toContain('sbHexColour( map )');
        expect(out).toContain('sbHexBlend( roughnessMap )');
        expect(out).toContain('sbHexBlend( metalnessMap )');
        expect(out).toContain('transpose(sbHexQ1)');
        expect(out).not.toContain('texture2D( map, vMapUv )');
        expect(hexTilingFragment('void main() {}')).toBe('void main() {}');
    });
});

describe('the measured colour layer, the texture pass fill and unique textures', () => {
    const lib = surfaceLibraryFromDir(makeLibrary());

    it('carries the lit tone of the photo per vertex, the surface colour where a shadow lies', () => {
        // 40 x 10 m of grey paving, its east half a little warmer, a cast shadow over x 15..20
        const W = 400, H = 100, rgba = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const shade = x >= 150 && x < 200 ? 0.3 : 1, warm = x >= 200 ? 12 : 0;
            rgba.set([(130 + warm) * shade, 128 * shade, (124 - warm) * shade * 1.2, 255], (y * W + x) * 4);
        }
        const photo = { width: W, height: H, rgba, texelM: 0.1, triangles: 0, ms: 0 };
        const ref = measured([130, 128, 124]);
        const pos = Float32Array.from([5, 0, 5, 17.5, 0, 5, 35, 0, 5]);
        const f = measuredColourField(photo, { x0: 0, z0: 0, widthM: 40, heightM: 10 }, pos, () => ref);
        expect(f.shadowed).toBe(1);
        expect(f.measured).toBe(2);
        // the shaded vertex keeps the surface colour (1 / headroom), the warm one is redder than the plain one
        expect(f.colors[3]).toBeCloseTo(f.colors[0], 2);
        expect(f.colors[6] / f.colors[8]).toBeGreaterThan(f.colors[0] / f.colors[2] * 1.1);
    });

    it('fills the texels no photo reached from the chosen entry, per node and slope, labelled generated', () => {
        // a 4 x 2 atlas: texels 0-3 a wall of node "w:a", 4-7 a roof of the same node; texel 1 already has a photo texel
        const W = 4, H = 2, N = W * H;
        const atlas: any = { width: W, height: H, layerKey: 'l2m', maps: [{ nodeName: 'w:a' }], texels: {
            covered: new Uint8Array(N).fill(1), gutter: new Uint8Array(N), mapIndex: new Uint16Array(N),
            position: Float32Array.from({ length: N * 3 }, (_, i) => (i % 3 === 1 ? 2 : i * 0.1)),
            normal: Float32Array.from({ length: N * 3 }, (_, i) => { const t = Math.floor(i / 3); return t < 4 ? [0, 0, 1][i % 3] : [0, 1, 0][i % 3]; })
        } };
        const base: any = { layerKey: 'l2m', width: W, height: H, albedo: new Uint8Array(N * 4), confidence: { width: W, height: H, data: new Uint8Array(N * 4) }, provenance: [], degradations: [] };
        base.albedo.set([1, 2, 3, 255], 4);
        const choices = new Map([
            ['building:a:walls', { key: 'building:a:walls', entryId: 'red_brick', by: 'vision' as const, candidates: [], measured: measured([150, 80, 60]) }],
            ['building:a:roofs', { key: 'building:a:roofs', entryId: 'grey_slabs', by: 'vision' as const, candidates: [], measured: measured([120, 120, 120]) }]
        ]);
        const stored = proceduralFillSpec({ library: lib, choices, fallback: { walls: choices.get('building:a:walls')!, roofs: choices.get('building:a:roofs')! }, massing: { names: ['w:a'], buildingOf: ['a'] } });
        const spec = loadFillSpec(JSON.parse(JSON.stringify(stored)), lib);
        const out = libraryFill(atlas, base, spec);
        expect(out.filled).toBe(7);
        expect(out.albedo[1 * 4 + 3]).toBe(0);
        // a wall texel is brick-red, a roof texel grey
        expect(out.albedo[0]).toBeGreaterThan(out.albedo[2] + 40);
        expect(Math.abs(out.albedo[5 * 4] - out.albedo[5 * 4 + 2])).toBeLessThan(12);
        expect(out.confidence.data[0 * 4 + 2]).toBe(5);
        expect(out.provenance.every(p => p.label === 'generated')).toBe(true);
        expect(out.provenance.map(p => p.method).join(' ')).toMatch(/red_brick/);
    });

    it('lets a unique texture supersede the library on its surface, at its own planar UVs', () => {
        const g = segmentGround({ width: 200, height: 200, rgba: new Uint8Array(200 * 200 * 4).fill(130), texelM: 0.1, triangles: 0, ms: 0 }, { x0: 0, z0: 0, widthM: 20, heightM: 20 }, () => true);
        const surf = buildGroundSurface({ ground: { groundAt: () => 0, topAt: () => 0, cellMeters: 1 }, within: () => true, bounds: { x0: 0, z0: 0, x1: 20, z1: 20 } });
        const choices = new Map([['ground:0', { key: 'ground:0', entryId: 'grey_slabs', by: 'vision' as const, candidates: [], measured: g.regions[0].measured }]]);
        const unique: UniqueSurfaceTexture = { surface: 'ground:0', baseColor: { bytes: new Uint8Array(jpegOf(() => [10, 200, 10])), mimeType: 'image/jpeg' }, frame: planarFrameFromAbove(0, 0, 20, 20), provenance: { label: 'generated', method: 'test', conditionedOn: 'the scan render of this surface' } };
        const uv = planarFrameUv(unique.frame, Float32Array.from([0, 0, 0, 20, 0, 20]));
        // u east, v south from the image's top (north) row
        expect(Array.from(uv).map(v => Math.abs(v))).toEqual([0, 0, 1, 1]);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-uniq-')), 'ground.glb');
        const out = writeLibraryGroundGlb(file, surf, g, choices, lib, {}, { overrides: new Map([['ground:0', unique]]) });
        expect(out.regions[0].unique).toBe(true);
        const j = parseGlbBytes(fs.readFileSync(file)).json;
        const mat = j.materials[j.meshes[0].primitives[0].material];
        expect(mat.extras.sbSurfaceMaterial).toMatchObject({ unique: true, provenance: 'generated', supersedes: { entryId: 'grey_slabs' } });
    });

    it('averages the entry over a texel\'s footprint (no aliasing on a coarse atlas)', () => {
        // a checker entry at 1 px = 1 cm; a texel 0.5 m wide takes its average
        const dir = makeLibrary();
        const check = Buffer.alloc(N * N * 4);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) check.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * N + x) * 4);
        fs.writeFileSync(path.join(dir, 'grey_slabs/color.jpg'), Buffer.from(jpegJs.encode({ data: check, width: N, height: N }, 100).data));
        const l2 = surfaceLibraryFromDir(dir);
        const atlas: any = { width: 2, height: 1, layerKey: 'g', maps: [{ nodeName: 'ground#0_0' }], texels: {
            covered: new Uint8Array([1, 1]), gutter: new Uint8Array(2), mapIndex: new Uint16Array(2), sizeM: Float32Array.from([0.5, 0.5]),
            position: Float32Array.from([0.03, 0, 0.07, 0.31, 0, 0.12]), normal: Float32Array.from([0, 1, 0, 0, 1, 0])
        } };
        const base: any = { layerKey: 'g', width: 2, height: 1, albedo: new Uint8Array(8), confidence: { width: 2, height: 1, data: new Uint8Array(8) }, provenance: [], degradations: [] };
        const spec = { entries: [{ id: 'grey_slabs', ...(() => { const im = jpegJs.decode(fs.readFileSync(path.join(dir, 'grey_slabs/color.jpg')), { useTArray: true }); return { width: im.width, height: im.height, rgba: im.data }; })(), realSizeM: [0.16, 0.16] as [number, number] }], uses: [{ entry: 0, tint: [1, 1, 1] as [number, number, number], key: 'ground:0' }], byNode: { ground: { wall: 0, level: 0 } } };
        const out = libraryFill(atlas, base, spec);
        // both texels: the checker's mean, not one of its black or white pixels
        for (const i of [0, 1]) expect(Math.abs(out.albedo[i * 4] - 188)).toBeLessThan(25);
    });

    it('lays the chosen entry\'s normal and roughness under a twin through TEXCOORD_1 at real size', () => {
        // a twin: one wall node (facing south, 4 x 3 m) with the photo texture on TEXCOORD_0 and a confidence extra
        const wall = { name: 'w:b1#0_0', positions: Float32Array.from([0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), uv: Float32Array.from([0, 1, 1, 1, 1, 0, 0, 0]) };
        const twin = writeStagedGlb([wall], { texture: { bytes: new Uint8Array(jpegOf(() => [90, 90, 90])), mimeType: 'image/jpeg' } });
        const spec = loadFillSpec(proceduralFillSpec({ library: lib, choices: new Map([['building:b1:walls', { key: 'building:b1:walls', entryId: 'red_brick', by: 'vision' as const, candidates: [], measured: measured([150, 80, 60]) }]]), fallback: { walls: { key: 'x', entryId: 'grey_slabs', by: 'colour-rank' as const, candidates: [], measured: measured([120, 120, 120]) }, roofs: { key: 'y', entryId: 'grey_slabs', by: 'colour-rank' as const, candidates: [], measured: measured([120, 120, 120]) } }, massing: { names: ['w:b1'], buildingOf: ['b1'] } }), lib);
        const r = addLibraryDetail(twin, spec, lib);
        expect(r.byEntry).toEqual({ red_brick: 1 });
        const g = parseGlbBytes(r.glb), j = g.json;
        const prim = j.meshes[0].primitives[0], mat = j.materials[prim.material];
        expect(mat.normalTexture.texCoord).toBe(1);
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture.texCoord).toBe(1);
        expect(mat.pbrMetallicRoughness.baseColorTexture.texCoord ?? 0).toBe(0);
        expect(mat.extras.sbSurfaceDetail.entryId).toBe('red_brick');
        const uv1 = readAccessor(g, prim.attributes.TEXCOORD_1).data;
        // 4 m along the wall over a 1.4 m tile
        expect(Math.abs(uv1[2] - uv1[0])).toBeCloseTo(4 / 1.4, 3);
        expect(Math.abs(uv1[5] - uv1[3])).toBeCloseTo(3 / 1.4, 3);
    });
});
