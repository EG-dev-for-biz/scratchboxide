/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { encode as encodeJpeg } from 'jpeg-js';
import { glbRaycaster, planStreetViewStations, snapVantageToDrivenSidewalk, snapVantageToSidewalk, SNAP_STANDOFF_M, streetViewStation, vantageStreetPoints, VANTAGE_VIEW_OFFSETS_DEG, type VectorStreet } from '../src/node/spatial/street-view-stations';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../src/node/spatial/StreetViewSurveyPlanner';
import { BeautifyStationService, createGoogleStationImageGenerator, STATION_EMPTY_IMAGE_ATTEMPTS, warpCoverage, type StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaAssetStore } from '../src/node/media-asset-store';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import type { GroundingImageRequest } from '../src/node/spatial/StreetViewGroundingImageService';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: 40.7505, lng: -73.9925, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test vantage' };
const ORIGIN: GeodeticOrigin = { lat: ANCHOR.lat, lng: ANCHOR.lng, heightMeters: ANCHOR.elevationMeters };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-street-stations-'));
const GLB = path.join(WORK, 'box_ground.glb');

/** A stand-in grounding photograph: a real baseline JPEG (3:2), its bytes kept to compare against what reaches the model. */
function photoJpeg(w = 96, h = 64): Buffer {
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = 150 + (i % 50); data[i * 4 + 1] = 120; data[i * 4 + 2] = 90; data[i * 4 + 3] = 255; }
    return Buffer.from(encodeJpeg({ data, width: w, height: h }, 90).data);
}

/** Every file under `dir` whose bytes equal `bytes`. */
function filesWithBytes(dir: string, bytes: Buffer): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesWithBytes(p, bytes));
        else if (fs.statSync(p).size === bytes.length && fs.readFileSync(p).equals(bytes)) out.push(p);
    }
    return out;
}

/** The blockout recoloured (geometry untouched), recording what each call was given. */
function recolour(calls: Array<{ prompt: string; photo?: Buffer; reference: boolean }>): StationImageGenerator {
    return {
        name: 'mock-recolour',
        async generate(args) {
            calls.push({ prompt: args.prompt, ...(args.groundingPhoto ? { photo: args.groundingPhoto.bytes } : {}), reference: !!args.referencePng });
            const b = decodePng(args.blockoutPng);
            const out = Buffer.alloc(b.rgba.length);
            for (let i = 0; i < b.rgba.length; i += 4) {
                const r = b.rgba[i], g = b.rgba[i + 1], bl = b.rgba[i + 2];
                const isSky = bl > 170 && r < 140;
                if (isSky) { out[i] = 135; out[i + 1] = 170; out[i + 2] = 215; }
                else if (Math.abs(r - g) < 6 && r < 150) { out[i] = 170; out[i + 1] = 70; out[i + 2] = 50; }
                else { out[i] = 200; out[i + 1] = 170; out[i + 2] = 120; }
                out[i + 3] = 255;
            }
            return encodePng(b.width, b.height, out);
        }
    };
}

beforeAll(() => {
    // a 10 m box 25 m east of the vantage, on a 200 m ground plane at y = 0
    writeBoxGroundGlb(GLB, [20, 0, -10], [30, 15, 10], 100);
});
afterAll(() => fs.removeSync(WORK));

describe('vantageStreetPoints', () => {
    it('lays the discovery grid across the look direction (the walk) and along it (the street in front)', () => {
        const pts = vantageStreetPoints({ x: 0, z: 0 }, 90, 12, 12);
        expect(pts).toHaveLength(9); // 3 along the walk x 3 ahead
        // looking east: the walk runs north-south (z), the reach goes east (+x)
        expect(new Set(pts.map(p => Math.round(p.x)))).toEqual(new Set([0, 6, 12]));
        expect(new Set(pts.map(p => Math.round(p.z)))).toEqual(new Set([-6, 0, 6]));
    });
});

