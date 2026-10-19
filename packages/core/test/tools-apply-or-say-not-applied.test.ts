/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tools that said "Configured ..." while nothing changed now either change the open scene (applied: true, the updated
 * scene returned) or say "NOT applied: computed only":
 * - lighting_configure_gaffer_rig writes its key, fill and rim into the scene as an explicit rig the viewport builds;
 * - configure_physical_camera sets the scene camera's vertical FOV (the viewport now honours camera.fov);
 * - optics_configure_lens_distortion and webxr_geospatial_calibrate are computed only and say so.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { lightingHandlers } from '../src/node/gemini/tools/lighting-tools';
import { physicalCameraHandlers, opticsLensDistortionHandlers } from '../src/node/gemini/tools/spatial-tools';
import { syncAtmosphere } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const SHOTS = path.resolve(__dirname, '..', '..', '..', 'test-results', 'screenshots', 'small_fixes');

function clayScene(extra: Record<string, unknown> = {}) {
    return {
        id: 'scene-bust', type: '3d-scene', title: 'Clay Bust', version: 2,
        data: {
            title: 'Clay Bust', renderMode: 'clay', environment: { skybox: 'studio', lighting: 'studio', ground: false },
            camera: { position: [4, 2, 4], target: [0, 1.2, 0], fov: 45 }, objects: [], ...extra
        }
    };
}
const withScene = (active: unknown) => ({ request: { activeArtifact: active } }) as any;

function fakeStack() {
    return { scene: new THREE.Scene(), gridHelper: new THREE.GridHelper(20, 20), container: { clientWidth: 800, clientHeight: 600 } as any, renderer: {} as any, camera: new THREE.PerspectiveCamera(), controls: {} as any };
}
const factories = { createVolumetricGodRays: () => ({ dispose: () => undefined }), createProceduralBiomeTerrain: () => ({ dispose: () => undefined }) };

function atmosphereInputOf(data: any) {
    return {
        skybox: data.environment?.skybox, lighting: data.environment?.lighting, cinematicRig: data.environment?.cinematicRig,
        lightingRig: data.environment?.lightingRig, lightingKelvin: data.environment?.lightingKelvin, worldBranch: '',
        renderMode: data.renderMode, hasGeoCoordinates: false, has3DTiles: false, atmosphericScattering: data.features?.atmosphericScattering
    };
}

/** Lambert shading of a unit sphere at `centre` under the built point/spot lights (inverse square, spot cone), as an image. */
function shadeSphere(lights: THREE.Object3D[], centre: THREE.Vector3, W = 360, H = 360): Uint8Array {
    const px = new Uint8Array(W * H * 3);
    const camDir = new THREE.Vector3(0, 0, 1);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const x = (i + 0.5) / W * 2 - 1, y = 1 - (j + 0.5) / H * 2;
        const r2 = x * x + y * y;
        if (r2 > 1) { px.set([30, 32, 38], (j * W + i) * 3); continue; }
        const n = new THREE.Vector3(x, y, Math.sqrt(1 - r2));
        const p = centre.clone().add(n.clone().multiplyScalar(0.5));
        const rgb = [0, 0, 0];
        for (const o of lights) {
            const l = o as THREE.PointLight & THREE.SpotLight & THREE.AmbientLight;
            if ((l as THREE.AmbientLight).isAmbientLight) { for (let c = 0; c < 3; c++) rgb[c] += l.color.toArray()[c] * l.intensity * 0.6; continue; }
            if (!l.isPointLight && !l.isSpotLight) continue;
            const toL = l.position.clone().sub(p);
            const d = toL.length();
            const ndl = Math.max(0, n.dot(toL.normalize()));
            let cone = 1;
            if (l.isSpotLight) {
                const axis = l.target.position.clone().sub(l.position).normalize();
                const cos = axis.dot(p.clone().sub(l.position).normalize());
                const outer = Math.cos(l.angle), inner = Math.cos(l.angle * (1 - l.penumbra));
                cone = THREE.MathUtils.smoothstep(cos, outer, inner);
            }
            const e = l.intensity / (d * d) * ndl * cone;
            const col = l.color.toArray();
            for (let c = 0; c < 3; c++) rgb[c] += col[c] * e;
        }
        void camDir;
        // simple exposure: 0.18 albedo clay, Reinhard, sRGB-ish gamma
        px.set(rgb.map(v => Math.round(255 * Math.pow((v * 0.55) / (1 + v * 0.55), 1 / 2.2))), (j * W + i) * 3);
    }
    return px;
}

