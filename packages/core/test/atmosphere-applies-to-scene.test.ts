/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * atmosphere_configure_scene lights the open scene, or says it did not. The survey's run asked for "the real sun this
 * afternoon" on a staged clay scene: the tool returned a config, the viewport kept its studio rig, and the reply said the
 * lighting was configured. Now the tool writes the sun into the scene through the atmosphere operators and returns the
 * updated scene; the viewport draws a clay scene's explicit sun (directional light at the computed position, cascaded
 * shadows reaching as far as the scene, sky dome and hemisphere ambient); with no scene open the result is NOT applied.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { atmosphereHandlers } from '../src/node/gemini/tools/atmosphere-tools';
import { calculateNOAASolarPosition, getSunVectorFromAngles } from '../src/browser/generative-canvas/services/atmosphere';
import { classifyAtmosphere, syncAtmosphere } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';
import type { SunCascadeShadow } from '../src/browser/generative-canvas/primitives/scene3d/sunShadowCascades';
import { sceneShowsSky } from '../src/common/scene-atmosphere-opt-in';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const SHOTS = path.resolve(__dirname, '..', '..', '..', 'test-results', 'screenshots', 'staging_honesty');
// Washington Square Arch, 2026-10-18 16:00 EDT
const PLACE = { latitude: 40.731219, longitude: -73.997093 };
const ISO = '2026-10-18T20:00:00Z';

function stagedClayScene() {
    return {
        id: 'scene-stg-498c306f', type: '3d-scene', title: 'Washington Square Arch', version: 3,
        data: {
            renderMode: 'clay', environment: { skybox: 'studio', lighting: 'studio', ground: false },
            geoAnchor: { lat: PLACE.latitude, lng: PLACE.longitude }, camera: { position: [300, 200, 300], target: [0, 0, 0], fov: 60 },
            objects: []
        }
    };
}

function fakeStack() {
    const scene = new THREE.Scene();
    return { scene, gridHelper: new THREE.GridHelper(20, 20), container: { clientWidth: 800, clientHeight: 600 } as any, renderer: {} as any, camera: new THREE.PerspectiveCamera(), controls: {} as any };
}
const factories = { createVolumetricGodRays: () => ({ dispose: () => undefined }), createProceduralBiomeTerrain: () => ({ dispose: () => undefined }) };

