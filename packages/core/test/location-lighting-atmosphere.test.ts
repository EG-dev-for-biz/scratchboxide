import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    LocationObjectLightingService,
    harmonizeLocationObjectAtmosphere,
    STONE_ALBEDO_PROFILES
} from '../src/index';
import {
    resectImageLocation,
    GeoBoxPrecisionResectionService
} from '../src/node';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { KNOWN_RESECTION_LANDMARKS } from '../src/node/spatial/GeoBoxPrecisionResectionService';

/** A surveyed reference pose passed explicitly; resolution never picks one from words in the prompt hint. */
function fixturePose(key: keyof typeof KNOWN_RESECTION_LANDMARKS) {
    const f = KNOWN_RESECTION_LANDMARKS[key];
    return {
        targetLandmarkName: f.name,
        targetCoords: { lat: f.targetCoords.lat, lng: f.targetCoords.lng, alt: f.groundElevation },
        cameraOpticalCenter: { lat: f.vantageCoords.lat, lng: f.vantageCoords.lng, alt: f.vantageCoords.altitudeMeters },
        headingDeg: f.headingDeg,
        pitchDeg: f.pitchDeg,
        glbPath: f.glbPath
    };
}

describe('Image Location Resection & 3D Object Lighting/Atmosphere APIs', () => {
    describe('1. Image Location Resection API', () => {
        it('should resect 6-DOF camera pose, geodetic coords, and 100% edge alignment via resectImageLocation', async () => {
            const result = await resectImageLocation({
                ...fixturePose('colosseum'),
                promptHint: 'Colosseum Rome dusk vantage point',
                sensorFocalMm: 26.0,
                optimizeTo100Percent: true
            });

            expect(result).toBeDefined();
            expect(result.landmark.name).toContain('Colosseum');
            expect(result.cameraOpticalCenter.lat).toBeCloseTo(41.8908, 3);
            expect(result.cameraOpticalCenter.lng).toBeCloseTo(12.4922, 2);
            expect(result.cameraAttitude.headingDeg).toBe(108.0);
            expect(result.cameraAttitude.pitchDeg).toBe(6.0);
            expect(result.frustum.horizontalFovDeg).toBeCloseTo(69.39, 1); // 26 mm on a 36 mm sensor
            expect(result.cameraOpticalCenter.standoffDistanceMeters).toBeGreaterThan(100);
            expect(result.imageAnalysed).toBe(false); // no edge overlap is claimed
            expect((result as any).edgeAlignment).toBeUndefined();
            expect(result.lensDistortion.k1).toBeLessThan(0); // Barrel distortion
        });

        it('should resect camera pose via GeoBoxPrecisionResectionService instance method', async () => {
            const service = new GeoBoxPrecisionResectionService();
            const result = await service.resectImageLocation({
                ...fixturePose('eiffel'),
                optimizeTo100Percent: true
            });

            expect(result.landmark.name).toContain('Eiffel Tower');
            expect(result.cameraOpticalCenter.lat).toBeCloseTo(48.857, 2);
            expect(result.poseSource).toMatch(/stated camera position/);
        });
    });

    describe('2. Location 3D Object Lighting & Atmosphere API', () => {
        it('should calculate calibrated civil twilight dusk baseline matching ground-truth settings', () => {
            const result = harmonizeLocationObjectAtmosphere({
                latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z',
                landmarkName: 'Colosseum, Rome',
                preset: 'civil_twilight_dusk',
                stoneType: 'travertine',
                portals: [
                    { position: [10, 13.5, -40], targetPosition: [12, 12.5, -50] },
                    { position: [-5, 22.5, -42], targetPosition: [-6, 21.5, -52], kelvinTemperature: 3200, intensity: 4 }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.preset).toBe('civil_twilight_dusk');

            // Photogrammetric de-lighting uniforms
            expect(result.delightUniforms.uDelightEnabled).toBe(true);
            expect(result.delightUniforms.uShadowLift).toBe(0.60);
            expect(result.delightUniforms.uHighlightCompress).toBe(0.45);
            expect(result.delightUniforms.uStoneAlbedoTint).toEqual([0.86, 0.82, 0.78]); // Travertine
            expect(result.delightUniforms.uTwilightSkyTint).toEqual([0.34, 0.71, 0.90]);
            expect(result.delightUniforms.uGroundBounceTint).toEqual([0.38, 0.35, 0.32]);
            expect(result.delightUniforms.uGroundDeWash).toBe(0.42);

            // Atmospheric scene lighting
            expect(result.sceneLighting.ambientLight.color).toBe('#3a7ea5');
            expect(result.sceneLighting.ambientLight.intensity).toBe(0.75);
            expect(result.sceneLighting.hemiLight.skyColor).toBe('#56b5e6');
            expect(result.sceneLighting.hemiLight.groundColor).toBe('#383025');
            expect(result.sceneLighting.hemiLight.intensity).toBe(0.70);
            expect(result.sceneLighting.sunLight.color).toBe('#b8dcfa');
            expect(result.sceneLighting.sunLight.intensity).toBe(0.35);
            expect(result.sceneLighting.fillLight.color).toBe('#2d688c');
            expect(result.sceneLighting.fillLight.intensity).toBe(0.25);

            // Portal backlighting: one fixture per given opening, at the given positions (no canned 12-portal ring).
            expect(result.architecturalFixtures.length).toBe(2);
            const [first, second] = result.architecturalFixtures;
            expect(first.position).toEqual([10, 13.5, -40]);
            expect(first.targetPosition).toEqual([12, 12.5, -50]);
            expect(first.kelvinTemperature).toBe(2850);
            expect(first.type).toBe('spot');
            expect(second.kelvinTemperature).toBe(3200);
            expect(second.intensity).toBe(4);
            expect(second.color).not.toBe(first.color); // colour follows the fixture's Kelvin
            expect(result.portalDefaultsApplied).toEqual(expect.arrayContaining(['kelvinTemperature', 'intensity', 'distance']));

            // The key light sits at the computed sun.
            const sunDir = result.solarEphemeris.sunVector;
            const p = result.sceneLighting.sunLight.position;
            const len = Math.hypot(...p);
            expect(p[0] / len).toBeCloseTo(sunDir[0], 6);
            expect(p[1] / len).toBeCloseTo(sunDir[1], 6);
            expect(p[2] / len).toBeCloseTo(sunDir[2], 6);

            // GLSL shaders
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uShadowLift');
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uHighlightCompress');
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uGroundDeWash');
        });

        it('needs isoDate (no assumed date), picks a daylight look for a high sun, and rejects a portal without positions', () => {
            expect(() => harmonizeLocationObjectAtmosphere({ latitude: 41.8902, longitude: 12.4922 })).toThrow(/isoDate/);
            // 11:00 UTC on 21 June in Rome: the sun is high, so the auto look is daylight, not civil twilight.
            const noon = harmonizeLocationObjectAtmosphere({ latitude: 41.8902, longitude: 12.4922, isoDate: '2026-06-21T11:00:00Z' });
            if (noon.solarElevationDeg >= 12) expect(noon.preset).toBe('midday_clear');
            expect(noon.architecturalFixtures).toEqual([]);
            expect(() => harmonizeLocationObjectAtmosphere({ latitude: 41.8902, longitude: 12.4922, isoDate: '2026-06-21T11:00:00Z', portals: [{ position: [0, 1, 2] } as any] })).toThrow(/targetPosition/);
            expect(() => harmonizeLocationObjectAtmosphere({ latitude: 41.8902, longitude: 12.4922, isoDate: '2026-06-21T11:00:00Z', preset: 'moonlit_fog' as any })).toThrow(/known preset/);
        });

        it('should support alternative stone albedo profiles', () => {
            const marbleResult = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z',
                preset: 'civil_twilight_dusk',
                stoneType: 'marble'
            });
            expect(marbleResult.delightUniforms.uStoneAlbedoTint).toEqual(STONE_ALBEDO_PROFILES.marble);

            const sandstoneResult = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z',
                preset: 'civil_twilight_dusk',
                stoneType: 'sandstone'
            });
            expect(sandstoneResult.delightUniforms.uStoneAlbedoTint).toEqual(STONE_ALBEDO_PROFILES.sandstone);
        });

        it('should support alternative lighting presets like golden_hour and blue_hour', () => {
            const golden = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z',
                preset: 'golden_hour'
            });
            expect(golden.sceneLighting.sunLight.intensity).toBe(1.20);
            expect(golden.delightUniforms.uShadowLift).toBe(0.40);

            const blueHour = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z',
                preset: 'blue_hour'
            });
            expect(blueHour.sceneLighting.ambientLight.color).toBe('#224477');
            expect(blueHour.delightUniforms.uShadowLift).toBe(0.70);
        });
    });

    describe('3. Three.js Material & Scene Applicator Helpers', () => {
        it('should apply photogrammetric de-lighting shader to a Three.js material', () => {
            const material = new THREE.MeshStandardMaterial({ color: 0xcccccc });
            LocationObjectLightingService.applyPhotogrammetricDelightShader(material, {
                uShadowLift: 0.65,
                uGroundDeWash: 0.40
            });

            expect((material as any).userData.delightUniforms).toBeDefined();
            expect((material as any).userData.delightUniforms.uShadowLift.value).toBe(0.65);
            expect((material as any).userData.delightUniforms.uGroundDeWash.value).toBe(0.40);

            // Test onBeforeCompile hook
            const fakeShader: any = {
                uniforms: {},
                vertexShader: '#include <beginnormal_vertex>',
                fragmentShader: '#include <dithering_fragment>'
            };
            material.onBeforeCompile(fakeShader, {} as any);

            expect(fakeShader.vertexShader).toContain('vDelightNormal');
            expect(fakeShader.fragmentShader).toContain('#define DELIGHT_ENABLED 1');
            expect(fakeShader.fragmentShader).toContain('uShadowLift');
        });

        it('should create and attach atmospheric scene lights and portal fixtures to Three.js scene', () => {
            const scene = new THREE.Scene();
            const config = harmonizeLocationObjectAtmosphere({ latitude: 41.8902, longitude: 12.4922, isoDate: '2026-09-28T17:30:00Z', portals: [{ position: [0, 10, -30], targetPosition: [0, 9, -40] }] });

            const lights = LocationObjectLightingService.applyLocationAtmosphereLighting(scene, config.sceneLighting);
            expect(lights.ambient).toBeDefined();
            expect(lights.hemi).toBeDefined();
            expect(lights.sun).toBeDefined();
            expect(lights.fill).toBeDefined();
            expect(scene.children.length).toBe(4);

            const portalGroup = LocationObjectLightingService.applyArchitecturalPortalLights(scene, config.architecturalFixtures);
            expect(portalGroup).toBeDefined();
            expect(portalGroup.name).toBe('ArchitecturalPortalFixtures');
            expect(scene.getObjectByName('ArchitecturalPortalFixtures')).toBe(portalGroup);
        });
    });

    describe('4. Gemini Agent Tools in Tool Registry', () => {
        it('should execute geobox_resect_image_location tool', async () => {
            const registry = createDefaultToolRegistry();
            const response = await registry.dispatch('geobox_resect_image_location', {
                ...fixturePose('colosseum'),
                promptHint: 'Colosseum, Rome dusk',
                optimizeTo100Percent: true
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('Camera pose for Colosseum');
            expect(response.exec.summaryResult).not.toContain('edge overlap');

            const payload: any = response.resultPayload;
            expect(payload.cameraOpticalCenter.lat).toBeCloseTo(41.8908, 3);
            expect(payload.edgeAlignment).toBeUndefined();
        });

        it('should execute geobox_harmonize_location_lighting tool', async () => {
            const registry = createDefaultToolRegistry();
            const response = await registry.dispatch('geobox_harmonize_location_lighting', {
                landmarkName: 'Colosseum, Rome',
                latitude: 41.8902,
                longitude: 12.4922,
                isoDate: '2026-09-28T17:30:00Z',
                preset: 'civil_twilight_dusk',
                stoneType: 'travertine'
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('Harmonized location 3D lighting for Colosseum, Rome');
            // No openings were given, so no backlighting is invented (it used to add a 12-portal Colosseum ring everywhere).
            expect(response.exec.summaryResult).toContain('No portal backlighting');

            const payload: any = response.resultPayload;
            expect(payload.preset).toBe('civil_twilight_dusk');
            expect(payload.delightUniforms.uShadowLift).toBe(0.60);
            expect(payload.delightUniforms.uStoneAlbedoTint).toEqual([0.86, 0.82, 0.78]);
            expect(payload.architecturalFixtures).toEqual([]);
        });

        it('should execute atmosphere_harmonize_location_3d alias tool', async () => {
            const registry = createDefaultToolRegistry();
            const response = await registry.dispatch('atmosphere_harmonize_location_3d', {
                preset: 'golden_hour',
                latitude: 41.8902,
                longitude: 12.4922,
                isoDate: '2026-09-28T17:30:00Z'
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            const payload: any = response.resultPayload;
            expect(payload.preset).toBe('golden_hour');

            // No place given: it fails instead of computing the sun for latitude 45, longitude 0.
            const placeless = await registry.dispatch('atmosphere_harmonize_location_3d', { preset: 'golden_hour' }, {} as any);
            expect(placeless.exec.status).toBe('failed');
            expect(String((placeless.resultPayload as any).error)).toMatch(/latitude and longitude/);
        });
    });

    describe('5. Task Capability Resolver Routing', () => {
        it('should route "image location" tasks to native resection capability and tools', () => {
            const result = TaskCapabilityResolver.resolveTaskCapability(
                'resect the image location and camera pose for this landmark photograph'
            );

            expect(result.tier1Assessment.canSolveNatively).toBe(true);
            expect(result.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('geobox_resect_image_location');
        });

        it('should route "lighting and atmosphere of the location 3d object" tasks to native harmonizer and tools', () => {
            const result = TaskCapabilityResolver.resolveTaskCapability(
                'harmonize the lighting and atmosphere of the location 3d object and delight the facade with window illumination'
            );

            expect(result.tier1Assessment.canSolveNatively).toBe(true);
            expect(result.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('LocationObjectLightingService');
            expect(result.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('geobox_harmonize_location_lighting');
        });
    });
});