describe('lighting_configure_gaffer_rig applies its rig to the open scene, or says NOT applied', () => {
    it('with no 3D scene open it computes the rig but says NOT applied', () => {
        const out = lightingHandlers.lighting_configure_gaffer_rig({ style: 'rembrandt' }, {} as any) as any;
        expect(out.status).toBe('failed');
        expect(out.resultPayload).toMatchObject({ success: false, applied: false });
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(out.resultPayload.lights).toHaveLength(3);
        expect(out.summaryResult).toMatch(/^NOT applied: computed only\. no 3D scene is open, so nothing was lit\. Computed: REMBRANDT rig, 4:1 key-to-fill/);
    });

    it('writes key, fill and rim into the scene at the rig\'s ratio, aimed at the camera target, and the viewport builds them', () => {
        const active = clayScene();
        const out = lightingHandlers.lighting_configure_gaffer_rig({ style: 'rembrandt', keyToFillRatio: 4, keyKelvin: 3200, fillKelvin: 7000 }, withScene(active)) as any;
        expect(out.status).toBeUndefined();
        expect(out.resultPayload).toMatchObject({ success: true, applied: true, appliedTo: 'scene-bust', operators: ['sb_set_explicit_lighting_rig'] });
        expect(out.summaryResult).toMatch(/^Applied to the active 3D scene "Clay Bust": REMBRANDT rig, 4:1 key-to-fill \(2\.0 stops\), 3 lights \(key spot 3200 K, fill point 7000 K, rim spot 6500 K\), aimed at \[0, 1\.2, 0\]/);
        expect(out.summaryResult).toMatch(/Not reproduced: absolute lux/);
        const data = out.resultPayload.artifact.data;
        expect(out.resultPayload.artifact.version).toBe(3);
        expect((active.data as any).environment.lightingRig).toBeUndefined();
        const rig = data.environment.lightingRig;
        expect(data.environment.cinematicRig).toBe(rig.name);
        expect(rig.origin).toEqual([0, 1.2, 0]);
        // the fill's irradiance at the subject is the key's over the ratio
        const irr = (l: any) => l.intensity / (l.position[0] ** 2 + l.position[1] ** 2 + l.position[2] ** 2);
        const key = rig.lights.find((l: any) => /Key/.test(l.name)), fill = rig.lights.find((l: any) => /Fill/.test(l.name));
        expect(irr(key) / irr(fill)).toBeCloseTo(4, 9);

        // the viewport: the explicit rig replaces the studio rig, placed around the camera target
        const stack = fakeStack();
        const handle = syncAtmosphere(stack as any, atmosphereInputOf(data) as any, factories as any);
        const keyLight = stack.scene.getObjectByName(key.name) as THREE.SpotLight;
        expect(keyLight?.isSpotLight).toBe(true);
        expect(keyLight.castShadow).toBe(true);
        expect(keyLight.position.toArray()).toEqual([key.position[0], 1.2 + key.position[1], key.position[2]]);
        expect(keyLight.intensity).toBeCloseTo(key.intensity, 9);
        // its colour is 3200 K (warm: red over blue), not overridden by a rig-wide Kelvin
        expect(keyLight.color.r).toBeGreaterThan(keyLight.color.b);
        expect((stack.scene.getObjectByName(fill.name) as THREE.PointLight)?.isPointLight).toBe(true);
        expect(stack.scene.getObjectByName('Studio_Key')).toBeUndefined();
        const lights = stack.scene.children.filter(c => (c as THREE.Light).isLight);
        expect(lights.filter(l => (l as THREE.SpotLight).isSpotLight || (l as THREE.PointLight).isPointLight)).toHaveLength(3);

        fs.mkdirSync(SHOTS, { recursive: true });
        const W = 360;
        fs.writeFileSync(path.join(SHOTS, 'unit_gaffer_rembrandt_sphere.png'), encodePng(W, W, shadeSphere(stack.scene.children, new THREE.Vector3(0, 1.2, 0)), 3));
        handle.dispose();

        // a preset rig afterwards replaces the explicit one
        const engine = new DirectDispatchOperatorEngine(JSON.parse(JSON.stringify(data)));
        expect(engine.dispatch('sb_setup_lighting_rig', { preset: 'three_point_studio' }).success).toBe(true);
        expect(engine.getSceneData().environment!.lightingRig).toBeUndefined();
    });

    it('switches off a sun/sky atmosphere the scene drew (it would replace the rig) and says so', () => {
        const active = clayScene({ features: { atmosphericScattering: { enabled: true, sunElevation: 30, sunAzimuth: 200 } } });
        const out = lightingHandlers.lighting_configure_gaffer_rig({ style: 'noir' }, withScene(active)) as any;
        expect(out.resultPayload.applied).toBe(true);
        expect(out.resultPayload.atmosphereSwitchedOff).toEqual(['features.atmosphericScattering']);
        expect(out.summaryResult).toMatch(/the scene's sun\/sky atmosphere was switched off/);
        const data = out.resultPayload.artifact.data;
        expect(data.features.atmosphericScattering).toMatchObject({ enabled: false, sunElevation: 30 });
        const stack = fakeStack();
        const handle = syncAtmosphere(stack as any, atmosphereInputOf(data) as any, factories as any);
        expect(stack.scene.getObjectByName('AtmosphericSunLight')).toBeUndefined();
        expect(stack.scene.getObjectByName(data.environment.lightingRig.lights[0].name)).toBeDefined();
        handle.dispose();
    });
});

describe('configure_physical_camera sets the scene camera\'s FOV, or says NOT applied', () => {
    it('with no scene, or a scene without a camera pose, it says NOT applied', async () => {
        const none = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 50, apertureFStop: 2.8 }, {} as any) as any;
        expect(none.status).toBe('failed');
        expect(none.resultPayload.applied).toBe(false);
        expect(none.summaryResult).toMatch(/^NOT applied: computed only\. no 3D scene is open, so no camera changed\. Computed: 50 mm, f\/2\.8/);
        const noCam = { id: 's', type: '3d-scene', title: 'No Cam', data: { title: 'No Cam' } };
        const out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 50, apertureFStop: 2.8 }, withScene(noCam)) as any;
        expect(out.resultPayload.applied).toBe(false);
        expect(out.summaryResult).toMatch(/^NOT applied: computed only\. the scene "No Cam" has no camera pose/);
    });

    it('puts a 50 mm full-frame lens on the camera: vertical FOV 2 atan(12 / 50), the rest computed only', async () => {
        const active = clayScene();
        const out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 50, apertureFStop: 2.8, focusDistanceMeters: 3, sensorFormat: 'full_frame_35mm' }, withScene(active)) as any;
        const expected = 2 * Math.atan(12 / 50) * 180 / Math.PI;
        expect(out.resultPayload).toMatchObject({ success: true, applied: true, appliedTo: 'scene-bust', operators: ['sb_set_camera'] });
        expect(out.resultPayload.appliedFovDeg).toBeCloseTo(expected, 2);
        const cam = out.resultPayload.artifact.data.camera;
        expect(cam.fov).toBeCloseTo(expected, 2);
        // the pose is untouched; the input scene is not mutated
        expect(cam.position).toEqual([4, 2, 4]);
        expect(cam.target).toEqual([0, 1.2, 0]);
        expect((active.data as any).camera.fov).toBe(45);
        expect(out.summaryResult).toMatch(/^Applied to the active 3D scene "Clay Bust": 50 mm, f\/2\.8, full_frame_35mm: vertical FOV 27\.0°.*the viewport camera's vertical FOV is now 27\.0° \(was 45°\)\. Computed only, NOT applied: depth of field and bokeh/);
        expect(out.resultPayload.notAppliedParts[0]).toMatch(/no depth-of-field pass/);
    });
});

describe('optics_configure_lens_distortion is computed only and says so', () => {
    it('returns the coefficients with applied: false and a NOT applied summary', async () => {
        const out = await opticsLensDistortionHandlers.optics_configure_lens_distortion({ presetId: 'ultrawide_14mm' }, withScene(clayScene())) as any;
        expect(out.resultPayload.applied).toBe(false);
        expect(out.resultPayload.notApplied).toMatch(/no lens-distortion pass/);
        expect(out.resultPayload.artifact).toBeUndefined();
        expect(out.summaryResult).toMatch(/^NOT applied: computed only\. Brown-Conrady lens distortion k1 -?\d/);
    });
});
