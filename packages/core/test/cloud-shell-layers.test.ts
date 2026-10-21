/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Shell cloud decks: thin decks drawn as stacked Earth-concentric shells in the sky dome. Each deck is continuous
 * physical parameters (altitude, thickness, coverage, optical depth, feature size, elongation, phase, albedo); a bad
 * value fails with the field named and is never clamped; decks reach the dome through the operator and the agent tool.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    resolveCloudShellLayers,
    cloudShellUniformArrays,
    shellCoverageForSkyCover,
    MAX_CLOUD_SHELL_LAYERS
} from '../src/browser/generative-canvas/services/atmosphere/cloud-shell-layers';
import { createAtmosphericSkyDome, ATMOSPHERE_FRAGMENT_SHADER } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
import { computeDiurnalLightingProfile } from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';
import { atmosphereHandlers } from '../src/node/gemini/tools/atmosphere-tools';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { InvalidInputError } from '../src/common/errors/pipeline-errors';

const cirrus = { label: 'cirrus', baseAltitudeMeters: 9000, thicknessMeters: 1200, coverage: 0.45, opticalDepth: 0.5, featureSizeMeters: 2500, streakElongation: 8, streakHeadingDeg: 70 };
const sheet = { label: 'altostratus', baseAltitudeMeters: 4000, thicknessMeters: 1500, coverage: 0.85, opticalDepth: 6, featureSizeMeters: 6000 };

function domeUniforms(dome: { skyMaterial: THREE.ShaderMaterial }) {
    return dome.skyMaterial.uniforms;
}

describe('cloud shell decks: validation and packing', () => {
    it('resolves optional fields and orders decks highest first', () => {
        const r = resolveCloudShellLayers([sheet, cirrus]);
        expect(r.map(l => l.baseAltitudeMeters)).toEqual([9000, 4000]);
        expect(r[0].shellCount).toBe(3); // 1200 m at ~400 m a shell
        expect(r[1].shellCount).toBe(4);
        expect(r[0].streakHeadingRad).toBeCloseTo(70 * Math.PI / 180, 12);
        expect(r[1]).toMatchObject({ streakElongation: 1, forwardScattering: 0.75, scatteringAlbedo: [1, 1, 1], windSpeedMetersPerSecond: 0 });
        expect(resolveCloudShellLayers(undefined)).toEqual([]);
    });

    it('a single sheet (thickness 0) is one shell', () => {
        expect(resolveCloudShellLayers([{ ...cirrus, thicknessMeters: 0 }])[0].shellCount).toBe(1);
    });

    it('refuses out-of-range values, naming the field, rather than clamping them', () => {
        const bad: Array<[unknown, RegExp]> = [
            [[{ ...cirrus, coverage: 1.5 }], /cloudLayers\[0\]\.coverage/],
            [[{ ...cirrus, opticalDepth: 0 }], /cloudLayers\[0\]\.opticalDepth/],
            [[cirrus, { ...sheet, featureSizeMeters: undefined }], /cloudLayers\[1\]\.featureSizeMeters/],
            [[{ ...cirrus, shellCount: 9 }], /shellCount/],
            [[{ ...cirrus, streakElongation: 0.5 }], /streakElongation/],
            [[{ ...cirrus, forwardScattering: 1 }], /forwardScattering/],
            [[{ ...cirrus, scatteringAlbedo: [1, 1] }], /scatteringAlbedo/],
            [[cirrus, cirrus, cirrus, cirrus, cirrus], /5 decks/],
            ['cirrus', /must be an array/]
        ];
        for (const [layers, msg] of bad) {
            expect(() => resolveCloudShellLayers(layers, 'test')).toThrow(InvalidInputError);
            expect(() => resolveCloudShellLayers(layers, 'test')).toThrow(msg);
        }
    });

    it('packs the shader uniform arrays with unused slots zeroed', () => {
        const u = cloudShellUniformArrays(resolveCloudShellLayers([cirrus]));
        expect(u.count).toBe(1);
        expect(u.a).toHaveLength(MAX_CLOUD_SHELL_LAYERS);
        // coverage is visible sky cover; the shader gets the internal coverage that shows as that cover
        expect(u.a[0]).toEqual([9000, 1200, shellCoverageForSkyCover(0.45), 0.5]);
        expect(shellCoverageForSkyCover(0.45)).toBeGreaterThan(0.3);
        expect(shellCoverageForSkyCover(0.45)).toBeLessThan(0.45);
        expect(u.b[0][0]).toBe(2500);
        expect(u.b[0][1]).toBe(8);
        expect(u.c[0]).toEqual([1, 1, 1, 3]);
        expect(u.a[1]).toEqual([0, 0, 0, 0]);
    });
});

