/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    SurveySynthesisEngine,
    stationToPinhole,
    stationFromLookAt
} from '../src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor, ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';

const OPERA: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12.0, headingDeg: 0, formattedAddress: 'Sydney Opera House' };

const v3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('SurveySynthesisEngine: station synthesis', () => {
    const engine = new SurveySynthesisEngine();

    it('orbital-multi-tier: requested count, three tiers, all stations look at the anchor offset', () => {
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 140, cameraCount: 12, focalLengthMm: 28 });
        expect(poses).toHaveLength(12);
        const tiers = new Set(poses.map(p => Math.round(p.positionLocalENU[1])));
        expect(tiers.size).toBe(3);
        for (const p of poses) {
            // forward vector points from the station to the look-at target [0, 20, 0]
            const toTarget = [0 - p.positionLocalENU[0], 20 - p.positionLocalENU[1], 0 - p.positionLocalENU[2]];
            const len = Math.hypot(...toTarget);
            const dot = p.forwardVector.reduce((s, v, i) => s + v * (toTarget[i] / len), 0);
            expect(dot).toBeGreaterThan(0.9999);
            // yaw/pitch agree with the forward vector (yaw clockwise from north = -Z)
            const yaw = ((Math.atan2(p.forwardVector[0], -p.forwardVector[2]) * 180) / Math.PI + 360) % 360;
            expect(Math.abs(((p.yawDegrees - yaw + 540) % 360) - 180)).toBeLessThan(0.02);
            expect(p.pitchDegrees).toBeLessThan(0); // looking down at the anchor
            expect(p.fovDegrees).toBeCloseTo(2 * Math.atan(18 / 28) * 180 / Math.PI, 1); // 65.5 deg for 28 mm
            expect(p.aspectRatio).toBeCloseTo(16 / 9, 6);
            // WGS84 round trip
            const ltp = new LocalTangentPlane({ lat: OPERA.lat, lng: OPERA.lng, alt: OPERA.elevationMeters });
            const back = ltp.toLocal({ lat: p.coordinatesWGS84.lat, lng: p.coordinatesWGS84.lng, alt: p.coordinatesWGS84.elevation });
            expect(v3(back, p.positionLocalENU)).toBeLessThan(0.05);
        }
    });

    it('street-corridor: eye-height stations along the heading, level pitch', () => {
        const poses = engine.synthesize({ ...OPERA, headingDeg: 90 }, { type: 'street-corridor', targetRadiusMeters: 60, cameraCount: 5, corridorLengthMeters: 100, cameraHeightMeters: 1.7 });
        expect(poses).toHaveLength(5);
        for (const p of poses) {
            expect(p.positionLocalENU[1]).toBeCloseTo(1.7, 3);
            expect(Math.abs(p.positionLocalENU[2])).toBeLessThan(1e-6); // heading 90 = east: motion along +X only
            expect(p.pitchDegrees).toBeCloseTo(0, 6);
            expect(p.yawDegrees).toBeCloseTo(90, 3);
        }
        expect(poses[4].positionLocalENU[0] - poses[0].positionLocalENU[0]).toBeCloseTo(100, 3);
    });

    it('frustum ground footprint has 4 corners within a plausible distance of the anchor', () => {
        const [p] = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 100, cameraCount: 3 });
        expect(p.frustumFootprintWGS84).toHaveLength(4);
        const ltp = new LocalTangentPlane({ lat: OPERA.lat, lng: OPERA.lng, alt: OPERA.elevationMeters });
        for (const [lng, lat] of p.frustumFootprintWGS84!) {
            const l = ltp.toLocal({ lat, lng, alt: OPERA.elevationMeters });
            expect(Math.hypot(l[0], l[2])).toBeLessThan(400);
        }
    });
});

