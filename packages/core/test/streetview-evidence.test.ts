/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View evidence for the facade-detail reading: Google captures only, through the grounding service only, at
 * most 4 images, framed on each facade; images kept in memory only (never written, never decoded, never re-encoded);
 * a per-image timeout that lets the others continue; a record naming the missing credential. Then the slots projected
 * into an image at its nominal pose, with occlusion. No network: a fake fetch and a fake grounding service.
 */

import { imageContentSha256 } from '../src/node/image-codec-ffmpeg';
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// any decode of a Street View image fails the test: the codec writes temp files, and decoding is not allowed here
vi.mock('../src/node/image-codec-ffmpeg', async orig => ({
    ...(await orig<typeof import('../src/node/image-codec-ffmpeg')>()),
    decodeImageToRgba: () => { throw new Error('decodeImageToRgba must not be reached'); },
    decodeImageToRgbaSync: () => { throw new Error('decodeImageToRgbaSync must not be reached'); },
    encodeRgbaToJpeg: () => { throw new Error('encodeRgbaToJpeg must not be reached'); },
    encodeRgbaToPng: () => { throw new Error('encodeRgbaToPng must not be reached'); }
}));
vi.mock('../src/node/spatial/StreetViewPoseRegistrar', async orig => ({
    ...(await orig<typeof import('../src/node/spatial/StreetViewPoseRegistrar')>()),
    decodeImageToRgba: () => { throw new Error('the registrar decoder must not be reached'); }
}));

import {
    discoverPanos, facadeGeometry, fetchViews, missingCredentials, type PanoCandidate, type SelectedView
} from '../src/node/3d-engine/staged-location/streetview-evidence';
import { selectViewsForFit } from '../src/node/3d-engine/staged-location/evidence-aim';
import { projectSlots, uncertaintyPx, chartPoint } from '../src/node/3d-engine/staged-location/slot-projection';
import { geodeticToScan, scanToGeodetic } from '../src/node/spatial/StreetViewSurveyPlanner';
import { MAX_STREET_VIEW_IMAGES_PER_BUILDING } from '../src/common/spatial/staged-location-contracts';
import { structureFit } from './helpers/staged-location-fixtures';
import { STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sv-evidence-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ORIGIN = { lat: 40.73122, lng: -73.99709, heightMeters: -23.5 };

/** A JPEG with only SOI, APP0, SOF0 (its size) and a payload: enough for a header read, never decodable. */
function fakeJpeg(width: number, height: number, payload: number): Buffer {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, crypto.randomBytes(payload), Buffer.from([0xff, 0xd9])]);
}

/** The arch's box: 26.3 × 11 m footprint, 24.4 m tall, facades north, east, south, west. */
const STRUCTURE = {
    outline: [[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]] as Array<[number, number]>,
    centroid: { x: 0, z: 0 },
    facadeHeadingsDeg: [0, 90, 180, 270],
    cells: new Set<string>(),
    groundY: 0,
    heightM: 24.4
};
for (let x = -13; x < 13; x++) for (let z = -5; z < 5; z++) STRUCTURE.cells.add(`${x},${z}`);
const GROUND = { cellIndex: () => -1, groundAt: () => 0 };

/** Every file under each dir (path -> size:mtime), to `maxDepth` levels (the codec writes its temp files at the top). */
function snapshot(dirs: Array<[string, number]>): Map<string, string> {
    const out = new Map<string, string>();
    let limit = 0;
    const walk = (d: string, depth: number) => {
        if (depth > limit || !fs.existsSync(d)) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } // a folder the sandbox does not list
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!/node_modules|\.git$/.test(p)) walk(p, depth + 1); }
            else { try { const s = fs.statSync(p); out.set(p, `${s.size}:${s.mtimeMs}`); } catch { /* raced */ } }
        }
    };
    for (const [d, maxDepth] of dirs) { limit = maxDepth; walk(d, 0); }
    return out;
}