describe('cloud shell decks in the sky dome', () => {
    it('the dome shader composites the decks before the volumetric layer', () => {
        const shells = ATMOSPHERE_FRAGMENT_SHADER.indexOf('skyColor = compositeCloudShells(');
        const cumulus = ATMOSPHERE_FRAGMENT_SHADER.indexOf('--- 3. VOLUMETRIC CUMULUS');
        expect(shells).toBeGreaterThan(0);
        expect(shells).toBeLessThan(cumulus);
    });

    it('no decks unless asked for; given decks reach the uniforms; setCloudLayers replaces and clears them', () => {
        const scene = new THREE.Scene();
        const plain = createAtmosphericSkyDome(scene, false, { sunElevation: 30, sunAzimuth: 180 });
        expect(domeUniforms(plain).uShellLayerCount.value).toBe(0);
        plain.dispose();

        const dome = createAtmosphericSkyDome(scene, false, { sunElevation: 30, sunAzimuth: 180, cloudLayers: [sheet, cirrus] });
        const u = domeUniforms(dome);
        expect(u.uShellLayerCount.value).toBe(2);
        expect(u.uShellA.value[0].toArray()).toEqual([9000, 1200, shellCoverageForSkyCover(0.45), 0.5]);
        expect(u.uShellA.value[1].toArray()).toEqual([4000, 1500, shellCoverageForSkyCover(0.85), 6]);
        dome.setCloudLayers([]);
        expect(u.uShellLayerCount.value).toBe(0);
        expect(() => dome.setCloudLayers([{ ...cirrus, coverage: -1 }])).toThrow(InvalidInputError);
        dome.dispose();
    });

    it('the dome sun is the spectral beam when no colour temperature is set', () => {
        const scene = new THREE.Scene();
        const dome = createAtmosphericSkyDome(scene, false, { sunElevation: 6, sunAzimuth: 250, turbidity: 3 });
        const beam = computeDiurnalLightingProfile(6, { turbidity: 3 }).sunLinearRgb!;
        const c = domeUniforms(dome).uSunColor.value as THREE.Color;
        expect([c.r, c.g, c.b].map(v => +v.toFixed(5))).toEqual(beam.map(v => +v.toFixed(5)));
        dome.dispose();
    });
});

describe('cloud shell decks through the operator and the agent tool', () => {
    it('sb_configure_atmospheric_scattering stores decks and refuses a bad one', () => {
        const engine = new DirectDispatchOperatorEngine({ objects: [] } as any);
        const ok = engine.executeBatch([{ operator: 'sb_configure_atmospheric_scattering', params: { cloudLayers: [cirrus] } }], { atomic: true });
        expect(ok.success).toBe(true);
        expect((engine.getSceneData().features as any).atmosphericScattering.cloudLayers).toEqual([cirrus]);
        const bad = engine.executeBatch([{ operator: 'sb_configure_atmospheric_scattering', params: { cloudLayers: [{ ...cirrus, opticalDepth: -2 }] } }], { atomic: true });
        expect(bad.success).toBe(false);
        expect(bad.results.map(r => r.error).join(' ')).toMatch(/opticalDepth/);
    });

    it('atmosphere_configure_scene writes the decks into the open scene and names them; no derived Kelvin is stored', () => {
        const active = { id: 's1', type: '3d-scene', title: 'Deck test', version: 1, data: { objects: [], camera: { position: [0, 10, 40], target: [0, 0, 0] } } };
        const out = atmosphereHandlers.atmosphere_configure_scene(
            { sunElevationDeg: 25, sunAzimuthDeg: 200, cloudLayers: [cirrus, sheet] },
            { request: { activeArtifact: active } } as any
        ) as any;
        expect(out.resultPayload).toMatchObject({ success: true, applied: true });
        const atm = out.resultPayload.artifact.data.features.atmosphericScattering;
        expect(atm.cloudLayers).toEqual([cirrus, sheet]);
        expect(atm.kelvinTemperature).toBeUndefined();
        expect(out.summaryResult).toMatch(/2 shell cloud decks \(cirrus, altostratus\)/);
    });

    it('atmosphere_configure_scene refuses a bad deck before applying anything', () => {
        const active = { id: 's1', type: '3d-scene', title: 'Deck test', version: 1, data: { objects: [] } };
        expect(() => atmosphereHandlers.atmosphere_configure_scene(
            { sunElevationDeg: 25, sunAzimuthDeg: 200, cloudLayers: [{ ...cirrus, featureSizeMeters: 0 }] },
            { request: { activeArtifact: active } } as any
        )).toThrow(/cloudLayers\[0\]\.featureSizeMeters/);
        expect((active.data as any).features).toBeUndefined();
    });
});
