/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * streetview_survey's temporary-structure check (checkTemporary) on a synthetic street with known truth, no network and no
 * billed call: a 12 x 10 x 14 m building whose south and east faces were wrapped in orange scaffold netting when the street
 * was captured in 2025-06. Twelve 2025-06 panos ring it; one older 2023-09 capture stands 2 m from the ring's south pano, so
 * the discovery's 6 m thinning drops it (it is "superseded"). The grounding service renders each pano's photo from the
 * world as it stood at its capture month. The vision replies are synthetic: a fake client behind the real VisionModelChain
 * decodes the image it is sent and outlines the orange netting it finds.
 *
 * The truth the survey must find: the south face's 2025-06 view is flagged and replaced by the clear 2023-09 capture (the
 * swap recorded); the east face has no capture from another month, so its view is kept and flagged; the north and west
 * faces are clear and keep the views the survey takes without the check.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { building, groundGrid, writeTris, type Tri } from './helpers/staged-synthetic-world';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import type { StagedExtraction, StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../src/node/spatial/StreetViewSurveyPlanner';
import { elevationForGroundingPitch, type GroundingImage, type GroundingImageRequest } from '../src/node/spatial/StreetViewGroundingImageService';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { renderFrameDepth, readGlbScene, sceneToRenderMesh, type FrameCamera } from '../src/node/spatial/StreetViewPoseRegistrar';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { VisionModelChain } from '../src/node/gemini/vision-model-chain';
import {
    maskTemporaryInViews, parseTemporaryReply, replaceTemporaryViews, temporaryMask, visionTemporaryChecker, TEMPORARY_MIN_CONFIDENCE, type TemporaryChecker
} from '../src/node/3d-engine/staged-location/temporary-structures';
import { prepareSurveySite, runStreetViewSurvey, STREETVIEW_SURVEY_DECLARATION, type StreetViewSurveyDeps, type StreetViewSurveyResult, type SurveySite } from '../src/node/gemini/tools/location-evidence/streetview-survey';
import type { ProjectionView } from '../src/common/spatial/texture-pass-contracts';

const ORIGIN: GeodeticOrigin = { lat: 40.7306, lng: -73.9975, heightMeters: 0 };
const W = 640, H = 480;
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/survey_temporary');
const SCAFFOLD_MONTH = '2025-06';

const PANOS = [
    ...Array.from({ length: 12 }, (_, k) => {
        const a = (k * 30 + 15) * Math.PI / 180;
        return { panoId: `ringPano${String(k).padStart(2, '0')}`, x: 24 * Math.sin(a), z: -24 * Math.cos(a), date: SCAFFOLD_MONTH };
    }),
    // an older capture 2 m from the ring's south pano (ringPano05 at 165°): the discovery thins it out as superseded
    { panoId: 'olderPano2023', x: 4.6, z: 24.4, date: '2023-09' },
    // an older pano 2 m from the ring's east pano (ringPano03 at 105°) that is an indoor capture: its photo shows no building
    { panoId: 'indoorPano2012', x: 24.6, z: 4.6, date: '2012-03' }
].map(p => { const g = scanToGeodetic(ORIGIN, p.x, 0, p.z); return { ...p, lat: g.lat, lng: g.lng }; });

/** Colour of a world point at a capture month: stone walls with windows; in 2025-06 orange netting on the south and east faces below 11 m. */
function shade(p: [number, number, number], n: [number, number, number], month: string): [number, number, number] {
    if (p[1] < 0.05) return [95, 95, 100];
    if (p[1] > 13.95) return [150, 150, 150];
    const south = Math.abs(n[2]) > 0.5 && p[2] > 4.9, east = Math.abs(n[0]) > 0.5 && p[0] > 5.9;
    if (month === SCAFFOLD_MONTH && (south || east) && p[1] < 11) {
        const along = east ? p[2] : p[0];
        const pole = (((along % 1.8) + 1.8) % 1.8) < 0.18 || (((p[1] % 2) + 2) % 2) < 0.15;
        return pole ? [120, 120, 125] : [235, 125, 35];
    }
    const along = Math.abs(n[0]) > 0.5 ? p[2] : p[0];
    const wx = ((along % 2.5) + 2.5) % 2.5, wy = ((p[1] % 3.5) + 3.5) % 3.5;
    const window = p[1] > 1.2 && wx > 0.7 && wx < 1.8 && wy > 1.0 && wy < 2.8;
    const tone = Math.abs(n[0]) > 0.5 ? 0 : 18;
    return window ? [45, 50, 60] : [200 - tone, 175 - tone, 150 - tone];
}

function photo(mesh: { vertices: Float32Array; indices: Uint32Array }, cam: FrameCamera, month: string): Buffer {
    const depth = renderFrameDepth(mesh, cam);
    const rgba = Buffer.alloc(cam.width * cam.height * 4);
    const at = (x: number, y: number) => {
        const d = depth[y * cam.width + x];
        if (!(d < 1e8)) return undefined;
        const u = (x + 0.5 - cam.cx) / cam.fx, w = (y + 0.5 - cam.cy) / cam.fy;
        return [0, 1, 2].map(k => cam.eye[k] + d * (cam.fwd[k] + u * cam.right[k] - w * cam.up[k])) as [number, number, number];
    };
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const i = (y * cam.width + x) * 4;
        const p = at(x, y);
        let c: [number, number, number];
        if (!p) c = [110 + y / 10, 160 + y / 14, 230];
        else {
            const q = at(Math.min(cam.width - 1, x + 1), y), r = at(x, Math.min(cam.height - 1, y + 1));
            let n: [number, number, number] = [0, 1, 0];
            if (q && r) {
                const a = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], b = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
                const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
                const l = Math.hypot(cx, cy, cz) || 1;
                n = [cx / l, cy / l, cz / l];
            }
            c = shade(p, n, month);
        }
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    return Buffer.from(jpegJs.encode({ data: rgba, width: cam.width, height: cam.height }, 92).data);
}

