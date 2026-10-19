/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * streetview_survey on a synthetic street with known truth, no network: a 12 x 10 x 14 m building with a lattice of dark
 * windows, a kiosk in front of its south face, panos on a ring around it. The metadata endpoint answers from that ring
 * (Google captures, one of them refused by the "grounding API"); the grounding service renders the world from each pano's
 * TRUE pose (the stated pano position off by a known shift and yaw) and returns a real JPEG. The tool must: isolate the
 * structure from the staged caches, replace the refused pano and report it, write the bytes exactly as returned, register
 * the views closer to the truth than the nominal poses, cut out the structure and the kiosk, and report coverage per face.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { building, groundGrid, writeTris, type Tri } from './helpers/staged-synthetic-world';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import type { StagedExtraction, StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../src/node/spatial/StreetViewSurveyPlanner';
import { elevationForGroundingPitch, type GroundingImage, type GroundingImageRequest } from '../src/node/spatial/StreetViewGroundingImageService';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { renderFrameDepth, readGlbScene, sceneToRenderMesh, ZERO_CORRECTION, type FrameCamera, type PoseCorrection } from '../src/node/spatial/StreetViewPoseRegistrar';
import { runPanoRegistration } from '../src/node/3d-engine/staged-location/pano-registration-run';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeJpegInMemory } from '../src/node/3d-engine/staged-location/photo-palette';
import { imageContentSha256 } from '../src/node/image-codec-ffmpeg';
import {
    prepareSurveySite, runStreetViewSurvey, structureFaces, StreetViewSurveyCredentialsError, StreetViewSurveyNoCoverageError, cameraAngles, facesToCover,
    type StreetViewSurveyDeps, type SurveySite
} from '../src/node/gemini/tools/location-evidence/streetview-survey';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { DEFAULT_TOOL_DECLARATIONS } from '../src/node/gemini/tools';

const ORIGIN: GeodeticOrigin = { lat: 40.7306, lng: -73.9975, heightMeters: 0 };
const W = 640, H = 480;
const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/tool_sv_survey');

/** The panos: a ring 24 m round the building, every 30°, and the truth each one's stated position misses by. */
const PANOS = Array.from({ length: 12 }, (_, k) => {
    const a = (k * 30 + 15) * Math.PI / 180;
    const x = 24 * Math.sin(a), z = -24 * Math.cos(a);
    const g = scanToGeodetic(ORIGIN, x, 0, z);
    return { panoId: `synthPano${String(k).padStart(2, '0')}`, x, z, lat: g.lat, lng: g.lng, date: `2024-0${1 + (k % 9)}`,
        truth: { ...ZERO_CORRECTION, dx: 0.6 * Math.cos(a * 3), dz: 0.6 * Math.sin(a * 2), dyawDeg: 1.2 * Math.sin(a) } as PoseCorrection };
});
/** The grounding API refuses the first two panos it is asked for (as it does user photospheres and unpublished panos). */
const REFUSED = new Set<string>();

const KIOSK: [number, number, number, number, number] = [-1.5, 1.5, 7, 8.5, 3];

function worldTris(): Tri[] {
    return [...groundGrid(90, 4), ...building(-6, 6, -5, 5, 14), ...building(...KIOSK)];
}

/** Colour of a world point: walls a warm stone with a lattice of dark windows, roof grey, kiosk green, ground asphalt. */
function shade(p: [number, number, number], n: [number, number, number]): [number, number, number] {
    const inKiosk = p[0] > KIOSK[0] - 0.05 && p[0] < KIOSK[1] + 0.05 && p[2] > KIOSK[2] - 0.05 && p[2] < KIOSK[3] + 0.05 && p[1] < KIOSK[4] + 0.05;
    if (inKiosk) return [40, 150, 60];
    if (p[1] < 0.05) return [95, 95, 100];
    if (p[1] > 13.95) return [150, 150, 150];
    const along = Math.abs(n[0]) > 0.5 ? p[2] : p[0];
    const wx = ((along % 2.5) + 2.5) % 2.5, wy = ((p[1] % 3.5) + 3.5) % 3.5;
    const window = p[1] > 1.2 && wx > 0.7 && wx < 1.8 && wy > 1.0 && wy < 2.8;
    const tone = Math.abs(n[0]) > 0.5 ? 0 : 18;
    return window ? [45, 50, 60] : [200 - tone, 150 - tone, 110 - tone];
}

/** The photo a camera takes of the world: real JPEG bytes. */
function photo(mesh: { vertices: Float32Array; indices: Uint32Array }, cam: FrameCamera): Buffer {
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
            c = shade(p, n);
        }
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    return Buffer.from(jpegJs.encode({ data: rgba, width: cam.width, height: cam.height }, 92).data);
}

