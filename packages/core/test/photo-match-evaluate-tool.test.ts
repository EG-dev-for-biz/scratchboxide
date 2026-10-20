/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * photo_match_evaluate on a synthetic place: a textured street (ground, the target building, a neighbour) written as the
 * staged cache of a run would hold it (tile extraction, remesh with the isolate, run record and notes, a published layer),
 * the open scene's stagedBuild, and fakes only at the edges that would be billed or networked (pano discovery, the grounding
 * API, the edge registration worker, the judge). The "photos" are renders of the street from each requested view, so the raw
 * scan matches them and a wrongly textured build does not. Everything between (the build and used-pano resolution, view
 * selection, in-context rendering, pixel metrics, blind judging with reshuffles, grids, aggregation) is the real tool path.
 * Screenshots under test-results/screenshots/tool_photo_match/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jpeg from 'jpeg-js';
import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { readTileTriangles, decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { renderTriangles, PHOTO_MATCH_BACKGROUND, PHOTO_MATCH_CLAY, type JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import type { PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import {
    collectPanoIds, createPhotoMatchEvaluateHandler, visibleStagedLayers, PHOTO_MATCH_EVALUATE_TOOL, type HeldOutRegistration, type PhotoMatchDeps
} from '../src/node/gemini/tools/location-evidence/photo-match-evaluate';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { LOCATION_EVIDENCE_TOOL_DECLARATIONS } from '../src/node/gemini/tools/location-evidence-tools';
import type { ToolContext } from '../src/node/gemini/tools/types';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/tool_photo_match');
const RUN = 'a1b2c3d4';
const TILES_KEY = 'a'.repeat(64), REMESH_KEY = 'b'.repeat(64);
const PLACE = { lat: 40.7, lng: -74.0, formattedAddress: 'Synthetic Block, Test City' };

// ----------------------------------------------------------------------------------------------------------------
// a synthetic street as GLBs
// ----------------------------------------------------------------------------------------------------------------

interface Part { positions: number[]; uvs: number[]; indices: number[]; png?: Buffer; color?: [number, number, number] }

/** A box (four walls and a roof) on the ground at (cx, cz), w east-west, d north-south, h tall, each face UV 0..1. */
function box(cx: number, cz: number, w: number, d: number, h: number): Omit<Part, 'png' | 'color'> {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const quads: number[][][] = [
        [[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]], // north
        [[x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1]], // south
        [[x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]], // east
        [[x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1]], // west
        [[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]]  // roof
    ];
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (const q of quads) {
        const b = positions.length / 3;
        q.forEach(p => positions.push(...p));
        uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return { positions, uvs, indices };
}

function ground(size: number): Omit<Part, 'png' | 'color'> {
    const s = size / 2;
    return { positions: [-s, -0.02, -s, s, -0.02, -s, s, -0.02, s, -s, -0.02, s], uvs: [0, 0, 8, 0, 8, 8, 0, 8], indices: [0, 2, 1, 0, 3, 2] };
}

/** A facade texture: window rows in `wall` over `glass`, or plain stripes. */
function facadePng(wall: [number, number, number], glass: [number, number, number], size = 64): Buffer {
    const rgb = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const win = (x % 16) >= 5 && (x % 16) <= 11 && (y % 16) >= 4 && (y % 16) <= 11;
        const c = win ? glass : wall;
        rgb.set(c, (y * size + x) * 3);
    }
    return encodePng(size, size, rgb, 3);
}

function checkerPng(a: [number, number, number], b: [number, number, number], size = 32): Buffer {
    const rgb = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgb.set((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? a : b, (y * size + x) * 3);
    return encodePng(size, size, rgb, 3);
}

/** One GLB, one node per part (embedded PNG base colour, or a flat colour). */
function writeGlb(file: string, parts: Part[], extras?: Record<string, unknown>): void {
    const chunks: Buffer[] = [];
    let offset = 0;
    const json: any = { asset: { version: '2.0', ...(extras ? { extras } : {}) }, scene: 0, scenes: [{ nodes: parts.map((_, i) => i) }], nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], textures: [], images: [], samplers: [{ wrapS: 10497, wrapT: 10497 }], buffers: [] };
    const view = (buf: Buffer, target?: number) => {
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
        chunks.push(buf); offset += buf.length;
        return json.bufferViews.length - 1;
    };
    parts.forEach((p, i) => {
        const pos = Buffer.from(Float32Array.from(p.positions).buffer), uv = Buffer.from(Float32Array.from(p.uvs).buffer), idx = Buffer.from(Uint32Array.from(p.indices).buffer);
        const mn = [0, 1, 2].map(k => Math.min(...p.positions.filter((_, j) => j % 3 === k))), mx = [0, 1, 2].map(k => Math.max(...p.positions.filter((_, j) => j % 3 === k)));
        json.accessors.push({ bufferView: view(pos, 34962), componentType: 5126, count: p.positions.length / 3, type: 'VEC3', min: mn, max: mx });
        json.accessors.push({ bufferView: view(uv, 34962), componentType: 5126, count: p.uvs.length / 2, type: 'VEC2' });
        json.accessors.push({ bufferView: view(idx, 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
        let pbr: any;
        if (p.png) {
            json.images.push({ bufferView: view(p.png), mimeType: 'image/png' });
            json.textures.push({ source: json.images.length - 1, sampler: 0 });
            pbr = { baseColorTexture: { index: json.textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 };
        } else {
            pbr = { baseColorFactor: [...(p.color ?? [0.5, 0.5, 0.5]), 1], metallicFactor: 0, roughnessFactor: 1 };
        }
        json.materials.push({ pbrMetallicRoughness: pbr });
        json.meshes.push({ primitives: [{ attributes: { POSITION: i * 3, TEXCOORD_0: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
        json.nodes.push({ mesh: i });
    });
    const bin = Buffer.concat(chunks);
    json.buffers.push({ byteLength: bin.length });
    for (const k of ['images', 'textures']) if (!json[k].length) delete json[k];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assembleGlb(json, bin));
}

// ----------------------------------------------------------------------------------------------------------------
// the staged cache of one run, and the open scene
// ----------------------------------------------------------------------------------------------------------------

const TARGET = box(0, 0, 14, 12, 16);
const NEIGHBOUR = box(26, 0, 10, 10, 22);
const realFacade = facadePng([168, 92, 70], [40, 52, 70]);

function writeStagedRun(root: string): { scene: any; buildGlb: string; altGlb: string } {
    const sl = path.join(root, '.scratchbox', 'cache', 'staged_location');
    const tilesDir = path.join(sl, 'tiles', TILES_KEY);
    const street: Part[] = [
        { ...ground(260), png: checkerPng([110, 110, 105], [96, 96, 92]) },
        { ...TARGET, png: realFacade },
        { ...NEIGHBOUR, png: facadePng([200, 196, 186], [60, 70, 80]) }
    ];
    writeGlb(path.join(tilesDir, 'textured.glb'), street);
    writeGlb(path.join(tilesDir, 'geometry.glb'), street.map(p => ({ positions: p.positions, uvs: p.uvs, indices: p.indices, color: [0.5, 0.5, 0.5] as [number, number, number] })));
    fs.writeFileSync(path.join(tilesDir, 'done.json'), JSON.stringify({
        schema: 'scratchbox.stage-cache/1', stage: 'tiles', key: TILES_KEY, builtAtMs: 1, ms: 1, published: [],
        value: { texturedGlb: 'textured.glb', geometryGlb: 'geometry.glb', originEllipsoidalHeightM: -30, geoAnchor: { lat: PLACE.lat, lng: PLACE.lng } }
    }));
    const tr = path.join(root, '.scratchbox', 'cache', 'tile_refine', REMESH_KEY);
    writeGlb(path.join(tr, 'raw_clay.glb'), [{ ...TARGET, color: [0.55, 0.57, 0.6] }]);
    writeGlb(path.join(tr, 'clay.glb'), [{ ...TARGET, color: [0.55, 0.57, 0.6] }]);
    fs.mkdirSync(path.join(sl, 'remesh', REMESH_KEY), { recursive: true });
    fs.writeFileSync(path.join(sl, 'remesh', REMESH_KEY, 'done.json'), JSON.stringify({ schema: 'scratchbox.stage-cache/1', stage: 'remesh', key: REMESH_KEY, builtAtMs: 1, ms: 1, published: [], value: { clay: path.join(tr, 'clay.glb') } }));
    const runDir = path.join(sl, 'runs', RUN);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'stages.json'), JSON.stringify({ schema: 'scratchbox.staged-run/1', runId: RUN, request: { query: 'Synthetic Block', isolate: true }, place: PLACE, artifactId: `scene-stg-${RUN}`, keys: { tiles: TILES_KEY, remesh: REMESH_KEY }, statuses: {}, createdAtMs: 1 }));
    // the build registered the pano west of the block: it must never be held out
    fs.writeFileSync(path.join(runDir, 'edge_registration.json'), JSON.stringify({ panos: [{ panoId: 'USED_WEST', chosen: 'edges' }] }));
    // the build: the target with a wrong texture (a flat beige with no windows), and a second, closer version
    const models = path.join(root, 'public', 'models');
    const buildGlb = path.join(models, 'synthetic_iso_l2_tex_11111111.glb');
    writeGlb(buildGlb, [{ ...TARGET, png: checkerPng([214, 200, 160], [210, 196, 158]) }], { provenance: { source: `sv:USED_TEXTURE:90:0:60` } });
    const altGlb = path.join(models, 'synthetic_alt_22222222.glb');
    writeGlb(altGlb, [{ ...TARGET, png: facadePng([160, 96, 74], [44, 56, 72]) }]);
    const layer = (over: Record<string, unknown>) => ({ objectId: '', stage: 'remesh', layer: 'l2', order: 2, url: '', bytes: 1, provenance: {}, provenanceLabels: [], supersedes: [], revealAfter: [], reveal: { durationMs: 1, stagger: 0, crossfadeFrom: [] }, cached: false, builtAtMs: 1, counts: { vertices: 20, triangles: 10 }, ...over });
    const scene = {
        id: `scene-stg-${RUN}`, type: '3d-scene', title: 'Synthetic Block',
        data: {
            stagedBuild: {
                schema: 'scratchbox.staged-build/2', runId: RUN, requestKey: 'k', artifactId: `scene-stg-${RUN}`, place: { query: 'Synthetic Block', resolvedAddress: PLACE.formattedAddress, lat: PLACE.lat, lng: PLACE.lng },
                runState: 'finished', updatedAtMs: 1, stages: [], degradations: [], provenanceLegend: [], attribution: [],
                layers: [
                    layer({ objectId: 'stg-aaaaaaaa-l1', stage: 'tiles', layer: 'l1', url: '/models/synthetic_iso_tiles.glb' }),
                    layer({ objectId: 'stg-bbbbbbbb-l2', url: '/models/synthetic_iso_remesh.glb', supersedes: ['stg-aaaaaaaa-l1'], textured: { url: '/models/synthetic_iso_l2_tex_11111111.glb', bytes: 1, ladderRung: 0, rungShares: [1], provenance: [{ source: 'tile', label: 'photo-inferred', method: 'x', panoIds: ['USED_TEXTURE_2'], coverage: 1 }], confidenceChannels: '', builtAtMs: 1, cached: false } }),
                    layer({ objectId: 'stg-cccccccc-l9', layer: 'l9', url: '/models/retired.glb', retired: true })
                ]
            }
        }
    };
    return { scene, buildGlb, altGlb };
}

// ----------------------------------------------------------------------------------------------------------------
// fakes at the billed / networked edges
// ----------------------------------------------------------------------------------------------------------------

const PANOS: PanoCandidate[] = [
    { panoId: 'HELD_NORTH', lat: 0, lng: 0, date: '2025-06', copyright: '© Google', x: 0, z: -38 },
    { panoId: 'HELD_SOUTH', lat: 0, lng: 0, date: '2025-05', copyright: '© Google', x: 4, z: 34 },
    { panoId: 'HELD_SW', lat: 0, lng: 0, date: '2024-05', copyright: '© Google', x: -30, z: 30 },
    { panoId: 'USED_WEST', lat: 0, lng: 0, date: '2025-07', copyright: '© Google', x: -40, z: 0 },
    { panoId: 'HIDDEN_EAST', lat: 0, lng: 0, date: '2025-07', copyright: '© Google', x: 52, z: 0 }
];

function fakeDeps(root: string, opts: { panos?: PanoCandidate[]; unlocked?: string[]; judgeCalls?: { n: number } } = {}): PhotoMatchDeps {
    const street = readTileTriangles(fs.readFileSync(path.join(root, '.scratchbox/cache/staged_location/tiles', TILES_KEY, 'textured.glb')));
    const panos = opts.panos ?? PANOS;
    return {
        stagedRoot: () => root,
        discover: async () => panos,
        grounding: () => ({
            // the "photo": the street rendered from the requested view (the pano eye 2.5 m over the ground)
            retrieveGroundingImage: async req => {
                const p = panos.find(q => q.panoId === req.panoId)!;
                const W = 320, H = 240;
                const cam = castCamera({ eye: [p.x, 2.48, p.z], headingDeg: req.headingDegree, pitchDeg: -req.pitchDegree, fovDeg: req.fovDegree, widthPx: W, heightPx: H });
                const r = renderTriangles([street], cam, { supersample: 1 });
                const data = Buffer.from(r.rgba);
                return { image: Buffer.from(jpeg.encode({ data, width: W, height: H }, 92).data), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
            }
        }),
        register: async images => images.map((im): HeldOutRegistration => opts.unlocked?.includes(im.view.panoId)
            ? { panoId: im.view.panoId, edgeResidualPx: { prior: 6, edge: 9 }, reason: 'edges did not improve' }
            : { panoId: im.view.panoId, edgeResidualPx: { prior: 4, edge: 1.5 }, correction: { dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 }, reason: 'edges' }),
        judge: async () => fakeJudge(opts.judgeCalls)
    };
}

/**
 * Scores each render by its mean absolute difference from the photo (lower difference, higher score): blind to labels. Asked
 * for clay (the prompt says so), it scores shape only, by how well the render's sky (the clay background) matches the photo's
 * sky (the grey background the "photos" are rendered on): the silhouette, which texture cannot change.
 */
function fakeJudge(calls?: { n: number; clay?: number }): JudgeClient & { requested: string; answeredModel: string; skipped: [] } {
    const near = (img: { rgba: Uint8Array }, i: number, c: readonly number[]) => Math.abs(img.rgba[i] - c[0]) <= 8 && Math.abs(img.rgba[i + 1] - c[1]) <= 8 && Math.abs(img.rgba[i + 2] - c[2]) <= 8;
    return {
        requested: 'fake-judge', answeredModel: 'fake-judge', skipped: [],
        async generate(params) {
            if (calls) calls.n++;
            const imgs = params.contents[0].parts.filter(p => p.inlineData).map(p => decodeImageInMemory(Buffer.from(p.inlineData!.data, 'base64')));
            const [photo, ...renders] = imgs;
            if (/untextured grey clay/.test(params.contents[0].parts.map(p => p.text ?? '').join(' '))) {
                if (calls) calls.clay = (calls.clay ?? 0) + 1;
                const entries = renders.map((r, k) => {
                    let disagree = 0;
                    for (let i = 0; i < r.rgba.length; i += 4) if (near(photo, i, PHOTO_MATCH_BACKGROUND) !== near(r, i, PHOTO_MATCH_CLAY.background)) disagree++;
                    const s = Math.max(1, Math.min(10, Math.round(10 - 60 * disagree / (r.rgba.length / 4))));
                    return { image: k + 1, shape: s, note: `sky-based ${s}` };
                });
                return { model: 'fake-judge', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders: entries }) }] } }] } };
            }
            const renderEntries = renders.map((r, k) => {
                let d = 0;
                for (let i = 0; i < r.rgba.length; i += 4) d += Math.abs(r.rgba[i] - photo.rgba[i]) + Math.abs(r.rgba[i + 1] - photo.rgba[i + 1]) + Math.abs(r.rgba[i + 2] - photo.rgba[i + 2]);
                const s = Math.max(1, Math.min(10, Math.round(10 - d / (r.rgba.length / 4) / 6)));
                return { image: k + 1, shape: s, materials: s, detail: s, errors: s, overall: s, note: `diff-based ${s}` };
            });
            return { model: 'fake-judge', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders: renderEntries }) }] } }] } };
        }
    };
}