describe('atmosphere_configure_scene applies the sun to the open scene', () => {
    it('with no 3D scene open it computes the sun but says NOT applied', () => {
        const out = atmosphereHandlers.atmosphere_configure_scene({ ...PLACE, isoDate: ISO }, {} as any) as any;
        expect(out.status).toBe('failed');
        expect(out.resultPayload).toMatchObject({ success: false, applied: false });
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(out.summaryResult).toMatch(/^NOT applied: no 3D scene is open, so nothing was lit\. Computed only: sun elevation/);
    });

    it('writes the NOAA sun into the active clay scene, and the viewport draws it with shadows over the scene', () => {
        const active = stagedClayScene();
        const out = atmosphereHandlers.atmosphere_configure_scene({ ...PLACE, isoDate: ISO }, { request: { activeArtifact: active } } as any) as any;
        const sun = calculateNOAASolarPosition(new Date(ISO), PLACE.latitude, PLACE.longitude);
        expect(out.status).toBeUndefined();
        expect(out.resultPayload).toMatchObject({ success: true, applied: true, appliedTo: 'scene-stg-498c306f', castShadows: true });
        expect(out.resultPayload.operators).toEqual(['sb_set_diurnal_time_of_day', 'sb_configure_atmospheric_scattering', 'sb_configure_aerial_perspective']);
        expect(out.summaryResult).toMatch(/^Applied to the active 3D scene "Washington Square Arch": sun elevation/);
        const data = out.resultPayload.artifact.data;
        expect(out.resultPayload.artifact.version).toBe(4);
        const atm = data.features.atmosphericScattering;
        expect(atm.sunElevation).toBeCloseTo(sun.elevationDeg, 9);
        expect(atm.sunAzimuth).toBeCloseTo(sun.azimuthDeg, 9);
        expect(atm.isoDate).toBe(ISO.replace('Z', '.000Z'));
        // half the camera's distance to its target
        expect(atm.sunShadowRadiusMeters).toBeCloseTo(Math.hypot(300, 200, 300) / 2, 6);
        // the scene's own choices stay: it is still clay; the input scene object is not mutated
        expect(data.renderMode).toBe('clay');
        expect((active.data as any).features).toBeUndefined();

        // the viewport: a clay scene with an explicit sun draws it (and its sky), a clay scene without one does not
        const input = { skybox: 'studio', lighting: 'studio', worldBranch: '', renderMode: 'clay' as const, hasGeoCoordinates: true, has3DTiles: false, atmosphericScattering: atm };
        expect(classifyAtmosphere(input).hasAtmosphere).toBe(true);
        expect(classifyAtmosphere({ ...input, atmosphericScattering: { enabled: true } }).hasAtmosphere).toBe(false);
        expect(sceneShowsSky(data)).toBe(true);

        const stack = fakeStack();
        const handle = syncAtmosphere(stack as any, input, factories as any);
        const light = stack.scene.getObjectByName('AtmosphericSunLight') as THREE.DirectionalLight;
        expect(light?.isDirectionalLight).toBe(true);
        expect(light.castShadow).toBe(true);
        // the configured shadow reach sizes the sun's camera-fitted cascades: shadowed out to five radii (at least 1 km),
        // casters looked for three radii toward the sun
        const cascades = light.shadow as unknown as SunCascadeShadow;
        expect(cascades.isSunCascadeShadow).toBe(true);
        expect(cascades.maxDistance).toBeCloseTo(Math.max(1000, 5 * atm.sunShadowRadiusMeters), 6);
        expect(cascades.casterReach).toBeCloseTo(Math.max(500, 3 * atm.sunShadowRadiusMeters), 6);
        // the light stands along the computed sun direction
        const dir = getSunVectorFromAngles(atm.sunElevation, atm.sunAzimuth).normalize();
        expect(light.position.clone().normalize().dot(dir)).toBeGreaterThan(0.9999);
        // the sky's ambient, and no studio rig beside it
        expect(stack.scene.getObjectByName('AtmosphericHemisphereLight')).toBeDefined();
        expect(stack.scene.getObjectByName('AtmosphericSkyDome')).toBeDefined();
        expect(stack.scene.children.filter(c => (c as THREE.Light).isLight && !/^Atmospheric/.test(c.name))).toEqual([]);

        // screenshot: the shadow this sun casts from a 26 x 11 x 22 m block (the arch's bounds) on the ground, from above
        const W = 480, H = 480, half = 60;
        const px = new Uint8Array(W * H * 3);
        const toSun = dir;
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            const x = -half + (2 * half * (i + 0.5)) / W, z = -half + (2 * half * (j + 0.5)) / H;
            const inBlock = Math.abs(x) <= 13 && Math.abs(z) <= 5.5;
            // the ground point is shaded when the ray towards the sun meets the block
            let tmin = 0, tmax = Infinity;
            for (const [o, d, lo, hi] of [[x, toSun.x, -13, 13], [0, toSun.y, 0, 22], [z, toSun.z, -5.5, 5.5]] as Array<[number, number, number, number]>) {
                if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { tmin = Infinity; } continue; }
                const a = (lo - o) / d, b = (hi - o) / d;
                tmin = Math.max(tmin, Math.min(a, b)); tmax = Math.min(tmax, Math.max(a, b));
            }
            const shade = inBlock ? [225, 150, 60] : tmin <= tmax ? [70, 74, 82] : [196, 200, 206];
            px.set(shade, (j * W + i) * 3);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'unit_sun_shadow_topdown_wsq_1600edt.png'), encodePng(W, H, px, 3));
        handle.dispose();
    });

    it('geobox_harmonize_location_lighting applies its NOAA sun to the open scene and says the de-lighting values are not applied', async () => {
        const { geoboxPrecisionHandlers } = await import('../src/node/gemini/tools/spatial-tools');
        const active = stagedClayScene();
        const out = await geoboxPrecisionHandlers.geobox_harmonize_location_lighting({ ...PLACE, isoDate: ISO }, { request: { activeArtifact: active } } as any) as any;
        const sun = calculateNOAASolarPosition(new Date(ISO), PLACE.latitude, PLACE.longitude);
        expect(out.resultPayload.applied).toBe(true);
        expect(out.resultPayload.artifact.data.features.atmosphericScattering.sunElevation).toBeCloseTo(sun.elevationDeg, 1);
        expect(out.summaryResult).toMatch(/^APPLIED the sun to the active 3D scene "Washington Square Arch".*computed only, NOT applied: the viewport does not read them/);
    });
});
