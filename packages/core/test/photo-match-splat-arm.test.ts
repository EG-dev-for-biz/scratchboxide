/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// photo_match_evaluate with a splat world as an arm: a synthetic street as the reference tile, the same street as a district
// GLB and as a splat world stored in the frame of another extraction (10 m east, 6 m north, 2 m up), moved back by its frame's
// anchor; the stand-ins at the billed edges are the tool test's (photo-match-evaluate-tool.test.ts): the "photos" are the
// street rendered from each pano, the registration locks, the judge scores by pixel difference.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jpeg from 'jpeg-js';
import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { readTileTriangles, decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { renderTriangles, type JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import type { PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import { createPhotoMatchEvaluateHandler, type HeldOutRegistration, type PhotoMatchDeps } from '../src/node/gemini/tools/location-evidence/photo-match-evaluate';
import type { ToolContext } from '../src/node/gemini/tools/types';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/tool_photo_match_splat');
const PLACE = { lat: 40.7, lng: -74.0 };
const ORIGIN_H = -30;
/** Where the splat world's own frame stands in the reference frame: east, up, south (m). */
const WORLD_AT: [number, number, number] = [10, 2, -6];

interface Face { corners: [number, number, number][]; color: [number, number, number] }

/** A box on the ground at (cx, cz): its four walls and roof as quads. */
function box(cx: number, cz: number, w: number, d: number, h: number, color: [number, number, number]): Face[] {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    return [
        [[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]], [[x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1]],
        [[x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]], [[x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1]],
        [[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]]
    ].map(corners => ({ corners: corners as [number, number, number][], color }));
}

const GROUND: Face = { corners: [[-150, -0.02, -150], [-150, -0.02, 150], [150, -0.02, 150], [150, -0.02, -150]], color: [0.42, 0.42, 0.4] };
// the target low enough that its roof line stands inside every view (an outline leaving the frame is not what this tests)
const STREET: Face[] = [GROUND, ...box(0, 0, 14, 12, 12, [0.66, 0.36, 0.27]), ...box(26, 0, 10, 10, 22, [0.78, 0.77, 0.73])];

/** One GLB, one node per face (a flat linear base colour), with `extras` at its top level. */
function writeGlb(file: string, faces: Face[], extras?: Record<string, unknown>): void {
    const chunks: Buffer[] = [];
    let offset = 0;
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: faces.map((_, i) => i) }], nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], buffers: [], ...(extras ? { extras } : {}) };
    const view = (buf: Buffer, target: number) => {
        json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
        chunks.push(buf); offset += buf.length;
        return json.bufferViews.length - 1;
    };
    faces.forEach((f, i) => {
        const p = f.corners.flat();
        const mn = [0, 1, 2].map(k => Math.min(...f.corners.map(c => c[k]))), mx = [0, 1, 2].map(k => Math.max(...f.corners.map(c => c[k])));
        json.accessors.push({ bufferView: view(Buffer.from(Float32Array.from(p).buffer), 34962), componentType: 5126, count: 4, type: 'VEC3', min: mn, max: mx });
        json.accessors.push({ bufferView: view(Buffer.from(Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]).buffer), 34962), componentType: 5126, count: 4, type: 'VEC2' });
        json.accessors.push({ bufferView: view(Buffer.from(Uint32Array.from([0, 1, 2, 0, 2, 3]).buffer), 34963), componentType: 5125, count: 6, type: 'SCALAR' });
        json.materials.push({ pbrMetallicRoughness: { baseColorFactor: [...f.color, 1], metallicFactor: 0, roughnessFactor: 1 } });
        json.meshes.push({ primitives: [{ attributes: { POSITION: i * 3, TEXCOORD_0: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
        json.nodes.push({ mesh: i });
    });
    const bin = Buffer.concat(chunks);
    json.buffers.push({ byteLength: bin.length });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assembleGlb(json, bin));
}

const toSrgb8 = (c: number) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/**
 * The faces as a splat world, as the surface layer makes one: flat splats in the face's plane (sigma 0.75 of the spacing
 * across it, 5 mm through it) every `spacing` m over each face, in the face's colour, written in a frame that stands at `at`
 * in the reference's (each position less `at`). The native .splat layout: position, scale (float32), RGBA8, the quaternion
 * x y z w in [-1, 1] -> [0, 255] that turns the splat's thin local z onto the face's normal.
 */
function writeSplatWorld(file: string, faces: Face[], at: readonly number[]): number {
    const h = Math.SQRT1_2;
    const out: Array<{ p: number[]; s: number[]; rgb: number[]; q: number[] }> = [];
    for (const f of faces) {
        const [a, b, , d] = f.corners;
        const u = [0, 1, 2].map(k => b[k] - a[k]), v = [0, 1, 2].map(k => d[k] - a[k]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]].map(Math.abs);
        // local z onto y (ground, roofs): a quarter turn about x; onto x (east and west walls): about y; z: none
        const q = n[1] >= n[0] && n[1] >= n[2] ? [-h, 0, 0, h] : n[0] >= n[2] ? [0, h, 0, h] : [0, 0, 0, 1];
        const lu = Math.hypot(...u), lv = Math.hypot(...v);
        // the walls and roofs as close as a real world's surface layer (a coarser spacing grows every edge by its blur)
        const spacing = f === GROUND ? 0.5 : 0.1;
        const nu = Math.ceil(lu / spacing), nv = Math.ceil(lv / spacing);
        const rgb = f.color.map(toSrgb8);
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
            out.push({ p: [0, 1, 2].map(k => a[k] + u[k] * (i / nu) + v[k] * (j / nv) - at[k]), s: [spacing * 0.75, spacing * 0.75, 0.005], rgb, q });
        }
    }
    const buf = Buffer.alloc(out.length * 32);
    out.forEach((s, i) => {
        const o = i * 32;
        for (let k = 0; k < 3; k++) { buf.writeFloatLE(s.p[k], o + k * 4); buf.writeFloatLE(s.s[k], o + 12 + k * 4); }
        buf[o + 24] = s.rgb[0]; buf[o + 25] = s.rgb[1]; buf[o + 26] = s.rgb[2]; buf[o + 27] = 255;
        s.q.forEach((c, k) => { buf[o + 28 + k] = Math.round((c + 1) / 2 * 255); });
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return out.length;
}

const PANOS: PanoCandidate[] = [
    { panoId: 'HELD_NORTH', lat: 0, lng: 0, date: '2025-06', copyright: '© Google', x: 0, z: -38 },
    { panoId: 'HELD_SOUTH', lat: 0, lng: 0, date: '2025-05', copyright: '© Google', x: 4, z: 34 },
    { panoId: 'HELD_SW', lat: 0, lng: 0, date: '2024-05', copyright: '© Google', x: -30, z: 30 }
];

function fakeDeps(root: string, tile: string): PhotoMatchDeps {
    const street = readTileTriangles(fs.readFileSync(tile));
    return {
        stagedRoot: () => root,
        discover: async () => PANOS,
        grounding: () => ({
            retrieveGroundingImage: async req => {
                const p = PANOS.find(q => q.panoId === req.panoId)!;
                const W = 320, H = 240;
                const cam = castCamera({ eye: [p.x, 2.48, p.z], headingDeg: req.headingDegree, pitchDeg: -req.pitchDegree, fovDeg: req.fovDegree, widthPx: W, heightPx: H });
                const r = renderTriangles([street], cam, { supersample: 1 });
                return { image: Buffer.from(jpeg.encode({ data: Buffer.from(r.rgba), width: W, height: H }, 92).data), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
            }
        }),
        register: async images => images.map((im): HeldOutRegistration => ({ panoId: im.view.panoId, edgeResidualPx: { prior: 4, edge: 1.5 }, correction: { dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 }, reason: 'edges' })),
        judge: async () => fakeJudge()
    };
}

/** Scores each render by its mean absolute difference from the photo (blind to labels); clay by the same difference. */
function fakeJudge(): JudgeClient & { requested: string; answeredModel: string; skipped: [] } {
    return {
        requested: 'fake-judge', answeredModel: 'fake-judge', skipped: [],
        async generate(params) {
            const imgs = params.contents[0].parts.filter(p => p.inlineData).map(p => decodeImageInMemory(Buffer.from(p.inlineData!.data, 'base64')));
            const [photo, ...renders] = imgs;
            const clay = /untextured grey clay/.test(params.contents[0].parts.map(p => p.text ?? '').join(' '));
            const entries = renders.map((r, k) => {
                let d = 0;
                for (let i = 0; i < r.rgba.length; i += 4) d += Math.abs(r.rgba[i] - photo.rgba[i]) + Math.abs(r.rgba[i + 1] - photo.rgba[i + 1]) + Math.abs(r.rgba[i + 2] - photo.rgba[i + 2]);
                const s = Math.max(1, Math.min(10, Math.round(10 - d / (r.rgba.length / 4) / 6)));
                return clay ? { image: k + 1, shape: s, note: `diff ${s}` } : { image: k + 1, shape: s, materials: s, detail: s, errors: s, overall: s, note: `diff ${s}` };
            });
            return { model: 'fake-judge', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders: entries }) }] } }] } };
        }
    };
}

