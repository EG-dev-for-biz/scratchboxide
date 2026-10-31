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
 * selection, in-context rendering, pixel metrics, the regions from geometry, blind judging with reshuffles, grids, aggregation)
 * is the real tool path.
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
import { orthoReferenceCamera, orthoReferenceRecord, type OrthoReference } from '../src/node/3d-engine/staged-location/ortho-reference';
import { bearingDeg, type PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import {
    collectPanoIds, createPhotoMatchEvaluateHandler, heldOutViews, surfacesWithin, visibleStagedLayers, OPEN_PLACE_RADII_M, PHOTO_MATCH_EVALUATE_TOOL, type HeldOutRegistration, type PhotoMatchDeps
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

/** A tile extraction in the staged cache at `anchor` (the textured street and its grey geometry); returns the textured GLB. */
function writeTileAt(root: string, key: string, anchor: { lat: number; lng: number }, street: Part[]): string {
    const dir = path.join(root, '.scratchbox', 'cache', 'staged_location', 'tiles', key);
    writeGlb(path.join(dir, 'textured.glb'), street);
    writeGlb(path.join(dir, 'geometry.glb'), street.map(p => ({ positions: p.positions, uvs: p.uvs, indices: p.indices, color: [0.5, 0.5, 0.5] as [number, number, number] })));
    fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify({
        schema: 'scratchbox.stage-cache/1', stage: 'tiles', key, builtAtMs: 1, ms: 1, published: [],
        value: { texturedGlb: 'textured.glb', geometryGlb: 'geometry.glb', originEllipsoidalHeightM: -30, geoAnchor: anchor }
    }));
    return path.join(dir, 'textured.glb');
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

function fakeDeps(root: string, opts: { panos?: PanoCandidate[]; unlocked?: string[]; judgeCalls?: { n: number; clay?: number; regions?: number }; satellite?: boolean; street?: string } = {}): PhotoMatchDeps {
    const street = readTileTriangles(fs.readFileSync(opts.street ?? path.join(root, '.scratchbox/cache/staged_location/tiles', TILES_KEY, 'textured.glb')));
    const panos = opts.panos ?? PANOS;
    return {
        stagedRoot: () => root,
        // the "satellite": the street rendered straight down at the GSD of a zoom-19 Static Maps crop (512 px, scale 1)
        ...(opts.satellite ? {
            satelliteOrtho: async (): Promise<OrthoReference> => {
                const rec = orthoReferenceRecord({ lat: PLACE.lat, lng: PLACE.lng, zoom: 19, scale: 1, widthPx: 512, heightPx: 512 });
                const r = renderTriangles([street], orthoReferenceCamera(rec), { supersample: 1 });
                return { ...rec, bytes: encodePng(512, 512, r.rgba, 4), image: { width: 512, height: 512, rgba: r.rgba } };
            }
        } : {}),
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
function fakeJudge(calls?: { n: number; clay?: number; regions?: number }): JudgeClient & { requested: string; answeredModel: string; skipped: [] } {
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
            // asked for the place around the building too (the prompt lists the region criteria), it scores those from pixels as well
            const regions = /- skyline: /.test(params.contents[0].parts.map(p => p.text ?? '').join(' '));
            if (calls && regions) calls.regions = (calls.regions ?? 0) + 1;
            const renderEntries = renders.map((r, k) => {
                let d = 0;
                for (let i = 0; i < r.rgba.length; i += 4) d += Math.abs(r.rgba[i] - photo.rgba[i]) + Math.abs(r.rgba[i + 1] - photo.rgba[i + 1]) + Math.abs(r.rgba[i + 2] - photo.rgba[i + 2]);
                const s = Math.max(1, Math.min(10, Math.round(10 - d / (r.rgba.length / 4) / 6)));
                return { image: k + 1, shape: s, materials: s, detail: s, errors: s, overall: s, ...(regions ? { ground: s, neighbours: Math.max(1, s - 1), skyline: Math.min(10, s + 1) } : {}), note: `diff-based ${s}` };
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
        // views named after a pano: the views a build scored itself on, survey stations and frames
        expect([...collectPanoIds({
            before: { views: [{ id: '3u8oHMLUFESFW7G_ne2NJA_h193_p55' }] }, station: 'SV_9lNp3PieY4hfrKRrQEWsIQ_h138', frame: '/x/nyfNITk8-CHQvykzhrvGTw_h272_p-5_f60.jpg', other: 'facade_h12_p3'
        })].sort()).toEqual(['3u8oHMLUFESFW7G_ne2NJA', '9lNp3PieY4hfrKRrQEWsIQ', 'nyfNITk8-CHQvykzhrvGTw']);
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
        // the regions, from geometry: the isolate is the target, the tile's terrain the ground; masks drawn in every grid
        expect(r.regions.target.source).toMatch(/the isolate/);
        expect(r.regions.terrain.method).toBe('walkable-surface');
        expect(r.arms.map((a: any) => a.scope)).toEqual(['target', 'target']);
        for (const v of r.views) {
            const px = v.regions.pixels;
            expect(px.target).toBeGreaterThan(1000);
            expect(px.ground).toBeGreaterThan(1000);
            expect(px.sky).toBeGreaterThan(1000);
            expect(px.skyline).toBeGreaterThan(100);
            expect(px.sky + px.ground + px.neighbours + px.target + px.trees).toBe(v.size[0] * v.size[1]);
            // both arms have the scan's geometry in the same street: every pixel shows what the reference shows
            for (const id of ['raw', 'build']) expect(v.regions.arms[id].frame.agreement).toBe(1);
            // the wrong texture costs on the building, and both arms share the street (apart from the colour blur, 3 px, which
            // carries the building's colour a little way onto the ground at its base)
            expect(v.regions.arms.raw.building.ssim).toBeGreaterThan(v.regions.arms.build.building.ssim);
            expect(v.regions.arms.raw.building.colourDeltaE).toBeLessThan(v.regions.arms.build.building.colourDeltaE);
            expect(Math.abs(v.regions.arms.raw.ground.colourDeltaE - v.regions.arms.build.ground.colourDeltaE)).toBeLessThan(2);
            // the old building numbers are untouched beside them
            expect(v.pixel.raw.maskPixels).toBeGreaterThan(0);
            for (const f of [v.regions.masks, v.regions.maskGrid]) expect(fs.readFileSync(f).subarray(1, 4).toString()).toBe('PNG');
        }
        expect(r.pixelMetrics.regions.mean.raw.building.ssim).toBeGreaterThan(r.pixelMetrics.regions.mean.build.building.ssim);
        expect(r.pixelMetrics.regions.mean.raw.frame.agreement).toBe(1);
        expect(r.judgeRegions).toBe(false);
        expect(r.regionScores).toBeUndefined();
        expect(r.summary).toMatch(/Region metrics \(masks from geometry/);
        r.views.forEach((v: any, k: number) => fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `tool_photo_match_staged_masks_view${k}.png`)));
        // the satellite second opinion is opt-in: not fetched, not rendered, said so
        expect(r.satelliteOrtho).toEqual({ used: false, requested: false, note: expect.stringMatching(/includeSatelliteOrtho/) });
        expect(r.summary).not.toMatch(/Satellite/);
    }, 120_000);

    it('adds a Static Maps satellite crop as a second opinion on request: top-down renders at its GSD, judged apart from the scores', async () => {
        const calls = { n: 0 };
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { judgeCalls: calls, satellite: true }));
        const out = await handler({ views: 2, runs: 1, includeSatelliteOrtho: true }, ctxFor(root, staged.scene));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        const sat = r.satelliteOrtho;
        expect(sat.used).toBe(true);
        expect(sat.source).toBe('google_static_maps');
        expect(sat.gsdMetresPerPixel).toBeCloseTo(0.226, 3);
        expect(sat.widthM).toBeCloseTo(0.22636537381611962 * 512, 1);
        expect(sat.size).toEqual([512, 512]);
        expect(sat.capturedAt).toBeNull();
        expect(sat.captureDateNote).toMatch(/no capture date/);
        expect(sat.camera).toMatch(/orthographic/);
        expect(fs.existsSync(sat.image)).toBe(true);
        expect(fs.readFileSync(sat.grid).subarray(1, 4).toString()).toBe('PNG');
        for (const f of Object.values(sat.renders)) expect(fs.existsSync(f as string)).toBe(true);
        // judged like a view, textured and in clay; the raw scan (the street the "satellite" shows) beats the wrongly textured build
        expect(sat.judge.stats.raw.overall.mean).toBeGreaterThanOrEqual(sat.judge.stats.build.overall.mean);
        expect(sat.clayJudge.stats.raw.shape.mean).toBeGreaterThanOrEqual(1);
        expect(sat.pixel.raw.coverage).toBeGreaterThan(0.95);
        expect(sat.pixel.raw.ssim).toBeGreaterThan(sat.pixel.build.ssim);
        // kept out of the street-view scores: two views judged (textured + clay each) plus the satellite's two calls
        expect(r.views).toHaveLength(2);
        expect(r.views.map((v: any) => v.id)).not.toContain('sat_ortho');
        expect(r.clayJudged).toBe(2);
        expect(calls.n).toBe(2 * 1 * 2 + 2);
        expect(r.summary).toMatch(/Satellite second opinion \(Google Static Maps, top-down at 0\.226 m\/px, capture date unknown; not counted in the scores\)/);
        fs.copyFileSync(sat.grid, path.join(SHOTS, 'tool_photo_match_satellite.png'));
        if (sat.clayGrid) fs.copyFileSync(sat.clayGrid, path.join(SHOTS, 'tool_photo_match_satellite_clay.png'));

        // asked for without a satellite source: the street views are still judged and the second opinion says why it is missing
        const bare = await createPhotoMatchEvaluateHandler(() => fakeDeps(root))({ views: 1, runs: 1, clay: false, includeSatelliteOrtho: true }, ctxFor(root, staged.scene));
        const b = bare.resultPayload as any;
        expect(bare.status).toBe('completed');
        expect(b.satelliteOrtho.used).toBe(false);
        expect(b.satelliteOrtho.code).toBe('satellite_unavailable');
        expect(b.summary).toMatch(/Satellite second opinion \(includeSatelliteOrtho\) was requested but not used/);
        expect(b.views).toHaveLength(1);
    }, 180_000);

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

    it('judges a district build as a whole place: the target picked at the place, regions per arm, a decoy without neighbours, the place judged blind', async () => {
        const models = path.join(root, 'public', 'models');
        const ground260 = { ...ground(260), png: checkerPng([110, 110, 105], [96, 96, 92]) };
        // D: the whole place as the tile has it; N: the same place with its neighbour gone (a decoy the regions must catch)
        const districtGlb = path.join(models, 'synthetic_district_44444444.glb');
        writeGlb(districtGlb, [ground260, { ...TARGET, png: realFacade }, { ...NEIGHBOUR, png: facadePng([200, 196, 186], [60, 70, 80]) }]);
        const noNeighbourGlb = path.join(models, 'synthetic_district_no_neighbour_55555555.glb');
        writeGlb(noNeighbourGlb, [ground260, { ...TARGET, png: realFacade }]);
        const calls = { n: 0, clay: 0, regions: 0 };
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root, { judgeCalls: calls }));
        const out = await handler({
            arms: [
                { id: 'D', label: 'DISTRICT', glbs: [districtGlb], scope: 'place' },
                { id: 'N', label: 'NO NEIGHBOURS', glbs: [noNeighbourGlb], scope: 'place' },
                // the hero alone (an isolated build's GLB) in the same comparison: drawn in the tile with the picked target cut out
                { id: 'K', label: 'HERO ONLY', glbs: [staged.altGlb] }
            ],
            anchor: { lat: PLACE.lat, lng: PLACE.lng }, excludePanoIds: ['USED_WEST'], views: 3, runs: 1, clay: false, judgeRegions: true
        }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 800)).toBe('completed');
        // no isolate: the target is the structure the structure rule picks at the place (the 14 x 12 m block, not its neighbour)
        expect(r.regions.target.source).toMatch(/structure rule picks at the frame origin/);
        expect(r.regions.target.areaM2).toBeGreaterThanOrEqual(150);
        expect(r.regions.target.areaM2).toBeLessThanOrEqual(240);
        expect(r.regions.target.heightM).toBeCloseTo(16, 0);
        expect(r.arms.map((a: any) => [a.id, a.scope])).toEqual([['raw', 'target'], ['D', 'place'], ['N', 'place'], ['K', 'target']]);
        expect(r.arms[0].label).toBe('RAW SCAN (CUT TO TARGET)');
        expect(r.context).toMatch(/structure picked at the place/);
        expect(r.context).toMatch(/2 arms are the whole place/);
        // the views look at the target, not at the middle of everything the district holds
        expect(r.views).toHaveLength(3);
        for (const v of r.views) expect(v.distanceM).toBeLessThan(50);
        let sawNeighbour = false;
        for (const v of r.views) {
            const px = v.regions.pixels;
            expect(px.target).toBeGreaterThan(1000);
            expect(px.ground).toBeGreaterThan(1000);
            // the whole place, the raw scan and the hero in its street all show what the tile shows
            for (const id of ['raw', 'D', 'K']) expect(v.regions.arms[id].frame.agreement, `${v.id} ${id}`).toBe(1);
            expect(v.regions.arms.N.building.agreement).toBe(1);
            if (px.neighbours > 500) {
                sawNeighbour = true;
                expect(v.regions.arms.N.neighbours.agreement).toBeLessThan(0.2);
                expect(v.regions.arms.N.neighbours.colourDeltaE).toBeGreaterThan(v.regions.arms.D.neighbours.colourDeltaE);
                expect(v.regions.arms.N.frame.agreement).toBeLessThan(1);
            }
        }
        expect(sawNeighbour).toBe(true);
        expect(r.pixelMetrics.regions.mean.D.neighbours.agreement).toBe(1);
        expect(r.pixelMetrics.regions.mean.N.neighbours.agreement).toBeLessThan(0.5);
        // the place judged blind in the same calls (no extra ones), the building's scores as before
        expect(calls.n).toBe(3);
        expect(calls.regions).toBe(3);
        expect(r.judgeRegions).toBe(true);
        expect(r.regionJudged).toBe(3);
        for (const id of ['raw', 'D', 'N', 'K']) {
            for (const c of ['ground', 'neighbours', 'skyline']) {
                expect(r.regionScores[id][c].mean).toBeGreaterThanOrEqual(1);
                expect(r.regionScores[id][c].mean).toBeLessThanOrEqual(10);
            }
            expect(Object.keys(r.scores[id]).sort()).toEqual(['detail', 'errors', 'identity', 'materials', 'overall', 'realism', 'shape']);
            expect(r.views[0].judge.regionStats[id].skyline.mean).toBeGreaterThanOrEqual(1);
        }
        expect(r.regionScores.D.ground.mean).toBeGreaterThan(r.regionScores.N.ground.mean);
        expect(r.summary).toMatch(/The place around the building \(3 of 3 views\)/);
        r.views.forEach((v: any, k: number) => {
            fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `tool_photo_match_district_masks_view${k}.png`));
            fs.copyFileSync(v.grid, path.join(SHOTS, `tool_photo_match_district_view${k}.png`));
        });
    }, 240_000);

    it('reads a seam-welded district run through its tile_seams note, and picks the target inside Google\'s footprint the run read', async () => {
        // a podium with a tower on it (the target), a neighbour; the run keys its tiles on the welded scan, which has no entry of its own
        const place2 = { lat: 40.71, lng: -74.01, formattedAddress: 'Synthetic Tower, Test City' };
        const sl = path.join(root, '.scratchbox', 'cache', 'staged_location');
        const rawDir = path.join(sl, 'tiles', 'd'.repeat(64));
        const podium = box(0, 0, 30, 20, 6), tower = box(0, 0, 10, 10, 40), other = box(40, 0, 10, 10, 22);
        const street: Part[] = [
            { ...ground(260), png: checkerPng([110, 110, 105], [96, 96, 92]) }, { ...podium, png: facadePng([150, 140, 120], [40, 50, 60]) },
            { ...tower, png: facadePng([190, 180, 160], [40, 50, 60]) }, { ...other, png: facadePng([200, 196, 186], [60, 70, 80]) }
        ];
        writeGlb(path.join(rawDir, 'textured.glb'), street);
        writeGlb(path.join(rawDir, 'geometry.glb'), street.map(p => ({ positions: p.positions, uvs: p.uvs, indices: p.indices, color: [0.5, 0.5, 0.5] as [number, number, number] })));
        fs.copyFileSync(path.join(rawDir, 'textured.glb'), path.join(rawDir, 'textured_tile_seams_2.glb'));
        fs.copyFileSync(path.join(rawDir, 'geometry.glb'), path.join(rawDir, 'geometry_tile_seams_2.glb'));
        fs.writeFileSync(path.join(rawDir, 'done.json'), JSON.stringify({
            schema: 'scratchbox.stage-cache/1', stage: 'tiles', key: 'd'.repeat(64), builtAtMs: 1, ms: 1, published: [],
            value: { texturedGlb: 'textured.glb', geometryGlb: 'geometry.glb', originEllipsoidalHeightM: -31, geoAnchor: { lat: place2.lat, lng: place2.lng } }
        }));
        const VEC = 'f'.repeat(64), RUN2 = 'e5e5e5e5';
        const rect = (x0: number, x1: number, z0: number, z1: number) => [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]];
        fs.mkdirSync(path.join(sl, 'vector', VEC), { recursive: true });
        fs.writeFileSync(path.join(sl, 'vector', VEC, 'done.json'), JSON.stringify({
            schema: 'scratchbox.stage-cache/1', stage: 'vector', key: VEC, builtAtMs: 1, ms: 1, published: [],
            value: { sel: { buildings: [{ id: 'podium', parts: [{ loops: rect(-15, 15, -10, 10), minH: 0, topH: 40 }] }, { id: 'other', parts: [{ loops: rect(35, 45, -5, 5), minH: 0, topH: 22 }] }] }, tiles: 1 }
        }));
        const runDir = path.join(sl, 'runs', RUN2);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'stages.json'), JSON.stringify({ schema: 'scratchbox.staged-run/1', runId: RUN2, request: { query: 'Synthetic Tower', isolate: false }, place: place2, keys: { tiles: 'c'.repeat(64), vector: VEC }, statuses: {}, createdAtMs: 1 }));
        fs.writeFileSync(path.join(runDir, 'tile_seams.json'), JSON.stringify({ version: 'tile-seams/2', raw: path.join(rawDir, 'textured.glb'), inputTriangles: 1, outputTriangles: 1, toleranceM: 0.03, seamWeld: {}, overlapTrim: {}, tJunctions: {} }));
        const districtGlb = path.join(root, 'public', 'models', 'synthetic_tower_district_66666666.glb');
        writeGlb(districtGlb, street);
        const deps = () => fakeDeps(root, { street: path.join(rawDir, 'textured.glb') });
        const out = await createPhotoMatchEvaluateHandler(deps)({ arms: [{ id: 'D', label: 'DISTRICT', runId: RUN2, glbs: [districtGlb] }], views: 2, runs: 1, clay: false }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 800)).toBe('completed');
        expect(r.reference).toMatch(/seam-welded scan/);
        expect(r.origin.heightMeters).toBe(-31);
        expect(r.arms.map((a: any) => [a.id, a.scope])).toEqual([['raw', 'target'], ['D', 'place']]);
        // inside the footprint the whole building is the target: podium and tower (600 m²), not the tower alone
        expect(r.regions.target.footprintSource).toBe('vector-footprint');
        expect(r.regions.target.areaM2).toBeGreaterThanOrEqual(560);
        expect(r.regions.target.areaM2).toBeLessThanOrEqual(700);
        for (const v of r.views) expect(v.regions.arms.D.frame.agreement).toBe(1);
        // the same tile without the footprints (GLBs and an anchor): the scan alone gives what it gives, and says so
        const bare = await createPhotoMatchEvaluateHandler(deps)({ arms: [{ id: 'D', glbs: [districtGlb], scope: 'place' }], anchor: { lat: place2.lat, lng: place2.lng }, views: 1, runs: 1, clay: false }, ctxFor(root));
        const b = bare.resultPayload as any;
        expect(bare.status, JSON.stringify(b).slice(0, 800)).toBe('completed');
        expect(b.regions.target.footprintSource).toBe('scan-geometry');
        expect(b.regions.target.source).toMatch(/no building footprints are recorded/);
        expect(b.regions.target.areaM2).toBeLessThan(300);
        console.log('scan-only pick', b.regions.target.areaM2, 'm2; with the footprint', r.regions.target.areaM2, 'm2');
        r.views.forEach((v: any, k: number) => fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `tool_photo_match_footprint_masks_view${k}.png`)));
        b.views.forEach((v: any, k: number) => fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `tool_photo_match_scan_only_masks_view${k}.png`)));
    }, 240_000);

    it('takes GLBs with an anchor, finding the cached extraction there', async () => {
        const handler = createPhotoMatchEvaluateHandler(() => fakeDeps(root));
        const out = await handler({ glbs: [staged.altGlb], anchor: { lat: PLACE.lat, lng: PLACE.lng }, isolateGlb: `.scratchbox/cache/tile_refine/${REMESH_KEY}/raw_clay.glb`, views: 1, runs: 1, place: 'Synthetic Block' }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 600)).toBe('completed');
        expect(r.reference).toBe('the cached extraction at the anchor');
        expect(r.origin.heightMeters).toBe(-30);
        expect(r.summary).toMatch(/Only 1 view could be judged/);
    }, 120_000);

    it('stands each held-out eye 2.5 m over the terrain, not over scan that lies below the street', async () => {
        // a vault 20 m under the street north of the block: under the pano there, the lowest surface is its floor
        const anchor = { lat: 40.72, lng: -74.02 };
        const floor = { positions: [-8, -20, -46, 8, -20, -46, 8, -20, -30, -8, -20, -30], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 2, 1, 0, 3, 2] };
        const textured = writeTileAt(root, '9'.repeat(64), anchor, [
            { ...ground(260), png: checkerPng([110, 110, 105], [96, 96, 92]) }, { ...TARGET, png: realFacade }, { ...floor, png: checkerPng([60, 60, 60], [50, 50, 50]) }
        ]);
        const panos: PanoCandidate[] = [
            { panoId: 'OVER_VAULT', lat: 0, lng: 0, date: '2025-06', copyright: '© Google', x: 0, z: -38 },
            { panoId: 'SOUTH', lat: 0, lng: 0, date: '2025-05', copyright: '© Google', x: 4, z: 34 }
        ];
        // the rule alone, on the tile's geometry: on the terrain the eye stands at street height; on the lowest surface it stood
        // in the vault, under the street, which hid the whole block from it
        const scan = loadScanMesh(textured.replace(/textured\.glb$/, 'geometry.glb'));
        const terrain = buildGroundModel(scan, { cellMeters: 1 });
        const block = { cx: 0, cz: 0, radiusM: Math.hypot(7, 6), ymin: 0, ymax: 16, mesh: { vertices: Float32Array.from(TARGET.positions), indices: Uint32Array.from(TARGET.indices) } };
        const onTerrain = heldOutViews(panos, block, scan.mesh, new Set(), terrain);
        const north = onTerrain.views.find(v => v.panoId === 'OVER_VAULT')!;
        expect(north, onTerrain.rejected.join('; ')).toBeDefined();
        expect(north.eye[1]).toBeCloseTo(2.48, 1);
        expect(north.eyeGround).toBe('terrain');
        const onLowest = heldOutViews(panos, block, scan.mesh, new Set());
        expect(onLowest.views.map(v => v.panoId)).toEqual(['SOUTH']);
        expect(onLowest.rejected.join('; ')).toMatch(/OVER_VAULT: 38 m, fills \d+% of the frame, \d% of it unhidden/);

        // the tool: both panos held out and judged, every eye on the terrain
        const out = await createPhotoMatchEvaluateHandler(() => fakeDeps(root, { panos, street: textured }))({ glbs: [staged.altGlb], anchor, views: 2, runs: 1, clay: false }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 800)).toBe('completed');
        expect(r.views.map((v: any) => v.panoId).sort()).toEqual(['OVER_VAULT', 'SOUTH']);
        expect(r.heldOut.eyeGround).toEqual({ terrain: 2 });
    }, 120_000);

    it('looks at a place with no structure at it: the tile round the place, widened until enough views qualify', async () => {
        // a walled park: a low basin at its centre, a 2.9 m wall 45 m out, streets, then buildings 70 m and more from the place
        // (nothing 3 m tall within 30 m of it, so the structure rule picks nothing)
        const anchor = { lat: 40.73, lng: -74.03 };
        const lawn = ground(260);
        const wall = (cx: number, cz: number, w: number, d: number) => ({ ...box(cx, cz, w, d, 2.9), png: checkerPng([120, 112, 100], [110, 104, 94]) });
        const park: Part[] = [
            { ...lawn, png: checkerPng([80, 120, 70], [70, 110, 62]) }, { ...box(0, 0, 8, 8, 0.8), png: checkerPng([150, 150, 156], [140, 140, 146]) },
            wall(0, -45, 90, 0.6), wall(0, 45, 90, 0.6), wall(-45, 0, 0.6, 90), wall(45, 0, 0.6, 90),
            { ...box(0, -80, 70, 20, 30), png: facadePng([168, 92, 70], [40, 52, 70]) }, { ...box(0, 80, 70, 20, 24), png: facadePng([200, 196, 186], [60, 70, 80]) },
            { ...box(-80, 0, 20, 70, 28), png: facadePng([150, 140, 120], [40, 50, 60]) }, { ...box(80, 0, 20, 70, 26), png: facadePng([190, 180, 160], [40, 50, 60]) }
        ];
        const textured = writeTileAt(root, '8'.repeat(64), anchor, park);
        const districtGlb = path.join(root, 'public', 'models', 'synthetic_park_district_77777777.glb');
        writeGlb(districtGlb, park);
        const pano = (panoId: string, x: number, z: number, date: string): PanoCandidate => ({ panoId, lat: 0, lng: 0, date, copyright: '© Google', x, z });
        const panos = [pano('IN_PARK', 20, 8, '2025-09'), pano('N1', 0, -55, '2025-08'), pano('N2', 30, -55, '2025-07'), pano('S1', -10, 56, '2025-06'), pano('W1', -55, 10, '2025-05'), pano('E1', 55, -20, '2025-04')];

        // the ground is two triangles of 130 m: cut at the circle, it counts for exactly the disc (a centroid test keeps nothing)
        const disc = surfacesWithin({ vertices: Float32Array.from(lawn.positions), indices: Uint32Array.from(lawn.indices) }, 0, 0, 30);
        let area = 0, reach = 0;
        for (let i = 0; i < disc.vertices.length; i += 9) {
            const [ax, az, bx, bz, cx, cz] = [disc.vertices[i], disc.vertices[i + 2], disc.vertices[i + 3], disc.vertices[i + 5], disc.vertices[i + 6], disc.vertices[i + 8]];
            area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
            reach = Math.max(reach, Math.hypot(ax, az), Math.hypot(bx, bz), Math.hypot(cx, cz));
        }
        expect(area / (Math.PI * 30 * 30)).toBeCloseTo(1, 2);
        expect(reach).toBeLessThanOrEqual(30 / Math.cos(Math.PI / 32) + 1e-3);

        const calls = { n: 0 };
        const out = await createPhotoMatchEvaluateHandler(() => fakeDeps(root, { panos, street: textured, judgeCalls: calls }))({ arms: [{ id: 'D', label: 'DISTRICT', glbs: [districtGlb], scope: 'place' }], anchor, views: 2, runs: 1, clay: false }, ctxFor(root));
        const r = out.resultPayload as any;
        expect(out.status, JSON.stringify(r).slice(0, 1200)).toBe('completed');
        // within the pick's window only the pano inside the park sees the place (the wall hides it from the streets), so the
        // place widens one window: the wall and the lawn to 60 m are then what the street panos look at
        const vt = r.heldOut.viewTarget;
        expect(vt.rule).toBe('open-place');
        expect(vt.tried[0]).toEqual({ radiusM: OPEN_PLACE_RADII_M[0], candidates: 1 });
        expect(vt.radiusM).toBe(OPEN_PLACE_RADII_M[1]);
        expect(vt.tried[1].candidates).toBe(5);
        expect(vt.source).toMatch(/no structure stands within 30 m/);
        expect(r.regions.target.source).toBe('none');
        expect(r.summary).toMatch(/No structure stands at the place, so the views look at the place itself/);
        expect(r.views).toHaveLength(2);
        for (const v of r.views) {
            // aimed at the place's centre, not at the nearest thing to the pano
            const p = panos.find(q => q.panoId === v.panoId)!;
            expect(Math.abs(v.headingDeg - bearingDeg(p.x, p.z, 0, 0))).toBeLessThan(0.1);
            expect(v.regions.pixels.target).toBe(0);
            expect(v.regions.pixels.ground).toBeGreaterThan(1000);
            expect(v.regions.arms.D.frame.agreement).toBe(1);
        }
        expect(calls.n).toBe(2);
        r.views.forEach((v: any, k: number) => fs.copyFileSync(v.regions.maskGrid, path.join(SHOTS, `tool_photo_match_open_place_masks_view${k}.png`)));
    }, 240_000);

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