const isNetting = (r: number, g: number, b: number) => r > 190 && g > 80 && g < 170 && b < 90;

/**
 * The synthetic vision model: decodes the image it is sent and, when orange netting covers at least 2 percent of it, answers
 * present with the netting's bounding outline ([y, x] in 0..1000); otherwise not present. Every request is counted.
 */
function syntheticVisionClient(calls: { n: number; texts: string[] }) {
    const generateContent = async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        calls.n++;
        const parts = (params.contents as Array<{ parts: Array<{ inlineData?: { data: string }; text?: string }> }>)[0].parts;
        const img = decodeImageInMemory(Buffer.from(parts.find(p => p.inlineData)!.inlineData!.data, 'base64'));
        calls.texts.push(parts.find(p => p.text)!.text!);
        // the outline: the netting's left and right extent every 8 rows (a silhouette, as a model traces one)
        let n = 0;
        const left: Array<[number, number]> = [], right: Array<[number, number]> = [];
        for (let y = 0; y < img.height; y++) {
            let a = -1, b = -1;
            for (let x = 0; x < img.width; x++) {
                const i = (y * img.width + x) * 4;
                if (!isNetting(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2])) continue;
                n++; if (a < 0) a = x; b = x;
            }
            if (a >= 0 && (y % 8 === 0 || !left.length)) { left.push([y, a]); right.push([y, b + 1]); }
        }
        let bld = 0;
        for (let i = 0; i < img.width * img.height; i++) { const r = img.rgba[i * 4], g = img.rgba[i * 4 + 1], b = img.rgba[i * 4 + 2]; if ((r > 150 && r - b > 30) || (r < 70 && g < 75 && b < 85 && b > 35) || isNetting(r, g, b)) bld++; }
        const buildingShare = Math.round(bld / (img.width * img.height) * 100) / 100;
        const k = (v: number, d: number) => Math.round(v / d * 1000);
        const outline = [...left, ...right.reverse()].map(([y, x]) => [k(y, img.height), k(x, img.width)]);
        const reply = n > 0.02 * img.width * img.height
            ? { buildingShare, present: true, confidence: 0.92, description: 'orange scaffold netting over the lower floors', regions: [{ description: 'scaffold netting', outline }] }
            : { buildingShare, present: false, confidence: 0.9, description: 'the facade is clear', regions: [] };
        return { candidates: [{ content: { role: 'model', parts: [{ text: '```json\n' + JSON.stringify(reply) + '\n```' }] }, finishReason: 'STOP' }], modelVersion: 'synthetic-vision' } as unknown as GenerateContentResponse;
    };
    return { models: { generateContent } };
}