/** The structure's outline (where the building is the nearest surface) drawn red over a decoded view; the kiosk outline in green. */
function outlined(jpeg: Buffer, structure: { vertices: Float32Array; indices: Uint32Array }, cam: FrameCamera): Uint8Array {
    const img = decodeJpegInMemory(jpeg);
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = img.data[i * 4 + c];
    const d = renderFrameDepth(structure, cam);
    const on = (i: number) => d[i] < 1e8;
    for (let y = 1; y < img.height - 1; y++) for (let x = 1; x < img.width - 1; x++) {
        const i = y * img.width + x;
        if (on(i) && (!on(i - 1) || !on(i + 1) || !on(i - img.width) || !on(i + img.width))) for (const k of [-1, 0, 1]) rgb.set([255, 0, 0], (i + k) * 3);
    }
    return rgb;
}

function contactSheet(tiles: Uint8Array[], tw: number, th: number, cols: number): { png: Buffer } {
    const rows = Math.ceil(tiles.length / cols), SW = cols * tw, SH = rows * th;
    const out = new Uint8Array(SW * SH * 3).fill(30);
    tiles.forEach((t, k) => {
        const ox = (k % cols) * tw, oy = Math.floor(k / cols) * th;
        for (let y = 0; y < th; y++) out.set(t.subarray(y * tw * 3, (y + 1) * tw * 3), ((oy + y) * SW + ox) * 3);
    });
    return { png: encodePng(SW, SH, out, 3) };
}