describe('SurveySynthesisEngine: COLMAP text export/ingest', () => {
    const engine = new SurveySynthesisEngine();

    it('export -> ingest round-trips position, forward vector and focal length for every station', () => {
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 120, cameraCount: 9, focalLengthMm: 35 });
        const { camerasText, imagesText } = engine.toColmapText(poses, { width: 1920, height: 1080 });
        expect(camerasText).toMatch(/^1 PINHOLE 1920 1080 /m);
        const back = engine.fromColmapText(camerasText, imagesText, OPERA);
        expect(back).toHaveLength(poses.length);
        for (let i = 0; i < poses.length; i++) {
            expect(v3(back[i].positionLocalENU, poses[i].positionLocalENU)).toBeLessThan(1e-3);
            const dot = back[i].forwardVector.reduce((s, v, k) => s + v * poses[i].forwardVector[k], 0);
            expect(dot).toBeGreaterThan(0.99999);
            expect(back[i].focalLengthMm).toBeCloseTo(35, 1);
            expect(back[i].imageName).toBe(poses[i].imageName);
        }
    });

    it('camera-from-world convention: COLMAP +Z (forward) and +Y (down) map to our forward and -up', () => {
        // Station at [0, 10, 50] looking north (-Z) and level: COLMAP camera z = forward = (0,0,-1), y = down = (0,-1,0)
        const pose = stationFromLookAt(1, [0, 10, 50], [0, 10, 0], { focalLengthMm: 35, sensorWidthMm: 36 }, OPERA);
        const { imagesText } = new SurveySynthesisEngine().toColmapText([pose], { width: 1000, height: 500 });
        const line = imagesText.split('\n').find(l => /^1 /.test(l))!;
        const [, qw, qx, qy, qz, tx, ty, tz] = line.split(/\s+/).map(Number);
        // R_w2c rows: x_cam = (1,0,0), y_cam = (0,-1,0), z_cam = (0,0,-1)  => rotation of 180 deg about X: q = (1,0,0,0) (x,y,z,w)
        expect(Math.abs(qx)).toBeCloseTo(1, 5); expect(qw).toBeCloseTo(0, 5); expect(qy).toBeCloseTo(0, 5); expect(qz).toBeCloseTo(0, 5);
        // t = -R C = -(0, -10, -50) = (0, 10, 50)
        expect(tx).toBeCloseTo(0, 3); expect(ty).toBeCloseTo(10, 3); expect(tz).toBeCloseTo(50, 3);
    });
});

describe('SurveySynthesisEngine: pinhole intrinsics from a station', () => {
    it('derives fx/fy/cx/cy for the station aspect; vertical fov follows from horizontal', () => {
        const pose = stationFromLookAt(1, [0, 1.7, 0], [0, 1.7, -10], { focalLengthMm: 28, sensorWidthMm: 36 }, OPERA);
        const cam = stationToPinhole(pose, 1920, 1080);
        expect(cam.cx).toBeCloseTo(960, 6);
        expect(cam.cy).toBeCloseTo(540, 6);
        expect(cam.fx).toBeCloseTo(1920 / (2 * Math.tan((pose.fovDegrees / 2) * Math.PI / 180)), 3);
        expect(cam.fy).toBeCloseTo(cam.fx, 3); // square pixels
        expect(cam.verticalFovDegrees).toBeCloseTo(2 * Math.atan(540 / cam.fy) * 180 / Math.PI, 6);
    });
});

describe('SurveySynthesisEngine: GeoJSON', () => {
    it('emits one point per station, one footprint polygon per station, and one trajectory line', () => {
        const engine = new SurveySynthesisEngine();
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 120, cameraCount: 6 });
        const gj = engine.toGeoJson(poses, OPERA);
        const types = gj.features.map(f => f.properties?.type);
        expect(types.filter(t => t === 'colmap_station')).toHaveLength(6);
        expect(types.filter(t => t === 'camera_frustum_footprint')).toHaveLength(6);
        expect(types.filter(t => t === 'camera_trajectory_path')).toHaveLength(1);
    });
});

describe('SurveySynthesisEngine: ranking for beautify', () => {
    const engine = new SurveySynthesisEngine();
    const withMetrics = (poses: ColmapCameraPose[], f: (p: ColmapCameraPose, i: number) => Partial<ColmapCameraPose>) =>
        poses.map((p, i) => ({ ...p, ...f(p, i) }));

    it('drops stations with low mesh coverage or too much sky, then maximises angular spread', () => {
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 120, cameraCount: 12 });
        const enriched = withMetrics(poses, (p, i) => ({
            beautify: { meshCoverageFraction: i === 3 ? 0.2 : 0.9, skyFraction: i === 7 ? 0.8 : 0.3 }
        }));
        const ranked = engine.rankForBeautify(enriched, { maxCount: 6 });
        expect(ranked).toHaveLength(6);
        expect(ranked.map(p => p.id)).not.toContain(enriched[3].id);
        expect(ranked.map(p => p.id)).not.toContain(enriched[7].id);
        // Greedy spread: consecutive picks should not be near-duplicates in viewing direction
        for (let a = 0; a < ranked.length; a++) for (let b = a + 1; b < ranked.length; b++) {
            const dot = ranked[a].forwardVector.reduce((s, v, k) => s + v * ranked[b].forwardVector[k], 0);
            expect(dot).toBeLessThan(0.995);
        }
    });

    it('is deterministic and stable for identical input', () => {
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 120, cameraCount: 9 });
        const enriched = withMetrics(poses, () => ({ beautify: { meshCoverageFraction: 0.8, skyFraction: 0.2 } }));
        const a = engine.rankForBeautify(enriched, { maxCount: 5 }).map(p => p.id);
        const b = engine.rankForBeautify(enriched, { maxCount: 5 }).map(p => p.id);
        expect(a).toEqual(b);
    });

    it('without metrics, ranks by spread alone (never throws)', () => {
        const poses = engine.synthesize(OPERA, { type: 'orbital-multi-tier', targetRadiusMeters: 120, cameraCount: 9 });
        expect(engine.rankForBeautify(poses, { maxCount: 4 })).toHaveLength(4);
    });
});