/** The photo with a mask's edge outlined in magenta (the contact sheet's tile). */
function tile(jpeg: Buffer, mask?: Uint8Array): Uint8Array {
    const img = decodeImageInMemory(jpeg);
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = img.rgba[i * 4 + c];
    if (mask) for (let y = 1; y < img.height - 1; y++) for (let x = 1; x < img.width - 1; x++) {
        const i = y * img.width + x;
        if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - img.width] || !mask[i + img.width])) for (const d of [-img.width - 1, 0, img.width + 1]) rgb.set([255, 0, 255], (i + d) * 3);
    }
    return rgb;
}

const maskOf = (png: Buffer): Uint8Array => { const m = decodeImageInMemory(png); const out = new Uint8Array(m.width * m.height); for (let i = 0; i < out.length; i++) out[i] = m.rgba[i * 4] > 127 ? 1 : 0; return out; };

function sheet(tiles: Uint8Array[], cols: number): Buffer {
    const rows = Math.ceil(tiles.length / cols), SW = cols * W, SH = rows * H;
    const out = new Uint8Array(SW * SH * 3).fill(30);
    tiles.forEach((t, k) => { const ox = (k % cols) * W, oy = Math.floor(k / cols) * H; for (let y = 0; y < H; y++) out.set(t.subarray(y * W * 3, (y + 1) * W * 3), ((oy + y) * SW + ox) * 3); });
    return encodePng(SW, SH, out, 3);
}