describe('streetview_survey (synthetic street, recorded-style inputs, no network)', () => {
    let root: string;
    let site: SurveySite;
    let worldMesh: { vertices: Float32Array; indices: Uint32Array };
    const served = new Map<string, Buffer>();
    let groundingCalls = 0;

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
            if (REFUSED.size < 2 && !served.has(req.panoId)) REFUSED.add(req.panoId);
            if (REFUSED.has(req.panoId)) throw new Error('Maps Imagery Grounding API 403: Pano is not published or eligible. (use a Google-captured panorama, not a user photosphere)');
            const p = PANOS.find(x => x.panoId === req.panoId)!;
            // the true camera: the pano's stated eye (2.5 m above the street) moved by its truth; the request's pitch is the API's (down positive)
            const cam = castCamera({ eye: [p.x, 2.5, p.z], headingDeg: req.headingDegree!, pitchDeg: elevationForGroundingPitch(req.pitchDegree!), fovDeg: req.fovDegree!, widthPx: W, heightPx: H, correction: p.truth });
            const image = photo(worldMesh, cam);
            served.set(`${req.panoId}`, image);
            return { image, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree!, pitchDegree: req.pitchDegree!, fovDegree: req.fovDegree! };
        }
    };

    const surveyDeps = (over: Partial<StreetViewSurveyDeps> = {}): StreetViewSurveyDeps => ({
        streetView: { mapsApiKey: 'test-key', grounding, fetchImpl: metadataFetch, metadataCachePath: path.join(root, 'sv', 'metadata.json'), refusedPanos: new Map() },
        // inline (no worker thread), with budgets a test can afford
        register: async (job, o) => runPanoRegistration({ ...job, edgeBudgetMs: 40_000, jointBudgetMs: 40_000 }, o.log),
        // the segmenter: the photo's own pixels of the building's stone and windows (what a cut-out of this photo shows)
        segmenter: async image => {
            const m = new Uint8Array(image.width * image.height);
            for (let i = 0; i < m.length; i++) {
                const r = image.rgba[i * 4], g = image.rgba[i * 4 + 1], b = image.rgba[i * 4 + 2];
                const stone = r > 150 && r - b > 50, glass = r < 70 && g < 75 && b < 85 && b > 35;
                m[i] = stone || glass ? 1 : 0;
            }
            return m;
        },
        ...over
    });

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-survey-tool-'));
        const file = writeTris(path.join(root, 'world.glb'), worldTris());
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
    }, 120_000);

    afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    it('isolates the structure from the staged caches (the building, not the kiosk)', () => {
        expect(site.structure.heightM).toBeGreaterThan(12);
        expect(site.structure.areaM2).toBeGreaterThan(100);
        expect(site.structure.areaM2).toBeLessThan(150);
        expect(site.structureMeshSource).toBe('scan-crop');
        expect(site.structureMesh.indices.length / 3).toBeGreaterThan(100);
        // its four facades
        expect(site.structure.facadeHeadingsDeg.length).toBe(4);
    });

    it('surveys every face: refusals replaced and reported, bytes as returned, poses registered nearer the truth, masks, coverage', async () => {
        const outDir = path.join(root, 'build', 'streetview-grounding');
        const res = await runStreetViewSurvey(site, { maxViews: 6, ownershipMasks: true, outDir, workspaceRoot: root }, surveyDeps());

        expect(res.views.length).toBe(6);
        expect(res.discovery.panosFound).toBeGreaterThanOrEqual(10);
        // every view a different pano, none of them a refused one
        expect(new Set(res.views.map(v => v.panoId)).size).toBe(res.views.length);
        for (const v of res.views) expect(REFUSED.has(v.panoId)).toBe(false);

        // the bytes on disk are exactly those served
        for (const v of res.views) {
            const onDisk = fs.readFileSync(path.join(root, v.imagePath));
            expect(onDisk.equals(served.get(v.panoId)!)).toBe(true);
            expect(v.contentSha256).toBe(imageContentSha256(onDisk));
            expect(v.captureMonth).toMatch(/^2024-0\d$/);
            expect(v.imagePath.startsWith(path.join('build', 'streetview-grounding'))).toBe(true);
            // the API's pitch is the elevation with its sign flipped
            expect(v.request.pitchDeg).toBeCloseTo(-v.request.elevationDeg, 6);
            expect(v.camera.orientation.apiPitchDeg).toBeCloseTo(-v.camera.orientation.elevationDeg, 3);
            // fx = fy = (width / crop width) x 960 / tan(fov / 2); a 640 x 480 image is a 4:3 crop 1707 px wide
            const fx = (W / (1280 * 4 / 3)) * 960 / Math.tan(v.request.fovDeg * Math.PI / 360);
            expect(v.camera.intrinsics.fx).toBeCloseTo(fx, 2);
            expect(v.camera.intrinsics.fy).toBe(v.camera.intrinsics.fx);
        }

        // the faces the refused panos were planned for got another pano, and the refusals are reported once each
        expect(res.refusals.length).toBeGreaterThan(0);
        for (const r of res.refusals) {
            expect(REFUSED.has(r.panoId)).toBe(true);
            expect(r.error).toContain('not published or eligible');
            expect(r.replacedBy).toBeDefined();
            expect(res.views.some(v => v.panoId === r.replacedBy && v.faceId === r.faceId)).toBe(true);
        }
        expect(res.fetchFailures).toEqual([]);
        fs.writeFileSync(path.join(SHOTS, 'synthetic_result.json'), JSON.stringify(res, null, 1));
        expect(groundingCalls).toBeGreaterThanOrEqual(res.views.length);

        // registration: at least half the views were posed against the mesh, and those land nearer the true eye than the nominal one
        const registered = res.views.filter(v => v.registration.method !== 'nominal');
        expect(registered.length).toBeGreaterThanOrEqual(3);
        let nearer = 0;
        for (const v of registered) {
            const p = PANOS.find(x => x.panoId === v.panoId)!;
            const truth = [p.x + p.truth.dx, 2.5 + p.truth.dy, p.z + p.truth.dz];
            const after = Math.hypot(v.camera.position.x - truth[0], v.camera.position.y - truth[1], v.camera.position.z - truth[2]);
            const before = Math.hypot(p.x - truth[0], 2.5 - truth[1], p.z - truth[2]);
            if (after < before) nearer++;
            expect(v.registration.residualPx).not.toBeNull();
            expect(v.registration.residualImagePx).not.toBeNull();
        }
        expect(nearer).toBeGreaterThanOrEqual(Math.ceil(registered.length / 2));

        // masks: the building cut out, and the kiosk in front of the south face taken out of it as an occluder
        const masked = res.views.filter(v => v.ownership?.status === 'segmented');
        expect(masked.length).toBeGreaterThanOrEqual(3);
        for (const v of masked) {
            expect(fs.existsSync(path.join(root, v.ownership!.ownerMaskPath!))).toBe(true);
            expect(v.ownership!.ownerPixels!).toBeGreaterThan(1000);
            const png = fs.readFileSync(path.join(root, v.ownership!.occluderMaskPath!));
            expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
        }
        const southViews = masked.filter(v => Math.abs(((v.faceHeadingDeg % 360) + 360) % 360 - 180) < 30);
        if (southViews.length) expect(Math.max(...southViews.map(v => v.ownership!.occluderPixels!))).toBeGreaterThan(200);

        // coverage per face: four faces, all requested, each seen
        expect(res.coverage.length).toBe(4);
        for (const c of res.coverage) {
            expect(c.requested).toBe(true);
            expect(c.coveredFraction).toBeGreaterThan(0.3);
            expect(c.bestViewIndex).toBeDefined();
            expect(c.ownedFraction).toBeDefined();
        }

        // contact sheet: each view with the structure's outline from its returned (registered) camera
        const tiles = res.views.map(v => {
            const k = v.camera.intrinsics, o = v.camera.orientation, p = v.camera.position;
            const cam: FrameCamera = { eye: [p.x, p.y, p.z], right: o.right, up: o.up, fwd: o.forward, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: k.widthPx, height: k.heightPx };
            return outlined(fs.readFileSync(path.join(root, v.imagePath)), site.structureMesh as { vertices: Float32Array; indices: Uint32Array }, cam);
        });
        fs.writeFileSync(path.join(SHOTS, 'synthetic_contact_sheet.png'), contactSheet(tiles, W, H, 3).png);
    }, 300_000);

    it('covers only the faces asked for, and says which headings are no facade', async () => {
        const all = [{ faceId: 'a', headingDeg: 0 }, { faceId: 'b', headingDeg: 90 }] as Parameters<typeof facesToCover>[0];
        const r = facesToCover(all, [85, 200]);
        expect(r.faces.map(f => f.faceId)).toEqual(['b']);
        expect(r.unmatched[0].headingDeg).toBe(200);
        const res = await runStreetViewSurvey(site, { maxViews: 2, faceHeadingsDeg: [site.structure.facadeHeadingsDeg[0]], outDir: path.join(root, 'out2'), workspaceRoot: root }, surveyDeps());
        expect(res.views.length).toBe(2);
        const face = res.coverage.find(c => c.requested)!;
        expect(res.coverage.filter(c => c.requested).length).toBe(1);
        for (const v of res.views) expect(v.faceId).toBe(face.faceId);
        expect(res.views.every(v => v.ownership === undefined)).toBe(true);
    }, 300_000);

    it('throws typed errors: missing credentials, and no Google coverage', async () => {
        await expect(runStreetViewSurvey(site, { outDir: path.join(root, 'x'), workspaceRoot: root }, surveyDeps({ streetView: { grounding, fetchImpl: metadataFetch } })))
            .rejects.toBeInstanceOf(StreetViewSurveyCredentialsError);
        await expect(runStreetViewSurvey(site, { outDir: path.join(root, 'x'), workspaceRoot: root }, surveyDeps({ streetView: { mapsApiKey: 'k', groundingUnavailable: 'no service account', fetchImpl: metadataFetch } })))
            .rejects.toThrow(/no service account/);
        const empty = (async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS' }), { status: 200 })) as unknown as typeof fetch;
        const err = await runStreetViewSurvey(site, { outDir: path.join(root, 'x'), workspaceRoot: root }, surveyDeps({ streetView: { mapsApiKey: 'k', grounding, fetchImpl: empty } })).catch(e => e);
        expect(err).toBeInstanceOf(StreetViewSurveyNoCoverageError);
        expect((err as StreetViewSurveyNoCoverageError).code).toBe('no_coverage');
    }, 120_000);

    it('keeps every facade of a structure with more than four sides as a face', () => {
        const eight = { ...site.structure, facadeHeadingsDeg: [0, 45, 90, 135, 180, 225, 270, 315] };
        const faces = structureFaces(eight);
        expect(faces.map(f => Math.round(f.headingDeg))).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
        expect(new Set(faces.map(f => f.faceId)).size).toBe(8);
    });

    it('reads heading, elevation and roll back from a camera basis', () => {
        const pitched = cameraAngles(castCamera({ eye: [0, 0, 0], headingDeg: 123, pitchDeg: 17, fovDeg: 60, widthPx: W, heightPx: H }));
        expect(pitched.headingDeg).toBeCloseTo(123, 2);
        expect(pitched.elevationDeg).toBeCloseTo(17, 2);
        expect(pitched.rollDeg).toBeCloseTo(0, 2);
        // a level camera rolled about its own axis (the reference heading's forward is then the optical axis)
        const rolled = cameraAngles(castCamera({ eye: [0, 0, 0], headingDeg: 123, pitchDeg: 0, fovDeg: 60, widthPx: W, heightPx: H, correction: { ...ZERO_CORRECTION, drollDeg: 3, referenceHeadingDeg: 123 } }));
        expect(rolled.headingDeg).toBeCloseTo(123, 2);
        expect(rolled.elevationDeg).toBeCloseTo(0, 2);
        expect(rolled.rollDeg).toBeCloseTo(3, 2);
    });

    it('is registered as an in-app agent tool', () => {
        const registry = createDefaultToolRegistry();
        expect(registry.get('streetview_survey')).toBeDefined();
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === 'streetview_survey')).toBe(true);
    });
});