const ctxFor = (root: string) => ({ request: { prompt: 'evaluate' } as any, workspaceRoot: root } as unknown as ToolContext);

describe('photo_match_evaluate: a splat world as an arm', () => {
    let root: string, tile: string, district: string, world: string, worldSplats: number;
    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'photo-match-splat-')));
        // the reference: the tile extraction cached at the place (its frame origin 30 m under the ellipsoid)
        const key = 'c'.repeat(64), dir = path.join(root, '.scratchbox', 'cache', 'staged_location', 'tiles', key);
        writeGlb(path.join(dir, 'textured.glb'), STREET);
        writeGlb(path.join(dir, 'geometry.glb'), STREET.map(f => ({ ...f, color: [0.5, 0.5, 0.5] as [number, number, number] })));
        fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify({
            schema: 'scratchbox.stage-cache/1', stage: 'tiles', key, builtAtMs: 1, ms: 1, published: [],
            value: { texturedGlb: 'textured.glb', geometryGlb: 'geometry.glb', originEllipsoidalHeightM: ORIGIN_H, geoAnchor: PLACE }
        }));
        tile = path.join(dir, 'textured.glb');
        district = path.join(root, 'public', 'models', 'district.glb');
        writeGlb(district, STREET);
        // the splat world, in the frame of its own extraction: the anchor WORLD_AT from the place, recorded in that GLB's extras
        const anchor = new LocalTangentPlane({ lat: PLACE.lat, lng: PLACE.lng, alt: ORIGIN_H }).toLatLng(WORLD_AT);
        const worldDir = path.join(root, 'public', 'tilesets', 'synthetic_world');
        const frameGlb = path.join(root, 'public', 'models', 'synthetic_world_clay.glb');
        writeGlb(frameGlb, [GROUND], { frame: 'x = east, y = up, z = south (metres)', anchor: { lat: anchor.lat, lng: anchor.lng, ellipsoidalHeightM: anchor.alt } });
        world = path.join(worldDir, 'fused.splat');
        worldSplats = writeSplatWorld(world, STREET, WORLD_AT);
        // the meta's own elevation is a height above sea level: not the frame's origin (it must not be read as one)
        fs.writeFileSync(path.join(worldDir, 'tileset.meta.json'), JSON.stringify({ anchor: { lat: anchor.lat, lng: anchor.lng, elevationMeters: 12.08 }, glbPath: frameGlb }));
        fs.mkdirSync(SHOTS, { recursive: true });
    });
    afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('moves the world from its own frame onto the reference\'s, labels it by the tile, and draws it where the district GLB stands', async () => {
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, tile));
        // M: the same world placed 4 m east of where it belongs (its origin given, moved), a decoy that must lose
        const at = new LocalTangentPlane({ lat: PLACE.lat, lng: PLACE.lng, alt: ORIGIN_H }).toLatLng([WORLD_AT[0] + 4, WORLD_AT[1], WORLD_AT[2]]);
        const out = await handler({
            arms: [
                { id: 'D', label: 'DISTRICT', glbs: [district], scope: 'place' },
                { id: 'S', label: 'SPLAT WORLD', splat: 'public/tilesets/synthetic_world/fused.splat' },
                { id: 'M', label: 'MOVED', splat: world, origin: { lat: at.lat, lng: at.lng, heightMeters: at.alt } }
            ],
            anchor: PLACE, views: 2, runs: 1
        }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 800)).toBe('completed');
        // the pictures first, so a failed check below still leaves them to look at
        r.views.forEach((v: any, k: number) => {
            fs.copyFileSync(v.grid, path.join(SHOTS, `splat_arm_view${k}.png`));
            fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `splat_arm_masks_view${k}.png`));
            fs.copyFileSync(v.clayGrid, path.join(SHOTS, `splat_arm_clay_view${k}.png`));
        });
        fs.writeFileSync(path.join(SHOTS, 'splat_arm_placement.json'), JSON.stringify(r.views.map((v: any) => ({ view: v.id, placement: v.placement })), null, 1));
        expect(r.arms.map((a: any) => [a.id, a.scope])).toEqual([['raw', 'target'], ['D', 'place'], ['S', 'place'], ['M', 'place']]);
        const S = r.arms[2].splat, M = r.arms[3].splat;
        // the frame from the extraction's GLB, never the meta's height above sea level
        expect(S.frame.source).toMatch(/synthetic_world_clay\.glb/);
        S.offsetM.forEach((v: number, k: number) => expect(Math.abs(v - WORLD_AT[k])).toBeLessThan(0.01));
        expect(M.offsetM[0]).toBeCloseTo(WORLD_AT[0] + 4, 1);
        expect(S.tiltRad).toBeLessThan(1e-5);
        expect(r.arms[2].triangles).toBe(worldSplats);
        // moved home, its street lies on the reference's and every splat finds a tile triangle; moved 4 m, its walls do not
        expect(Math.abs(S.groundGapM)).toBeLessThan(0.05);
        expect(S.unmatchedShare).toBeLessThan(0.01);
        expect(S.byLabel.target).toBeGreaterThan(50000);
        expect(S.byLabel.neighbours).toBeGreaterThan(50000);
        expect(M.unmatchedShare).toBeGreaterThan(S.unmatchedShare);
        expect(r.regions.armTriangles.S.ground).toBe(S.byLabel.ground);
        for (const v of r.views) {
            // the world reads as the tile does, region by region, nearly as the district GLB does; the moved one does not
            expect(v.regions.arms.D.frame.agreement, v.id).toBe(1);
            expect(v.regions.arms.S.frame.agreement, v.id).toBeGreaterThan(0.95);
            expect(v.regions.arms.M.frame.agreement, v.id).toBeLessThan(v.regions.arms.S.frame.agreement);
            // placement from the photo's edges: home within 2 px of the GLB (a splat world's edges are soft, its outermost
            // splats reaching past the face by a fraction of their spacing), the moved world well past that
            expect(v.placement.S, v.id).toBeTruthy();
            expect(v.placement.S.errorPx, v.id).toBeLessThan(v.placement.D.errorPx + 2);
            expect(v.placement.M.errorPx, v.id).toBeGreaterThan(v.placement.S.errorPx + 4);
            expect(fs.existsSync(v.renders.S)).toBe(true);
            expect(fs.existsSync(v.clayRenders.S)).toBe(true);
        }
        expect(r.scores.S.overall.mean).toBeGreaterThan(r.scores.M.overall.mean);
        expect(r.regions.arms).toMatch(/a splat world splat by splat/);
        // the scratch folder of the native renders is gone
        expect(fs.readdirSync(path.join(root, '.scratchbox', 'cache', 'photo_match')).filter(n => n.startsWith('splat_work_'))).toEqual([]);
    }, 240_000);

    it('refuses a splat world that is not this place\'s, mixed with a build, or with no frame to read', async () => {
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, tile));
        const far = new LocalTangentPlane({ lat: PLACE.lat, lng: PLACE.lng, alt: ORIGIN_H }).toLatLng([900, 0, 0]);
        const tooFar = await handler({ arms: [{ id: 'S', splat: world, origin: { lat: far.lat, lng: far.lng, heightMeters: far.alt } }], anchor: PLACE, views: 1, runs: 1 }, ctxFor(root));
        expect((tooFar.resultPayload as any).code).toBe('frame_mismatch');
        const mixed = await handler({ arms: [{ id: 'S', splat: world, glbs: [district] }], anchor: PLACE, views: 1, runs: 1 }, ctxFor(root));
        expect((mixed.resultPayload as any).code).toBe('bad_arguments');
        const bare = path.join(root, 'public', 'bare', 'world.splat');
        fs.mkdirSync(path.dirname(bare), { recursive: true });
        fs.copyFileSync(world, bare);
        const noFrame = await handler({ arms: [{ id: 'S', splat: bare }], anchor: PLACE, views: 1, runs: 1 }, ctxFor(root));
        expect((noFrame.resultPayload as any).code).toBe('bad_arguments');
        expect((noFrame.resultPayload as any).error ?? (noFrame.resultPayload as any).message).toMatch(/tileset\.meta\.json/);
    }, 120_000);
});