describe('Street View evidence', () => {
    it('names the missing credential, and needs both', () => {
        expect(missingCredentials({})).toBe('Street View not configured: no Google Maps API key for pano discovery; no service account for the Maps Imagery Grounding API');
        expect(missingCredentials({ mapsApiKey: 'k', groundingUnavailable: 'the service account cannot issue a token' })).toBe('Street View not configured: the service account cannot issue a token');
        expect(missingCredentials({ mapsApiKey: 'k', grounding: { retrieveGroundingImage: async () => { throw new Error('x'); } } })).toBeUndefined();
    });

    it('discovers Google captures only (old ones kept for the score to weigh), thinned to 6 m, and caches only ids, places and dates', async () => {
        const facades = facadeGeometry(STRUCTURE);
        const north = scanToGeodetic(ORIGIN, 0, 0, -30), north2 = scanToGeodetic(ORIGIN, 3, 0, -30), east = scanToGeodetic(ORIGIN, 35, 0, 0), old = scanToGeodetic(ORIGIN, 0, 0, 40), user = scanToGeodetic(ORIGIN, -35, 0, 0);
        const fetchImpl = (async (url: string) => {
            const loc = new URL(url).searchParams.get('location')!.split(',').map(Number);
            const p = geodeticToScan(ORIGIN, loc[0], loc[1]);
            const near = (q: { lat: number; lng: number }) => { const s = geodeticToScan(ORIGIN, q.lat, q.lng); return Math.hypot(s.x - p.x, s.z - p.z) < 12; };
            const body = near(north) ? { status: 'OK', pano_id: 'N1', location: north, date: '2025-06', copyright: '© Google' }
                : near(north2) ? { status: 'OK', pano_id: 'N2', location: north2, date: '2024-06', copyright: '© Google' }
                    : near(east) ? { status: 'OK', pano_id: 'E1', location: east, date: '2025-01', copyright: '© Google' }
                        : near(old) ? { status: 'OK', pano_id: 'OLD', location: old, date: '2019-03', copyright: '© Google' }
                            : near(user) ? { status: 'OK', pano_id: 'USER', location: user, date: '2025-08', copyright: '© Jane Doe' }
                                : { status: 'ZERO_RESULTS' };
            return { ok: true, status: 200, statusText: 'OK', json: async () => body } as any;
        }) as typeof fetch;
        const cachePath = path.join(TMP, 'sv_meta.json');
        const d = await discoverPanos(ORIGIN, facades, { mapsApiKey: 'test-key', fetchImpl, metadataCachePath: cachePath });
        expect(d.panos.map(p => p.panoId).sort()).toEqual(['E1', 'N1', 'OLD']); // N2 thinned (3 m from N1, older), USER not Google; age is a score factor, not a filter
        expect(d.rejectedNotGoogle).toBe(1);
        const cached = fs.readFileSync(cachePath, 'utf8');
        expect(cached).not.toContain('test-key');
        for (const rec of Object.values(JSON.parse(cached)) as any[]) expect(Object.keys(rec).every(k => ['status', 'panoId', 'lat', 'lng', 'date', 'copyright'].includes(k))).toBe(true);
        // a repeat is served from the cache
        const again = await discoverPanos(ORIGIN, facades, { mapsApiKey: 'test-key', fetchImpl: (() => { throw new Error('no network'); }) as any, metadataCachePath: cachePath });
        expect(again.metadataCalls).toBe(0);
        expect(again.panos.map(p => p.panoId).sort()).toEqual(['E1', 'N1', 'OLD']);
    });

    it('selects views from the fitted slots: only panos in front of a slot, framed on it, never more than 4', () => {
        const fit = structureFit();
        const pano = (id: string, x: number, z: number, date = '2025-06'): PanoCandidate => ({ panoId: id, lat: 0, lng: 0, x, z, date, copyright: '© Google' });
        // the fixture's slots S01 (north spandrel) and S02 (cornice) sit on the NORTH face (outward -z); S03 is the soffit
        const panos = [pano('N1', -6, -30), pano('SOUTH', 0, 40), pano('FAR', 0, -190)];
        const views = selectViewsForFit(panos, fit, STRUCTURE, GROUND, new Float32Array(0));
        expect(views.length).toBeGreaterThan(0);
        expect(views.length).toBeLessThanOrEqual(MAX_STREET_VIEW_IMAGES_PER_BUILDING);
        // a pano south of the arch never looks at the north face's slots; one 190 m away is out of range
        expect(views.some(v => v.panoId === 'SOUTH' || v.panoId === 'FAR')).toBe(false);
        const n1 = views[0];
        expect(n1.panoId).toBe('N1');
        // looks south at the slot: heading near 180, aimed up (elevation positive = up in the app's convention)
        expect(n1.headingDeg).toBeGreaterThan(150); expect(n1.headingDeg).toBeLessThan(200);
        expect(n1.pitchDeg).toBeGreaterThan(0);
        expect(n1.fovDeg).toBeGreaterThanOrEqual(30); expect(n1.fovDeg).toBeLessThanOrEqual(60);
        expect(n1.aimedSlotIds?.length).toBe(1);
        expect(views.every(v => v.panoId === 'N1')).toBe(true);
        expect(selectViewsForFit(panos, fit, STRUCTURE, GROUND, new Float32Array(0), 0)).toEqual([]);
    });

    it('fetches in parallel, times one image out while the others land, and keeps the bytes in memory only, undecoded', async () => {
        const mk = (panoId: string, x: number, z: number, aspectRatio: 'RATIO_4X3' | 'RATIO_3X4', pitchDeg: number): SelectedView => ({
            panoId, date: '2025-06', copyright: '© Google', eye: [x, 2.5, z], facadeHeadingDeg: 0, headingDeg: 90, pitchDeg, fovDeg: 50, aspectRatio, distanceM: 30, score: 1
        });
        const views = [mk('N1', 0, -30, 'RATIO_4X3', 20), mk('E1', 40, 0, 'RATIO_3X4', 20), mk('S1', 0, 35, 'RATIO_4X3', 20)];
        const sent = new Map<string, Buffer>();
        const signals: Array<AbortSignal | undefined> = [];
        const pitchSent = new Map<string, number>();
        const grounding = {
            retrieveGroundingImage: async (req: any, signal?: AbortSignal) => {
                signals.push(signal);
                pitchSent.set(req.panoId, req.pitchDegree);
                if (req.panoId === 'S1') {
                    return new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
                }
                const bytes = fakeJpeg(req.aspectRatio === 'RATIO_3X4' ? 480 : 640, req.aspectRatio === 'RATIO_3X4' ? 640 : 480, 20_000);
                sent.set(req.panoId, bytes);
                return { image: bytes, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
            }
        };
        const watched: Array<[string, number]> = [[TMP, 8], [os.tmpdir(), 2]];
        const before = snapshot(watched);
        const stop = new AbortController();
        const t0 = Date.now();
        const r = await fetchViews(views, { mapsApiKey: 'k', grounding }, stop.signal, 300);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.images.map(i => i.view.panoId).sort()).toEqual(['E1', 'N1']);
        expect(r.failures).toEqual([expect.objectContaining({ error: 'timed out after 0.3 s', transient: true })]);
        expect(signals.every(s => s instanceof AbortSignal)).toBe(true);
        // the app's elevation +20 (up) goes to the API as pitch -20: the grounding API counts down as positive
        expect(pitchSent.get('N1')).toBe(-20);
        for (const img of r.images) {
            // the bytes sent are the bytes received, and the size came from the header
            expect(img.bytes.equals(sent.get(img.view.panoId)!)).toBe(true);
            // the content hash: the JPEG without its metadata segments (the grounding API re-signs each answer)
            expect(img.sha256).toBe(imageContentSha256(sent.get(img.view.panoId)!));
            expect([img.widthPx, img.heightPx]).toEqual(img.view.aspectRatio === 'RATIO_3X4' ? [480, 640] : [640, 480]);
            expect(img.id).toBe(`sv:${img.view.panoId}:${img.view.headingDeg}:${img.view.pitchDeg}:${img.view.fovDeg}`);
            // the grounding camera: fx = 960 / tan(fov / 2) at the delivered crop (groundingFocalPx)
            expect(img.nativeSampleM).toBeCloseTo(img.view.distanceM * Math.tan(img.view.fovDeg * Math.PI / 360) / 960 * (Math.min(1920, 1280 * img.widthPx / img.heightPx) / img.widthPx), 9);
        }
        // nothing new on disk: no image, no temp file, anywhere under the workspace temp dir or the system temp dir
        const after = snapshot(watched);
        const added = [...after.keys()].filter(f => !before.has(f));
        const holding = added.filter(f => { try { const b = fs.readFileSync(f); return [...sent.values()].some(s => b.includes(s.subarray(40, 200))); } catch { return false; } });
        expect(holding).toEqual([]);
        expect(added.filter(f => f.startsWith(TMP))).toEqual([]);
    });

    it('projects each slot into an image at the nominal pose, with occlusion, in 0-1000 [y, x] polygons', () => {
        const fit = structureFit();
        // the north face s00: a plane at z = -5.5 facing north; slot S01 is a 6 × 6 m region on it, S02 the cornice crease
        const north = fit.surfaces.find(s => s.id === 's00')!;
        expect(chartPoint(north.chart, 2, 12)).toEqual([-11.15, 12, -5.5]);
        const view = { eye: [-6, 2.5, -30] as [number, number, number], headingDeg: 180, pitchDeg: 15, fovDeg: 70, widthPx: 640, heightPx: 480 };
        const empty = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
        const shown = projectSlots(fit, view, empty);
        const s01 = shown.find(s => s.slotId === 'S01')!;
        expect(s01.visibleFraction).toBe(1);
        expect(s01.polygon1000.length).toBeGreaterThanOrEqual(8);
        expect(s01.polygon1000.every(v => v >= 0 && v <= 1000)).toBe(true);
        // looking south at the north face from x = -6, west is to the right: the spandrel (x -11.15..-5.15) spans from
        // 0.85 m east of the eye's line (left of centre) to 5.15 m west (right), above the horizon
        const xs = s01.polygon1000.filter((_, i) => i % 2 === 1), ys = s01.polygon1000.filter((_, i) => i % 2 === 0);
        expect(Math.min(...xs)).toBeGreaterThan(440);
        expect(Math.min(...xs)).toBeLessThan(500);
        expect(Math.max(...xs)).toBeGreaterThan(600);
        expect(Math.max(...xs)).toBeLessThan(700);
        expect(Math.max(...ys)).toBeLessThan(500);
        expect(shown.some(s => s.slotId === 'S02')).toBe(true);
        // a wall 3 m in front of the face, as tall as the spandrel, occludes it
        const wall = { vertices: Float32Array.from([-15, 0, -8.5, 0, 0, -8.5, 0, 22, -8.5, -15, 22, -8.5]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
        const occluded = projectSlots(fit, view, wall).find(s => s.slotId === 'S01')!;
        expect(occluded.visibleFraction).toBe(0);
        // the pose uncertainty in pixels at 25 m in this image
        // the grounding focal length: a 640 x 480 copy of the 4:3 crop (1707 px wide) of the 1920 px frame
        expect(uncertaintyPx(25, 70, 640, 480)).toBeCloseTo((640 / 1706.6666666666667) * (960 / Math.tan(35 * Math.PI / 180)) * (2 / 25 + 2 * Math.PI / 180), 6);

        // screenshot: the depth render from that pose with the slot polygons drawn
        const depth = HeadlessMeshSilhouetteRenderer.renderMesh(wall as any, { x: -6, y: 2.5, z: -30, targetX: -6, targetY: 2.5 + Math.tan(15 * Math.PI / 180) * 100, targetZ: 70, fov: 2 * Math.atan(Math.tan(35 * Math.PI / 180) * 0.75) * 180 / Math.PI } as any, 640, 480, { clipNearPlane: true });
        const rgba = new Uint8Array(640 * 480 * 4);
        for (let i = 0; i < 640 * 480; i++) { const d = depth.depthBuffer[i]; const g = d < 1e8 ? 120 : 235; rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g + 5; rgba[i * 4 + 3] = 255; }
        for (const s of shown) {
            const pts = [];
            for (let i = 0; i < s.polygon1000.length; i += 2) pts.push([s.polygon1000[i + 1] * 0.64, s.polygon1000[i] * 0.48]);
            for (let i = 0; i < pts.length; i++) {
                const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
                for (let t = 0; t <= 1; t += 0.002) {
                    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
                    if (x >= 0 && x < 640 && y >= 0 && y < 480) { const o = (y * 640 + x) * 4; rgba[o] = 0; rgba[o + 1] = 114; rgba[o + 2] = 178; }
                }
            }
        }
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'slot_projection_north_view.png'), HeadlessMeshSilhouetteRenderer.encodePng(640, 480, rgba));
    });
});