describe('snapVantageToSidewalk', () => {
    // a north-south street along x = 0 with a building whose east face stands 15 m west of it, and a cross street along z = 0
    const SNAP_GLB = path.join(WORK, 'street_building.glb');
    const line = (a: [number, number], b: [number, number]): VectorStreet => ({
        geodeticPath: [a, b].map(([x, z]) => { const g = scanToGeodetic(ORIGIN, x, 0, z); return [g.lng, g.lat] as [number, number]; }), widthM: 8
    });
    const streets = [line([0, -60], [0, 60]), line([-60, 0], [60, 0])];
    beforeAll(() => writeBoxGroundGlb(SNAP_GLB, [-25, 0, -30], [-15, 20, 30], 100));

    it('puts "the west sidewalk" in front of the building line the scan shows, looking across the street', () => {
        const snap = snapVantageToSidewalk({ origin: ORIGIN, place: { x: 0, z: 0 }, sideDeg: 270, headingDeg: 70, streets, ray: glbRaycaster(SNAP_GLB, ORIGIN) })!;
        expect(snap.streetBearingDeg).toBeCloseTo(0, 3);
        expect(snap.buildingLineM).toBeCloseTo(15, 0);
        expect(snap.offsetM).toBeCloseTo(15 - SNAP_STANDOFF_M, 0);
        const at = geodeticToScan(ORIGIN, snap.lat, snap.lng);
        expect(at.x).toBeCloseTo(-(15 - SNAP_STANDOFF_M), 0);
        expect(at.z).toBeCloseTo(0, 1);
        // 70 is within 45 degrees of across (90): across it is
        expect(snap.headingDeg).toBeCloseTo(90, 6);
        expect(snap.reason).toContain('building line');
    });

    it('keeps a heading that is not across the street, and uses the road width where no building stands', () => {
        const snap = snapVantageToSidewalk({ origin: ORIGIN, place: { x: 0, z: 0 }, sideDeg: 90, headingDeg: 0, streets, ray: glbRaycaster(SNAP_GLB, ORIGIN) })!;
        const at = geodeticToScan(ORIGIN, snap.lat, snap.lng);
        expect(snap.headingDeg).toBeCloseTo(0, 6);
        expect(snap.buildingLineM).toBeUndefined();
        expect(at.x).toBeCloseTo(4 + 3, 1); // half the 8 m road and 3 m onto the sidewalk
        expect(snap.reason).toContain('no building line');
    });

    it('finds the street from a landmark set back on the asked side, and refuses a landmark across the street', () => {
        // "the west sidewalk ... at <a building 60 m west of the street>": the street east of it, at the building's level
        const snap = snapVantageToSidewalk({ origin: ORIGIN, place: { x: -60, z: 10 }, sideDeg: 270, streets, ray: glbRaycaster(SNAP_GLB, ORIGIN) })!;
        const at = geodeticToScan(ORIGIN, snap.lat, snap.lng);
        expect(snap.streetBearingDeg).toBeCloseTo(0, 3);
        expect(at.x).toBeCloseTo(-(15 - SNAP_STANDOFF_M), 0);
        expect(at.z).toBeCloseTo(10, 1);
        // the same street's east sidewalk does not lie toward a place west of it, and the cross street faces the wrong way
        expect(snapVantageToSidewalk({ origin: ORIGIN, place: { x: -60, z: 10 }, sideDeg: 90, streets })).toBeNull();
        // without a scan the road width places the viewer, and says so
        const coarse = snapVantageToSidewalk({ origin: ORIGIN, place: { x: -60, z: 10 }, sideDeg: 270, streets })!;
        expect(geodeticToScan(ORIGIN, coarse.lat, coarse.lng).x).toBeCloseTo(-7, 1);
        expect(coarse.reason).toContain('no scan read');
    });

    it('skips a nearer road no Google car drove (a driveway inside the block) for the street that has Street View', async () => {
        const driveway = line([-40, -50], [-40, 50]);
        const asked: Array<{ x: number; z: number }> = [];
        const snap = (await snapVantageToDrivenSidewalk({
            origin: ORIGIN, place: { x: -60, z: 10 }, sideDeg: 270, streets: [driveway, ...streets],
            driven: async c => { asked.push(c); return Math.abs(c.x) < 1; }
        }))!;
        expect(asked).toHaveLength(2); // the driveway first (20 m away), then the street (60 m)
        expect(asked[0].x).toBeCloseTo(-40, 1);
        expect(geodeticToScan(ORIGIN, snap.streetPoint.lat, snap.streetPoint.lng).x).toBeCloseTo(0, 1);
        expect(snap.reason).toContain('1 nearer street had no Street View coverage');
        // nothing driven: the nearest, saying so
        const none = (await snapVantageToDrivenSidewalk({ origin: ORIGIN, place: { x: -60, z: 10 }, sideDeg: 270, streets: [driveway, ...streets], driven: async () => false }))!;
        expect(geodeticToScan(ORIGIN, none.streetPoint.lat, none.streetPoint.lng).x).toBeCloseTo(-40, 1);
        expect(none.reason).toContain('none of the 2 nearest streets had Street View coverage');
    });

    it('picks the street whose side faces the asked direction at a corner, and none when no street is near', () => {
        const north = snapVantageToSidewalk({ origin: ORIGIN, place: { x: 0, z: 0 }, sideDeg: 350, streets, ray: glbRaycaster(SNAP_GLB, ORIGIN) })!;
        expect(north.streetBearingDeg).toBeCloseTo(90, 3); // the east-west street, whose north side faces 350 best
        expect(north.headingDeg).toBeCloseTo(180, 6);
        expect(snapVantageToSidewalk({ origin: ORIGIN, place: { x: 80, z: 80 }, sideDeg: 270, streets, ray: glbRaycaster(SNAP_GLB, ORIGIN) })).toBeNull();
    });
});