describe('streetview_survey checkTemporary (synthetic street, synthetic vision replies, no network)', () => {
    let root: string;
    let site: SurveySite;
    let worldMesh: { vertices: Float32Array; indices: Uint32Array };
    let groundingCalls = 0;
    const vision = { n: 0, texts: [] as string[] };

    const metadataFetch = (async (input: string | URL) => {
        const url = new URL(String(input));
        const [lat, lng] = (url.searchParams.get('location') ?? '0,0').split(',').map(Number);
        const radius = Number(url.searchParams.get('radius') ?? 8);
        const q = geodeticToScan(ORIGIN, lat, lng);
        const near = PANOS.map(p => ({ p, d: Math.hypot(p.x - q.x, p.z - q.z) })).filter(e => e.d <= radius).sort((a, b) => a.d - b.d)[0];
        const body = near ? { status: 'OK', pano_id: near.p.panoId, location: { lat: near.p.lat, lng: near.p.lng }, date: near.p.date, copyright: '© Google' } : { status: 'ZERO_RESULTS' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const grounding = {
        retrieveGroundingImage: async (req: GroundingImageRequest): Promise<GroundingImage> => {
            groundingCalls++;
            const p = PANOS.find(x => x.panoId === req.panoId)!;
            if (p.panoId.startsWith('indoor')) {
                const flat = Buffer.alloc(W * H * 4, 128);
                return { image: Buffer.from(jpegJs.encode({ data: flat, width: W, height: H }, 90).data), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree!, pitchDegree: req.pitchDegree!, fovDegree: req.fovDegree! };
            }
            const cam = castCamera({ eye: [p.x, 2.5, p.z], headingDeg: req.headingDegree!, pitchDeg: elevationForGroundingPitch(req.pitchDegree!), fovDeg: req.fovDegree!, widthPx: W, heightPx: H });
            return { image: photo(worldMesh, cam, p.date), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree!, pitchDegree: req.pitchDegree!, fovDegree: req.fovDegree! };
        }
    };

    const checker = (): TemporaryChecker => visionTemporaryChecker(new VisionModelChain<string>({ client: syntheticVisionClient(vision), candidates: ['synthetic-vision'] }));
    const surveyDeps = (over: Partial<StreetViewSurveyDeps> = {}): StreetViewSurveyDeps => ({
        streetView: { mapsApiKey: 'test-key', grounding, fetchImpl: metadataFetch, metadataCachePath: path.join(root, 'sv', 'metadata.json'), refusedPanos: new Map() },
        // no registration here (the nominal poses stand): this suite is about which captures are kept
        register: async () => ({ frames: 0, panos: 0 }),
        ...over
    });
    const faceView = (res: StreetViewSurveyResult, headingDeg: number) => res.views.find(v => Math.abs(((v.faceHeadingDeg - headingDeg) % 360 + 540) % 360 - 180) < 20)!;
    let plain: StreetViewSurveyResult;

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-survey-temporary-'));
        const tris: Tri[] = [...groundGrid(90, 4), ...building(-6, 6, -5, 5, 14)];
        const file = writeTris(path.join(root, 'world.glb'), tris);
        worldMesh = sceneToRenderMesh(readGlbScene(file)) as { vertices: Float32Array; indices: Uint32Array };
        const deps = {
            cache: new StageCache({ workspaceRoot: root }),
            geocode: async () => ({ lat: ORIGIN.lat, lng: ORIGIN.lng, formattedAddress: 'Synthetic Building, 1 Test Street' }),
            extract: async (req: { outDir: string; radiusM: number }) => {
                fs.mkdirSync(req.outDir, { recursive: true });
                const t = path.join(req.outDir, 'textured.glb'), g = path.join(req.outDir, 'geometry.glb');
                fs.copyFileSync(file, t); fs.copyFileSync(file, g);
                return { texturedGlb: t, geometryGlb: g, leafIds: ['synthetic'], copyrights: ['synthetic'], fetchedAt: new Date(0).toISOString(), radiusM: req.radiusM, coveredRadiusM: req.radiusM, truncated: false, leafTiles: 1, leafGeometricErrorM: 0.5, originEllipsoidalHeightM: 0, geoAnchor: { lat: ORIGIN.lat, lng: ORIGIN.lng } } satisfies StagedExtraction;
            },
            vegetation: {}
        } as unknown as StagedLocationDeps;
        site = await prepareSurveySite({ query: 'Synthetic Building' }, deps);
        fs.mkdirSync(SHOTS, { recursive: true });
        // the survey without the check: the views it takes, and no vision call
        plain = await runStreetViewSurvey(site, { maxViews: 4, outDir: path.join(root, 'plain'), workspaceRoot: root }, surveyDeps({ temporary: checker() }));
    }, 120_000);

    afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    it('is off by default: no question asked, no temporary fields', () => {
        expect(vision.n).toBe(0);
        expect(plain.temporary).toBeUndefined();
        expect(plain.views.every(v => v.temporary === undefined)).toBe(true);
        expect(plain.coverage.every(c => c.temporary === undefined)).toBe(true);
        // the south view the plain survey takes is a 2025-06 ring pano (the older capture was thinned out)
        expect(faceView(plain, 180).captureMonth).toBe(SCAFFOLD_MONTH);
        expect(plain.views.some(v => v.panoId === 'olderPano2023')).toBe(false);
    });

    it('replaces a flagged view by a clear older capture, keeps and flags one with no alternative, leaves clear views alone', async () => {
        const outDir = path.join(root, 'build', 'streetview-grounding');
        const before = groundingCalls;
        const res = await runStreetViewSurvey(site, { maxViews: 4, checkTemporary: true, ownershipMasks: true, target: 'Synthetic Building', outDir, workspaceRoot: root }, surveyDeps({
            temporary: checker(),
            // the segmenter: every pixel the building's stone, windows or netting occupies (so the netting must be taken out by the check)
            // its occluder question ("anything standing in front of ...") finds nothing, as a segmenter that misses the netting would
            segmenter: async (image, prompts) => {
                const m = new Uint8Array(image.width * image.height);
                if (prompts.target?.startsWith('anything standing in front')) return m;
                for (let i = 0; i < m.length; i++) { const r = image.rgba[i * 4], g = image.rgba[i * 4 + 1], b = image.rgba[i * 4 + 2]; m[i] = (r > 150 && r - b > 30) || (r < 70 && g < 75 && b < 85 && b > 35) || isNetting(r, g, b) ? 1 : 0; }
                return m;
            }
        }));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_result.json'), JSON.stringify(res, null, 1));
        const t = res.temporary!;
        expect(t).toBeDefined();
        expect(t.unavailable).toBeUndefined();
        expect(t.model).toBe('synthetic-vision');
        expect(res.views.length).toBe(4);
        expect(t.checked).toBe(4);
        expect(t.unchecked).toBe(0);

        // 1. the south face: its 2025-06 view showed the netting and was replaced by the clear 2023-09 capture
        const southSwap = t.swaps.find(s => Math.abs(s.faceHeadingDeg - 180) < 20)!;
        expect(southSwap).toBeDefined();
        expect(southSwap.from).toEqual({ panoId: faceView(plain, 180).panoId, captureMonth: SCAFFOLD_MONTH });
        expect(southSwap.to).toEqual({ panoId: 'olderPano2023', captureMonth: '2023-09' });
        expect(southSwap.reason).toContain('scaffold netting');
        const south = faceView(res, 180);
        expect(south.panoId).toBe('olderPano2023');
        expect(south.captureMonth).toBe('2023-09');
        expect(south.temporary).toMatchObject({ present: false, flagged: false });
        expect(fs.existsSync(path.join(root, southSwap.fromImagePath!))).toBe(true);
        expect(fs.existsSync(path.join(root, southSwap.fromMaskPath!))).toBe(true);
        // the south face's best view is now clear; the 2025-06 views of the east and west faces still see its netting obliquely
        const southCov = res.coverage.find(c => Math.abs(c.headingDeg - 180) < 20)!;
        expect(southCov.bestViewIndex).toBe(south.index);
        expect(southCov.temporary!.bestViewFree).toBe(true);
        expect(southCov.temporary!.flaggedViews).not.toContain(south.index);

        // 2. the east face: its only other capture month is an indoor pano that shows no building, so the view is kept and
        // flagged, with its regions as a mask
        const eastKept = t.kept.find(k => Math.abs(k.faceHeadingDeg - 90) < 20)!;
        expect(eastKept).toBeDefined();
        expect(eastKept.reason).toBe('none of the 1 capture of this face from another month is clear');
        expect(eastKept.tried).toEqual([expect.objectContaining({ panoId: 'indoorPano2012', captureMonth: '2012-03' })]);
        expect(eastKept.tried[0].outcome).toMatch(/^shows too little of the building \(0 percent of the photo/);
        expect(eastKept.captureMonth).toBe(SCAFFOLD_MONTH);
        const east = faceView(res, 90);
        expect(east.panoId).toBe(faceView(plain, 90).panoId);
        expect(east.temporary!.flagged).toBe(true);
        expect(east.temporary!.confidence).toBeGreaterThanOrEqual(TEMPORARY_MIN_CONFIDENCE);
        expect(east.temporary!.regions.length).toBe(1);
        // the region is in image pixels and covers the netting
        const poly = east.temporary!.regions[0].polygon;
        expect(Math.max(...poly.map(p => p[0]))).toBeLessThanOrEqual(W);
        expect(Math.max(...poly.map(p => p[1]))).toBeLessThanOrEqual(H);
        const maskPng = decodeImageInMemory(fs.readFileSync(path.join(root, east.temporary!.maskPath!)));
        expect(maskPng.width).toBe(W);
        const eastImg = decodeImageInMemory(fs.readFileSync(path.join(root, east.imagePath)));
        let netting = 0, nettingMasked = 0;
        for (let i = 0; i < W * H; i++) if (isNetting(eastImg.rgba[i * 4], eastImg.rgba[i * 4 + 1], eastImg.rgba[i * 4 + 2])) { netting++; if (maskPng.rgba[i * 4] > 127) nettingMasked++; }
        expect(nettingMasked / netting).toBeGreaterThan(0.99);
        // downstream: the regions are occluders (out of the owner mask, into the occluder mask)
        expect(east.ownership?.status).toBe('segmented');
        expect(east.ownership!.temporaryPixels!).toBeGreaterThan(1000);
        const owner = decodeImageInMemory(fs.readFileSync(path.join(root, east.ownership!.ownerMaskPath!)));
        const occ = decodeImageInMemory(fs.readFileSync(path.join(root, east.ownership!.occluderMaskPath!)));
        let ownedNetting = 0, occNetting = 0;
        for (let i = 0; i < W * H; i++) if (isNetting(eastImg.rgba[i * 4], eastImg.rgba[i * 4 + 1], eastImg.rgba[i * 4 + 2])) { if (owner.rgba[i * 4] > 127) ownedNetting++; if (occ.rgba[i * 4] > 127) occNetting++; }
        expect(ownedNetting / netting).toBeLessThan(0.02);
        expect(occNetting / netting).toBeGreaterThan(0.99);
        expect(res.coverage.find(c => Math.abs(c.headingDeg - 90) < 20)!.temporary!.free).toBe(false);

        // 3. the north face: clear, its view unchanged
        const north = faceView(res, 0);
        expect(north.panoId).toBe(faceView(plain, 0).panoId);
        expect(north.temporary).toMatchObject({ present: false, flagged: false });
        expect(north.temporary!.maskPath).toBeUndefined();
        expect(res.coverage.find(c => Math.abs(c.headingDeg) < 20 || Math.abs(c.headingDeg - 360) < 20)!.temporary!.free).toBe(true);
        // the west view sees the south face's netting obliquely: flagged honestly, but its outline is off the west face, so the
        // view is not replaced and the west face's coverage is temporary-free
        const west = faceView(res, 270);
        expect(west.panoId).toBe(faceView(plain, 270).panoId);
        expect(west.temporary!.flagged).toBe(true);
        expect(t.offFace.map(o => o.panoId)).toEqual([west.panoId]);
        expect(res.coverage.find(c => Math.abs(c.headingDeg - 270) < 20)!.temporary!.free).toBe(true);
        expect(t.swaps.length).toBe(1);
        expect(t.kept.length).toBe(1);

        // the summary says what, where, when, and what became of it
        expect(t.summary).toMatch(/orange scaffold netting over the lower floors on the 18[01]° face in 2025-06; replaced with a 2023-09 capture/);
        expect(t.summary).toMatch(/on the (90|91)° face in 2025-06; kept and flagged \(none of the 1 capture/);
        // cost: 4 questions for the views, 1 more grounding image and question for each alternative tried
        expect(t.cost).toEqual({ images: 2, questions: 6 });
        expect(groundingCalls - before).toBe(6);
        expect(vision.n).toBe(6);
        // the question is open vocabulary and names the target and face
        expect(vision.texts[0]).toContain('Synthetic Building');
        expect(vision.texts[0]).toMatch(/TEMPORARY/);

        // contact sheet: the swap (before, after), then every view with its flagged regions outlined
        const tiles = [
            tile(fs.readFileSync(path.join(root, southSwap.fromImagePath!)), maskOf(fs.readFileSync(path.join(root, southSwap.fromMaskPath!)))),
            tile(fs.readFileSync(path.join(root, south.imagePath))),
            ...res.views.map(v => tile(fs.readFileSync(path.join(root, v.imagePath)), v.temporary?.flagged ? temporaryMask(v.temporary.regions, v.widthPx, v.heightPx) : undefined))
        ];
        fs.writeFileSync(path.join(SHOTS, 'synthetic_contact_sheet.png'), sheet(tiles, 3));
    }, 300_000);

    it('without a vision model the check says so and checks nothing', async () => {
        const res = await runStreetViewSurvey(site, { maxViews: 2, checkTemporary: true, outDir: path.join(root, 'nov'), workspaceRoot: root }, surveyDeps());
        expect(res.temporary!.unavailable).toMatch(/no vision model/);
        expect(res.temporary!.checked).toBe(0);
        expect(res.views.every(v => v.temporary === undefined)).toBe(true);
    }, 120_000);

    it('is declared as a tool option', () => {
        const props = (STREETVIEW_SURVEY_DECLARATION.parameters as { properties: Record<string, { type: string }> }).properties;
        expect(props.checkTemporary.type).toBe('BOOLEAN');
    });
});

describe('temporary-structure readings and masks', () => {
    it('parses a fenced reply into pixel polygons; low confidence is not flagged; a reply without "present" throws', () => {
        const r = parseTemporaryReply('```json\n{"present": true, "confidence": 0.8, "description": "a sidewalk shed along the ground floor", "regions": [{"outline": [[500, 0], [500, 1000], [1000, 1000], [1000, 0]]}, {"outline": [[1, 2]]}]}\n```', 200, 100);
        expect(r.flagged).toBe(true);
        expect(r.regions).toEqual([{ polygon: [[0, 50], [200, 50], [200, 100], [0, 100]] }]);
        expect(parseTemporaryReply('{"present": true, "confidence": 0.3, "description": "maybe a barrier", "regions": []}', 10, 10).flagged).toBe(false);
        expect(parseTemporaryReply('{"present": false, "confidence": 0.95, "description": "clear", "regions": [{"outline": [[0,0],[0,9],[9,9]]}]}', 10, 10).regions).toEqual([]);
        expect(() => parseTemporaryReply('{"confidence": 1}', 10, 10)).toThrow(/present/);
        expect(() => parseTemporaryReply('not json', 10, 10)).toThrow(/not JSON/);
    });

    it('keeps and flags a view when no eligible pano of its face exists from another month (no grounding call)', async () => {
        const face = { faceId: 'f0', headingDeg: 180, source: 'footprint', centre: [0, 7, 5], outward: [0, 0, 1], widthM: 12, heightM: 14 } as never;
        const view = { faceId: 'f0', panoId: 'p2025', date: '2025-06-01', facadeHeadingDeg: 180, eye: [0, 2.5, 24], headingDeg: 180, pitchDeg: 10, fovDeg: 60, aspectRatio: 'RATIO_4X3' } as never;
        const im = { view, bytes: Buffer.from('x'), mimeType: 'image/jpeg', widthPx: 100, heightPx: 80, sha256: 's', id: 'sv:p2025', nativeSampleM: 0.01, fetchMs: 1 } as never;
        let fetches = 0;
        const check: TemporaryChecker = async () => ({ present: true, confidence: 0.9, description: 'a sidewalk shed along the ground floor', buildingShare: 0.6, regions: [{ polygon: [[0, 60], [100, 60], [100, 80], [0, 80]] }], flagged: true });
        const r = await replaceTemporaryViews({
            images: [im], faces: [face], candidatesFor: () => [], check, target: 'x', refused: new Set(),
            streetView: { grounding: { retrieveGroundingImage: async () => { fetches++; throw new Error('not expected'); } } } as never
        });
        expect(fetches).toBe(0);
        expect(r.swaps).toEqual([]);
        expect(r.images[0]).toBe(im);
        expect(r.kept).toEqual([expect.objectContaining({ panoId: 'p2025', captureMonth: '2025-06', reason: 'no eligible pano of this face from another capture month', tried: [] })]);
        expect(r.cost).toEqual({ images: 0, questions: 1 });
    });

    it('a failed question leaves the view unchecked, never clear', async () => {
        const failing = { models: { generateContent: async () => { throw Object.assign(new Error('bad request'), { status: 400 }); } } };
        const check = visionTemporaryChecker(new VisionModelChain<string>({ client: failing, candidates: ['m'] }));
        const jpeg = Buffer.from(jpegJs.encode({ data: Buffer.alloc(32 * 24 * 4, 200), width: 32, height: 24 }, 90).data);
        const r = await check({ bytes: jpeg, mimeType: 'image/jpeg', widthPx: 32, heightPx: 24 }, { target: 'x' });
        expect(r.error).toBeDefined();
        expect(r.flagged).toBe(false);
        expect(r.present).toBe(false);
    });

    it('the texture pass takes a flagged view\'s regions out of its ownership mask and leaves a clear view as it was', async () => {
        const mkView = (panoId: string, orange: boolean): ProjectionView => {
            const rgba = new Uint8Array(W * H * 4);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const o = orange && x >= 100 && x < 300 && y >= 200 && y < 400; rgba.set(o ? [235, 125, 35, 255] : [180, 170, 160, 255], i); }
            return { panoId, camera: castCamera({ eye: [0, 2.5, 20], headingDeg: 0, pitchDeg: 0, fovDeg: 60, widthPx: W, heightPx: H }) as unknown as ProjectionView['camera'], image: { width: W, height: H, rgba }, poseQuality: 1, poseSigmaPx: 0, ownerMask: new Uint8Array(W * H).fill(1) };
        };
        const calls = { n: 0, texts: [] as string[] };
        const check = visionTemporaryChecker(new VisionModelChain<string>({ client: syntheticVisionClient(calls), candidates: ['synthetic-vision'] }));
        const clear = mkView('clear', false), flagged = mkView('flagged', true);
        const out = await maskTemporaryInViews({ views: [clear, flagged], check, target: 'Synthetic Building' });
        expect(calls.n).toBe(2);
        expect(out.views[0]).toBe(clear);
        expect(out.records[0]).toMatchObject({ flagged: false, maskedPixels: 0 });
        expect(out.records[1].flagged).toBe(true);
        const m = out.views[1].ownerMask!;
        // inside the netting: refused; well outside it: kept
        expect(m[300 * W + 200]).toBe(0);
        expect(m[100 * W + 500]).toBe(1);
        expect(out.records[1].maskedPixels).toBeGreaterThanOrEqual(200 * 200);
        expect(out.records[1].maskedPixels).toBeLessThan(230 * 230);
    });
});