function ctxFor(root: string, scene?: unknown): ToolContext {
    return { request: { prompt: 'evaluate', ...(scene ? { activeArtifact: scene } : {}) } as any, workspaceRoot: root } as unknown as ToolContext;
}

// ----------------------------------------------------------------------------------------------------------------

describe('photo_match_evaluate tool', () => {
    let root: string;
    let staged: ReturnType<typeof writeStagedRun>;
    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'photo-match-tool-')));
        staged = writeStagedRun(root);
        fs.mkdirSync(SHOTS, { recursive: true });
    });
    afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('is registered in the default registry as a workspace tool with its schema', () => {
        const reg = createDefaultToolRegistry();
        expect(reg.has(PHOTO_MATCH_EVALUATE_TOOL)).toBe(true);
        const decl = reg.declarations(['workspace']).find(d => d.name === PHOTO_MATCH_EVALUATE_TOOL)!;
        expect(decl).toBeDefined();
        expect(decl.description).toMatch(/before telling the user it looks right/i);
        expect(Object.keys(decl.parameters!.properties!)).toEqual(expect.arrayContaining(['runId', 'glbs', 'anchor', 'arms', 'views', 'inContext', 'judgeModel', 'runs', 'clay']));
        expect(decl.description).toMatch(/uniform untextured clay/);
        expect(LOCATION_EVIDENCE_TOOL_DECLARATIONS.map(d => d.name)).toContain(PHOTO_MATCH_EVALUATE_TOOL);
    });

    it('finds every pano a record names and the layers a staged scene shows', () => {
        expect([...collectPanoIds({ a: { panoId: 'P1' }, b: [{ panoIds: ['P2', 'P3'] }], c: 'sv:P4:90:0:60', d: { panoId: '' } })].sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
        const vis = visibleStagedLayers(staged.scene.data.stagedBuild);
        expect(vis.map(l => l.layer)).toEqual(['l2']);
        // the trees layer only on request (the evaluator then draws one level per tree per view)
        const withTrees = { layers: [...staged.scene.data.stagedBuild.layers, { objectId: 't', stage: 'trees', layer: 'l5', order: 9, url: '/models/t.glb', counts: { triangles: 10 } } as any] };
        expect(visibleStagedLayers(withTrees).map(l => l.layer)).toEqual(['l2']);
        expect(visibleStagedLayers(withTrees, { trees: true }).map(l => l.layer)).toEqual(['l2', 'l5']);
    });

    it('evaluates the open staged scene in context against held-out views, never one the build used', async () => {
        const calls = { n: 0 };
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { judgeCalls: calls }));
        const progress: string[] = [];
        const out = await handler({ views: 3, runs: 2 }, { ...ctxFor(root, staged.scene), reportProgress: (m: string) => progress.push(m) } as ToolContext);
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        expect(r.inContext).toBe(true);
        expect(r.context).toMatch(/cut out/);
        // the used panos (registration note, scene provenance, GLB extras) are excluded; the east one is hidden by the neighbour
        expect(r.heldOut.usedByBuild).toBeGreaterThanOrEqual(3);
        const held = r.views.map((v: any) => v.panoId);
        expect(held.length).toBe(3);
        expect(held).not.toContain('USED_WEST');
        expect(held).not.toContain('HIDDEN_EAST');
        // two arms: the raw scan cut to the target (baseline) and the build's visible layer, its textured twin
        expect(r.arms.map((a: any) => a.id)).toEqual(['raw', 'build']);
        expect(r.arms[1].glbs[0]).toBe(staged.buildGlb);
        expect(r.arms[1].layers).toEqual([{ layer: 'l2', textured: true }]);
        expect(r.arms[0].triangles).toBe(10);
        // blind judgement with reshuffles: views x runs calls, textured and clay, stats per criterion with spread
        expect(calls.n).toBe(3 * 2 * 2);
        for (const id of ['raw', 'build']) for (const c of ['shape', 'materials', 'detail', 'errors', 'overall']) {
            const s = r.scores[id][c];
            expect(s.mean).toBeGreaterThanOrEqual(1);
            expect(s.mean).toBeLessThanOrEqual(10);
            expect(Number.isFinite(s.runSd) && Number.isFinite(s.viewSd)).toBe(true);
        }
        // the photo is the real street: the raw scan wins, the wrongly textured build loses (the judge saw no labels)
        expect(r.scores.raw.overall.mean).toBeGreaterThan(r.scores.build.overall.mean);
        for (const v of r.views) {
            expect(v.judge.stats.raw.overall.mean).toBeGreaterThanOrEqual(v.judge.stats.build.overall.mean);
            expect(v.pixel.raw.coverage).toBeGreaterThan(0.95);
            expect(v.pixel.raw.ssim).toBeGreaterThan(v.pixel.build.ssim);
            expect(fs.readFileSync(v.grid).subarray(1, 4).toString()).toBe('PNG');
            for (const f of Object.values(v.renders)) expect(fs.existsSync(f as string)).toBe(true);
        }
        expect(r.pixelMetrics.mean.raw.ssim).toBeGreaterThan(r.pixelMetrics.mean.build.ssim);
        expect(r.summary).toMatch(/held-out Street View photo/);
        expect(r.summary).toMatch(/RAW SCAN/);
        expect(fs.existsSync(path.join(r.outDir, 'report.json'))).toBe(true);
        expect(progress.some(m => /judged 3 of 3 views/.test(m))).toBe(true);
        r.grids.forEach((g: string, k: number) => fs.copyFileSync(g, path.join(SHOTS, `tool_photo_match_staged_view${k}.png`)));
        // the clay arm is on by default: shape only, every arm untextured, its own grids
        expect(r.clay).toBe(true);
        expect(r.clayJudged).toBe(3);
        expect(Object.keys(r.clayScores)).toEqual(['raw', 'build']);
        expect(r.clayScores.raw.shape.mean).toBeGreaterThanOrEqual(1);
        expect(r.clayScores.raw.materials).toBeUndefined();
        expect(r.clayGrids).toHaveLength(3);
        for (const v of r.views) {
            for (const f of Object.values(v.clayRenders)) expect(fs.existsSync(f as string)).toBe(true);
            expect(v.clayJudge.stats.build.shape.mean).toBeGreaterThanOrEqual(1);
        }
        expect(r.summary).toMatch(/Clay, untextured, shape only \(3 of 3 views\)/);
    }, 120_000);

    it('scores shape in clay where the texture hides it: a wrong height with the real texture loses, the right shape with a wrong texture wins', async () => {
        // B: the target 6 m too short, with the real facade texture; A: the right shape, wrongly textured
        const shortGlb = path.join(root, 'public', 'models', 'synthetic_short_33333333.glb');
        writeGlb(shortGlb, [{ ...box(0, 0, 14, 12, 10), png: realFacade }]);
        const calls = { n: 0, clay: 0 };
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { judgeCalls: calls }));
        const out = await handler({
            arms: [{ id: 'A', label: 'RIGHT SHAPE WRONG TEXTURE', runId: RUN, glbs: ['/models/synthetic_iso_l2_tex_11111111.glb'] }, { id: 'B', label: 'SHORT REAL TEXTURE', glbs: [shortGlb] }],
            views: 3, runs: 1
        }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        expect(calls.clay).toBe(3);
        // the raw scan is the true shape: in clay it and A tie at the top, B (6 m short) below both
        expect(r.clayScores.A.shape.mean).toBeGreaterThan(r.clayScores.B.shape.mean);
        expect(r.clayScores.raw.shape.mean).toBeGreaterThan(r.clayScores.B.shape.mean);
        // the clay renders carry no texture: A's clay render is the raw scan's
        const v0 = r.views[0];
        expect(fs.readFileSync(v0.clayRenders.A).equals(fs.readFileSync(v0.clayRenders.raw))).toBe(true);
        expect(fs.readFileSync(v0.renders.A).equals(fs.readFileSync(v0.renders.raw))).toBe(false);
        r.clayGrids.forEach((g: string, k: number) => fs.copyFileSync(g, path.join(SHOTS, `tool_photo_match_clay_view${k}.png`)));
        fs.copyFileSync(r.grids[0], path.join(SHOTS, 'tool_photo_match_clay_textured_view0.png'));

        // clay: false judges textured only
        const off = { n: 0, clay: 0 };
        const h2 = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { judgeCalls: off }));
        const out2 = await h2({ arms: [{ id: 'B', glbs: [shortGlb] }], views: 2, runs: 1, clay: false, anchor: { lat: PLACE.lat, lng: PLACE.lng }, isolateGlb: `.scratchbox/cache/tile_refine/${REMESH_KEY}/raw_clay.glb` }, ctxFor(root));
        const r2 = out2.resultPayload as any;
        expect(out2.status, JSON.stringify(r2).slice(0, 600)).toBe('completed');
        expect(off.clay).toBe(0);
        expect(off.n).toBe(2);
        expect(r2.clay).toBe(false);
        expect(r2.clayScores).toBeUndefined();
        expect(r2.views[0].clayRenders).toBeUndefined();
    }, 180_000);

    it('compares several builds at once (arms) from GLB paths in the run frame', async () => {
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root));
        const out = await handler({
            arms: [{ id: 'A', label: 'WRONG TEXTURE', runId: RUN, glbs: ['/models/synthetic_iso_l2_tex_11111111.glb'] }, { id: 'B', label: 'CLOSER TEXTURE', glbs: [staged.altGlb] }],
            views: 2, runs: 1, baseline: false
        }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        expect(r.arms.map((a: any) => a.id)).toEqual(['A', 'B']);
        expect(r.views.length).toBe(2);
        expect(r.scores.B.overall.mean).toBeGreaterThan(r.scores.A.overall.mean);
        fs.copyFileSync(r.grids[0], path.join(SHOTS, 'tool_photo_match_arms_view0.png'));
    }, 120_000);

    it('takes GLBs with an anchor, finding the cached extraction there', async () => {
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root));
        const out = await handler({ glbs: [staged.altGlb], anchor: { lat: PLACE.lat, lng: PLACE.lng }, isolateGlb: `.scratchbox/cache/tile_refine/${REMESH_KEY}/raw_clay.glb`, views: 1, runs: 1, place: 'Synthetic Block' }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        expect(r.reference).toBe('the cached extraction at the anchor');
        expect(r.origin.heightMeters).toBe(-30);
        expect(r.summary).toMatch(/Only 1 view could be judged/);
    }, 120_000);

    it('fails with typed errors and no scores when no view can be held out or registered', async () => {
        const onlyUsed = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { panos: PANOS.filter(p => p.panoId === 'USED_WEST' || p.panoId === 'HIDDEN_EAST') }));
        const a = await onlyUsed({}, ctxFor(root, staged.scene));
        expect(a.status).toBe('failed');
        expect((a.resultPayload as any).code).toBe('no_heldout_candidates');
        expect((a.resultPayload as any).scores).toBeUndefined();

        const calls = { n: 0 };
        const noneLock = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { unlocked: PANOS.map(p => p.panoId), judgeCalls: calls }));
        const b = await noneLock({}, ctxFor(root, staged.scene));
        expect((b.resultPayload as any).code).toBe('no_heldout_registered');
        expect((b.resultPayload as any).details.unregistered.length).toBeGreaterThan(0);
        expect(calls.n).toBe(0);

        const h = createPhotoMatchEvaluateHandler(() => fakeDeps(root));
        expect(((await h({ runId: 'ffffffff' }, ctxFor(root))).resultPayload as any).code).toBe('run_not_found');
        expect(((await h({ runId: RUN }, ctxFor(root))).resultPayload as any).code).toBe('run_layers_unknown');
        expect(((await h({ glbs: [staged.altGlb] }, ctxFor(root))).resultPayload as any).code).toBe('bad_arguments');
        expect(((await h({ glbs: [staged.altGlb], anchor: { lat: 1, lng: 2 } }, ctxFor(root))).resultPayload as any).code).toBe('missing_reference_tile');
        expect(((await h({}, ctxFor(root))).resultPayload as any).code).toBe('no_build');
    }, 120_000);

    it('dispatches through the default registry with the app\'s own services (no credentials: a typed failure, nothing billed)', async () => {
        const prev = process.env.SCRATCHBOX_ROOT;
        process.env.SCRATCHBOX_ROOT = root;
        try {
            const reg = createDefaultToolRegistry();
            const res = await reg.dispatch(PHOTO_MATCH_EVALUATE_TOOL, { runId: 'ffffffff' }, ctxFor(root));
            expect(res.exec.status).toBe('failed');
            expect((res.resultPayload as any).code).toBe('run_not_found');
        } finally {
            if (prev === undefined) delete process.env.SCRATCHBOX_ROOT; else process.env.SCRATCHBOX_ROOT = prev;
        }
    });
});
