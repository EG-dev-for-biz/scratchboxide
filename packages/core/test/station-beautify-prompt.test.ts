/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { buildBeautifyPrompt, buildHybridPromptPayload, buildStationBeautifyPrompt } from '../src/browser/generative-canvas/services/location-beautify-service';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'Sydney Opera House' };

const TEMPLATE_BODY = 'This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point.';

describe('Station-grounded AI Beautify prompt', () => {
    const station = {
        ...stationFromLookAt(7, [0, 1.7, 45], [0, 12, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR),
        beautify: { standoffMeters: 42.5, horizonRowFraction: 0.39, skyFraction: 0.44, meshCoverageFraction: 0.95, solar: { azimuthDegrees: 12.3, elevationDegrees: 32.8, isoDate: '2026-06-21T02:00:00Z' } }
    };

    it('keeps the verbatim template body and the exact distance clause, and adds a camera lock clause from the station', () => {
        const prompt = buildStationBeautifyPrompt(station, { locationName: 'Sydney Opera House', moodPromptContext: 'Clear winter noon. ', styleSuffix: ' Editorial architectural photograph.' });
        expect(prompt).toContain(TEMPLATE_BODY);
        expect(prompt).toContain(`(camera at coordinates ${station.coordinatesWGS84.lat.toFixed(6)}, ${station.coordinatesWGS84.lng.toFixed(6)}, facing ${Math.round(station.yawDegrees)}°)`);
        expect(prompt).toContain(' Subject distance: approximately 43 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze).');
        expect(prompt).toContain(` Camera lock: 28mm lens, ${station.fovDegrees.toFixed(1)}° horizontal field of view, pitch ${station.pitchDegrees.toFixed(1)}°, 1.7 m above ground; the horizon sits at 39% of the frame height from the top.`);
        expect(prompt).toContain(' Sun: azimuth 12° clockwise from north, elevation 33° above the horizon; cast shadows accordingly.');
        expect(prompt.endsWith(' Editorial architectural photograph.')).toBe(true);
        // Order: template ... distance ... camera lock ... sun ... style
        const i = (s: string) => prompt.indexOf(s);
        expect(i('Subject distance')).toBeLessThan(i('Camera lock'));
        expect(i('Camera lock')).toBeLessThan(i('Sun:'));
        expect(i('Sun:')).toBeLessThan(i('Editorial'));
    });

    it('without station facts the prompt is unchanged (no camera lock slot emitted)', () => {
        const p = buildBeautifyPrompt({ locationName: 'X', coordinates: { lat: 1, lng: 2 }, heading: 0, distance: 10, styleSuffix: ' S.' });
        expect(p).not.toContain('Camera lock');
        expect(p).not.toContain('Sun:');
        expect(p.endsWith('(use this for depth-of-field, focus, and aerial-perspective haze). S.')).toBe(true);
    });

    it('hybrid payload carries the station fov, focal length, pitch, horizon line and solar ephemeris instead of the 65 deg default', () => {
        const payload = buildHybridPromptPayload({
            locationName: 'Sydney Opera House', coordinates: { lat: station.coordinatesWGS84.lat, lng: station.coordinatesWGS84.lng, altitudeM: station.coordinatesWGS84.elevation },
            heading: station.yawDegrees, pitch: station.pitchDegrees, standoffDistanceM: 42.5,
            foregroundInvariant: 'fg', primaryLandmarkInvariant: 'lm', atmosphereNarrative: '',
            fovDegrees: station.fovDegrees, focalLengthMm: station.focalLengthMm, horizonRowFraction: 0.39,
            solar: { azimuthDegrees: 12.3, elevationDegrees: 32.8 }
        });
        expect(payload.spatial_envelope_lock.camera_pose.fieldOfViewDegrees).toBeCloseTo(station.fovDegrees, 6);
        expect(payload.spatial_envelope_lock.camera_pose.focalLengthMm).toBe(28);
        expect(payload.spatial_envelope_lock.camera_pose.pitchDegrees).toBeCloseTo(station.pitchDegrees, 6);
        expect(payload.spatial_envelope_lock.geometric_invariants.horizonLine).toContain('39%');
        expect(payload.spatial_envelope_lock.solar_ephemeris).toEqual({ azimuthDegrees: 12.3, elevationDegrees: 32.8 });
        expect(payload.rendering_instruction).toContain('Camera lock: 28mm lens');
        // legacy default preserved when fov not supplied
        const legacy = buildHybridPromptPayload({ locationName: 'L', coordinates: { lat: 0, lng: 0 }, heading: 0, foregroundInvariant: 'a', primaryLandmarkInvariant: 'b', atmosphereNarrative: '' });
        expect(legacy.spatial_envelope_lock.camera_pose.fieldOfViewDegrees).toBe(65);
        expect(legacy.rendering_instruction).not.toContain('Camera lock');
    });

    it('a station whose optical axis misses the mesh yields no distance clause but still a camera lock', () => {
        const s2 = { ...station, beautify: { ...station.beautify, standoffMeters: undefined } };
        const prompt = buildStationBeautifyPrompt(s2, { locationName: 'Sydney Opera House' });
        expect(prompt).not.toContain('Subject distance');
        expect(prompt).toContain('Camera lock');
    });
});