describe('planStreetViewStations', () => {
    // two Google panos in the roadway east of the vantage, 12 m apart north-south
    const PANOS = [{ id: 'panoA', x: 8, z: 0 }, { id: 'panoB', x: 8, z: -12 }];
    const JPEG = photoJpeg();
    const asked: GroundingImageRequest[] = [];
    const fetchImpl = (async (url: string) => {
        const loc = new URL(url).searchParams.get('location')!.split(',').map(Number);
        const p = geodeticToScan(ORIGIN, loc[0], loc[1]);
        const near = PANOS.map(q => ({ q, d: Math.hypot(q.x - p.x, q.z - p.z) })).sort((a, b) => a.d - b.d)[0];
        if (near.d > 8) return new Response(JSON.stringify({ status: 'ZERO_RESULTS' }));
        const g = scanToGeodetic(ORIGIN, near.q.x, 0, near.q.z);
        return new Response(JSON.stringify({ status: 'OK', pano_id: near.q.id, location: { lat: g.lat, lng: g.lng }, date: '2025-06', copyright: '© 2025 Google' }));
    }) as unknown as typeof fetch;
    const grounding = {
        async retrieveGroundingImage(req: GroundingImageRequest) {
            asked.push(req);
            return { image: JPEG, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree ?? 0, pitchDegree: req.pitchDegree ?? 0, fovDegree: req.fovDegree ?? 0 };
        }
    };
    let result: Awaited<ReturnType<typeof planStreetViewStations>>;

    beforeAll(async () => {
        result = await planStreetViewStations({
            glbPath: GLB, anchor: ANCHOR,
            vantage: { lat: ANCHOR.lat, lng: ANCHOR.lng, headingDeg: 90, walkMeters: 24, reachMeters: 12, elevationDeg: 12 },
            streetView: { mapsApiKey: 'test-key', grounding, fetchImpl, metadataCachePath: path.join(WORK, 'cache', 'metadata.json') },
            firstId: 500,
            register: async job => ({ frames: job.images.length, panos: 2 })
        });
    });

    it('finds the panos around the vantage and asks four views of each, in the grounding API\'s pitch sign', () => {
        expect(result.discovery.panosUsed).toBe(2);
        expect(result.stations).toHaveLength(2 * VANTAGE_VIEW_OFFSETS_DEG.length);
        expect(new Set(asked.map(a => a.headingDegree))).toEqual(new Set([90, 35, 145, 270]));
        // 12 degrees up is -12 in the API's sign (positive looks down)
        expect(asked.every(a => a.pitchDegree === -12)).toBe(true);
        expect(asked.every(a => a.aspectRatio === 'RATIO_3X2')).toBe(true);
    });

    it('poses each station at its pano, 2.5 m above the street there, looking where it was asked', () => {
        const a = result.stations.find(s => s.photo.panoId === 'panoA' && Math.round(s.station.yawDegrees) === 90)!;
        expect(a.station.id).toBeGreaterThanOrEqual(500);
        expect(a.station.positionLocalENU[0]).toBeCloseTo(8, 3);
        expect(a.station.positionLocalENU[1]).toBeCloseTo(2.5, 3);
        expect(a.station.positionLocalENU[2]).toBeCloseTo(0, 3);
        const up = Math.sin(12 * Math.PI / 180);
        expect(a.station.forwardVector[0]).toBeCloseTo(Math.cos(12 * Math.PI / 180), 3);
        expect(a.station.forwardVector[1]).toBeCloseTo(up, 3);
        expect(a.station.forwardVector[2]).toBeCloseTo(0, 3);
        expect(a.station.rollDegrees).toBe(0);
        expect(a.registration.method).toBe('nominal');
        expect(result.registrationSummary).toContain('0 of 2 panos registered');
    });

    it('carries the photograph in memory, byte for byte, and writes it nowhere', () => {
        for (const s of result.stations) {
            expect(s.photo.bytes.equals(JPEG)).toBe(true);
            expect(s.photo.mimeType).toBe('image/jpeg');
            expect(s.photo.date).toBe('2025-06');
        }
        expect(filesWithBytes(WORK, JPEG)).toEqual([]);
        // only the pano metadata is cached
        expect(fs.readFileSync(path.join(WORK, 'cache', 'metadata.json'), 'utf8')).toContain('panoA');
    });

    it('refuses to run without the grounding service', async () => {
        await expect(planStreetViewStations({
            glbPath: GLB, anchor: ANCHOR, vantage: { lat: ANCHOR.lat, lng: ANCHOR.lng, headingDeg: 90 },
            streetView: { mapsApiKey: 'test-key', groundingUnavailable: 'no service account' }
        })).rejects.toThrow(/Street View stations/);
    });
});

describe('a street station is beautified from its own photograph', () => {
    it('sends the photograph with the Street View seed prompt, and no chained reference', async () => {
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
        const calls: Array<{ prompt: string; photo?: Buffer; reference: boolean }> = [];
        const svc = new BeautifyStationService(renderer, recolour(calls));
        const ctx = { locationName: 'Test Box' };
        const first = await svc.beautify(stationFromLookAt(1, [-20, 3, 30], [25, 7, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR), ctx, { width: 360 });
        expect(first.accepted).toBe(true);
        const photo = { bytes: photoJpeg(), mimeType: 'image/jpeg', panoId: 'panoA', date: '2025-06' };
        const street = streetViewStation(7, { panoId: 'panoA', eye: [-20, 2.5, 0], headingDeg: 90, pitchDeg: 12, fovDeg: 70, widthPx: 360, heightPx: 240 }, ORIGIN, 0);
        const res = await svc.beautify(renderer.enrichStations([street])[0], ctx, { width: 360, reference: first, groundingPhoto: photo });
        expect(res.accepted).toBe(true);
        const call = calls[calls.length - 1];
        expect(call.photo!.equals(photo.bytes)).toBe(true);
        expect(call.reference).toBe(false);
        expect(call.prompt).toContain('Transform this Street View photograph of');
        expect(call.prompt).toContain('The subject is Test Box.');
        expect(res.warp).toBeUndefined();
        expect(res.groundingPanoId).toBe('panoA');
        expect(res.groundingDate).toBe('2025-06');
    });

    it('keeps a street station whose picture disagrees with the scan, after one attempt, at its own pose, and says so', async () => {
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
        let calls = 0;
        // a picture of something else entirely: a vertical stripe pattern the box's edges do not match
        const elsewhere: StationImageGenerator = {
            name: 'mock-elsewhere',
            async generate(args) {
                calls++;
                const b = decodePng(args.blockoutPng);
                const out = Buffer.alloc(b.rgba.length);
                for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) { const v = (x >> 3) % 2 ? 230 : 30, i = (y * b.width + x) * 4; out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255; }
                return encodePng(b.width, b.height, out);
            }
        };
        const street = renderer.enrichStations([streetViewStation(8, { panoId: 'panoA', eye: [-20, 2.5, 0], headingDeg: 90, pitchDeg: 12, fovDeg: 70, widthPx: 360, heightPx: 240 }, ORIGIN, 0)])[0];
        const photo = { bytes: photoJpeg(), mimeType: 'image/jpeg', panoId: 'panoA' };
        const res = await new BeautifyStationService(renderer, elsewhere).beautify(street, { locationName: 'Test Box' }, { width: 360, groundingPhoto: photo, acceptUnmatched: true });
        expect(res.qc.passed).toBe(false);
        expect(res.qc.reason).toBeTruthy();
        expect(res.accepted).toBe(true);
        expect(res.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(res.alignedStation.positionLocalENU).toEqual(street.positionLocalENU);
    });

    it('the Google generator sends the photograph alone, inline, and never through the asset store', async () => {
        const root = fs.mkdtempSync(path.join(WORK, 'gen-'));
        const sent: any[] = [];
        const answer = encodePng(4, 4, Buffer.alloc(64, 200));
        const client = {
            models: {
                async generateContent(req: any) {
                    sent.push(req);
                    return { candidates: [{ content: { parts: [{ inlineData: { data: answer.toString('base64'), mimeType: 'image/png' } }] }, finishReason: 'STOP' }] };
                }
            }
        };
        const assetStore = new MediaAssetStore();
        const mediaService = new GoogleMediaGenerationService(assetStore, async () => client as any);
        const generator = createGoogleStationImageGenerator({ mediaService, assetStore, workspaceRoot: root, fidelity: 'draft', modelPriority: ['fake-image-model'] });
        const photo = photoJpeg();
        const out = await generator.generate({ prompt: 'p', blockoutPng: encodePng(4, 4, Buffer.alloc(64, 90)), groundingPhoto: { bytes: photo, mimeType: 'image/jpeg' }, aspectRatio: '3:2', width: 96, height: 64 });
        const images = sent[0].contents.filter((p: any) => p.inlineData);
        expect(images).toHaveLength(1);
        expect(Buffer.from(images[0].inlineData.data, 'base64').equals(photo)).toBe(true);
        expect(images[0].inlineData.mimeType).toBe('image/jpeg');
        expect(Buffer.isBuffer(out) ? out : out.png).toBeDefined();
        expect(filesWithBytes(root, photo)).toEqual([]);
    });
});

describe('chained references', () => {
    it('warpCoverage: a station sees itself whole and nothing of a view facing away', async () => {
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
        const st = renderer.enrichStations([stationFromLookAt(1, [-20, 3, 30], [25, 7, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR)])[0];
        const away = renderer.enrichStations([stationFromLookAt(2, [-20, 3, 30], [-60, 3, 60], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR)])[0];
        const b = renderer.renderStationBlockout(st, { width: 240, height: 135 });
        const src = { depth: b.depth, width: b.width, height: b.height, intrinsics: b.intrinsics, station: st };
        const self = warpCoverage(src, { intrinsics: b.intrinsics, station: st, width: 240, height: 135 });
        const other = warpCoverage(src, { intrinsics: b.intrinsics, station: away, width: 240, height: 135 });
        expect(self).toBeGreaterThan(0.3); // about half the frame is sky, which has no surface
        expect(other).toBe(0);
    });

    it('a reference answered larger than its blockout is warped at the blockout\'s size, pixel for pixel', async () => {
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
        const st = stationFromLookAt(1, [-20, 3, 30], [25, 7, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        // the model answers at twice the blockout's size, as Nano Banana answers a 1920 blockout at 2528
        const big: StationImageGenerator = {
            name: 'mock-2x',
            async generate(args) {
                const out = decodePng(await recolour([]).generate(args) as Buffer);
                const W = out.width * 2, H = out.height * 2, rgba = Buffer.alloc(W * H * 4);
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.rgba.copy(rgba, (y * W + x) * 4, ((y >> 1) * out.width + (x >> 1)) * 4, ((y >> 1) * out.width + (x >> 1)) * 4 + 4);
                return encodePng(W, H, rgba);
            }
        };
        const svc = new BeautifyStationService(renderer, big);
        const first = await svc.beautify(st, { locationName: 'Test Box' }, { width: 320, maxRerolls: 0 });
        expect(first.image.width).toBe(first.blockout.width * 2);
        const again = await svc.beautify(st, { locationName: 'Test Box' }, { width: 320, maxRerolls: 0, reference: first });
        // the same pose: the warp is the reference itself at the blockout's size wherever the surface landed
        const w = again.warp!;
        expect(w.coveredFraction).toBeGreaterThan(0.3); // the sky has no surface to warp
        const W = first.blockout.width;
        let n = 0, diff = 0;
        for (let i = 0; i < w.mask.length; i++) {
            if (w.mask[i]) continue;
            const x = i % W, y = Math.floor(i / W), si = ((2 * y) * first.image.width + 2 * x) * 4;
            diff += Math.abs(w.rgba[i * 4] - first.image.rgba[si]); n++;
        }
        expect(diff / n).toBeLessThan(12);
    });
});

describe('the splat world opens as a 3D scene', () => {
    const result = { success: true, stations: [], fusedSplatPath: path.join(process.cwd(), 'public', 'tilesets', 'x', 'fused.splat'), fusedSplatCount: 10, tilesetPath: path.join(process.cwd(), 'public', 'tilesets', 'x', 'tileset.json'), metaPath: '', cropBox: { min: [-50, -2, -50] as [number, number, number], max: [50, 40, 50] as [number, number, number] }, durationMs: 0 };

    it('at a street vantage: first-person at the viewer\'s eye, looking along the heading, in a neutral studio', () => {
        const { scene3DData } = SurveySplatPipelineService.toScene3DData(result, ANCHOR, 'Test Place', { vantage: { eye: [3, 1.6, -4], headingDeg: 90 } });
        expect(scene3DData.cameraMode).toBe('fps');
        expect(scene3DData.camera!.position).toEqual([3, 1.6, -4]);
        // heading 90 is east, +x; the target stays at eye height
        expect(scene3DData.camera!.target[0]).toBeCloseTo(23, 6);
        expect(scene3DData.camera!.target[1]).toBeCloseTo(1.6, 6);
        expect(scene3DData.camera!.target[2]).toBeCloseTo(-4, 6);
        expect(scene3DData.environment).toMatchObject({ skybox: 'studio', lighting: 'studio' });
        expect(scene3DData.splatUrl).toBe('/tilesets/x/fused.splat');
    });

    it('without one: orbiting the place, still with no uninvited atmosphere', () => {
        const { scene3DData } = SurveySplatPipelineService.toScene3DData(result, ANCHOR, 'Test Place');
        expect(scene3DData.cameraMode).toBe('orbit');
        expect(scene3DData.environment).toMatchObject({ skybox: 'studio', lighting: 'studio' });
    });
});

describe('SurveySplatPipelineService with street stations', () => {
    it('runs the street stations first, from their photographs, bakes them and names their panos', async () => {
        const out = path.join(WORK, 'splats');
        const calls: Array<{ prompt: string; photo?: Buffer; reference: boolean }> = [];
        const photo = { bytes: photoJpeg(), mimeType: 'image/jpeg', panoId: 'panoA', date: '2025-06' };
        const street = streetViewStation(900, { panoId: 'panoA', eye: [-20, 2.5, 0], headingDeg: 90, pitchDeg: 12, fovDeg: 70, widthPx: 480, heightPx: 320 }, ORIGIN, 0);
        const aerial = stationFromLookAt(1, [-20, 12, 30], [25, 7, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const res = await new SurveySplatPipelineService({ generator: recolour(calls) }).run({
            glbPath: GLB, anchor: ANCHOR, stations: [aerial], streetStations: [{ station: street, photo }], outDir: out,
            beautify: { locationName: 'Test Box' }, renderWidth: 480, mode: 'chained', bakeStride: 2, forceRebake: true
        });
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.stations.map(s => s.stationId)).toEqual([900, 1]);
        expect(res.stations[0].groundingPanoId).toBe('panoA');
        expect(res.stations[0].accepted).toBe(true);
        expect(res.stations[0].splatCount).toBeGreaterThan(1000);
        expect(res.stations[1].groundingPanoId).toBeUndefined();
        // the street station's call carried the photograph; the aerial one was anchored on it, without one
        expect(calls[0].photo!.equals(photo.bytes)).toBe(true);
        expect(calls[1].photo).toBeUndefined();
        expect(calls[1].reference).toBe(true);
        expect(res.stations[1].usedReference).toBe(true);
        const meta = await fs.readJson(res.metaPath);
        expect(meta.stations[0].groundingPanoId).toBe('panoA');
        expect(filesWithBytes(out, photo.bytes)).toEqual([]);
    }, 300000);

    it('reuses a street plate only for the camera it was made for', async () => {
        const out = path.join(WORK, 'splats-reuse');
        const calls: Array<{ prompt: string; photo?: Buffer; reference: boolean }> = [];
        const photo = { bytes: photoJpeg(), mimeType: 'image/jpeg', panoId: 'panoA' };
        const at = (pitchDeg: number) => streetViewStation(900, { panoId: 'panoA', eye: [-20, 2.5, 0], headingDeg: 90, pitchDeg, fovDeg: 70, widthPx: 480, heightPx: 320 }, ORIGIN, 0);
        const svc = new SurveySplatPipelineService({ generator: recolour(calls) });
        const run = (pitchDeg: number, forceRebake: boolean) => svc.run({
            glbPath: GLB, anchor: ANCHOR, stations: [], streetStations: [{ station: at(pitchDeg), photo }], outDir: out,
            beautify: { locationName: 'Test Box' }, renderWidth: 480, mode: 'chained', bakeStride: 2, forceRebake
        });
        expect((await run(12, true)).success).toBe(true);
        expect(calls).toHaveLength(1);
        // the same camera: the plate (and its splat) is reused, no image asked
        expect((await run(12, false)).stations[0].imageSource).toMatch(/^Reused the street station splat/);
        expect(calls).toHaveLength(1);
        // the same station id, another camera (the view was levelled): painted again, not baked from the old plate
        expect((await run(0, false)).success).toBe(true);
        expect(calls).toHaveLength(2);
    }, 300000);

    it('runs the survey stations anchored on the street view at the same time, and drops one the model gives no image for', async () => {
        const out = path.join(WORK, 'splats-anchored');
        const photo = { bytes: photoJpeg(), mimeType: 'image/jpeg', panoId: 'panoA' };
        const street = streetViewStation(900, { panoId: 'panoA', eye: [-20, 2.5, 0], headingDeg: 90, pitchDeg: 12, fovDeg: 70, widthPx: 480, heightPx: 320 }, ORIGIN, 0);
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const survey = [
            stationFromLookAt(1, [-20, 12, 30], [25, 7, 0], optics, ANCHOR),
            stationFromLookAt(2, [-25, 14, -25], [25, 7, 0], optics, ANCHOR),
            stationFromLookAt(3, [-30, 10, 5], [25, 7, 0], optics, ANCHOR)
        ];
        const inner = recolour([]);
        let inFlight = 0, maxInFlight = 0;
        const references: boolean[] = [];
        const gen: StationImageGenerator = {
            name: 'mock-concurrent',
            async generate(args) {
                inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    await new Promise(r => setTimeout(r, 150));
                    if (!args.groundingPhoto) references.push(!!args.referencePng);
                    // station 2 (known by its coordinates in the prompt) is the one the model answers with no image, every time
                    if (args.prompt.includes(`${survey[1].coordinatesWGS84.lat.toFixed(6)}, ${survey[1].coordinatesWGS84.lng.toFixed(6)}`)) throw new MediaModelUnavailableError('mock-image', 'Image generation returned no image (STOP)');
                    return inner.generate(args);
                } finally { inFlight--; }
            }
        };
        const res = await new SurveySplatPipelineService({ generator: gen }).run({
            glbPath: GLB, anchor: ANCHOR, stations: survey, streetStations: [{ station: street, photo }], outDir: out,
            beautify: { locationName: 'Test Box' }, renderWidth: 480, mode: 'chained', bakeStride: 2, forceRebake: true
        });
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        const byId = new Map(res.stations.map(s => [s.stationId, s]));
        expect(byId.get(2)!.accepted).toBe(false);
        expect(byId.get(2)!.qc.reason).toContain(`no image after ${STATION_EMPTY_IMAGE_ATTEMPTS} attempts`);
        expect(byId.get(1)!.accepted).toBe(true);
        expect(byId.get(3)!.accepted).toBe(true);
        // every survey station call carried a street-anchored reference, and they overlapped in time
        expect(references.every(Boolean)).toBe(true);
        expect(maxInFlight).toBeGreaterThan(1);
    }, 300000);
});
