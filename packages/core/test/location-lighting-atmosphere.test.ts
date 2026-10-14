import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    LocationObjectLightingService,
    harmonizeLocationObjectAtmosphere,
    generateCanonicalAmbulatoryFixtures,
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
            expect(result.frustum.horizontalFovDeg).toBeCloseTo(57.0, 1);
            expect(result.cameraOpticalCenter.standoffDistanceMeters).toBeGreaterThan(100);
            expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
            expect(result.edgeAlignment.subPixelResidualPx).toBeLessThan(0.1);
            expect(result.edgeAlignment.converged).toBe(true);
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
            expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
        });
    });

    describe('2. Location 3D Object Lighting & Atmosphere API', () => {
        it('should calculate calibrated civil twilight dusk baseline matching ground-truth settings', () => {
            const result = harmonizeLocationObjectAtmosphere({
                landmarkName: 'Colosseum, Rome',
                preset: 'civil_twilight_dusk',
                stoneType: 'travertine',
                enableArchitecturalBacklighting: true
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

            // Architectural portal backlighting
            expect(result.architecturalFixtures.length).toBe(12);
            const firstFixture = result.architecturalFixtures[0];
            expect(firstFixture.kelvinTemperature).toBe(2850);
            expect(firstFixture.color).toBe('#ff8515');
            expect(firstFixture.type).toBe('spot');
            expect(firstFixture.position[0]).toBeDefined();
            expect(firstFixture.targetPosition).toBeDefined();

            // GLSL shaders
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uShadowLift');
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uHighlightCompress');
            expect(result.shaderGLSL.fragmentShaderChunk).toContain('uGroundDeWash');
        });

        it('should support alternative stone albedo profiles', () => {
            const marbleResult = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                preset: 'civil_twilight_dusk',
                stoneType: 'marble'
            });
            expect(marbleResult.delightUniforms.uStoneAlbedoTint).toEqual(STONE_ALBEDO_PROFILES.marble);

            const sandstoneResult = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                preset: 'civil_twilight_dusk',
                stoneType: 'sandstone'
            });
            expect(sandstoneResult.delightUniforms.uStoneAlbedoTint).toEqual(STONE_ALBEDO_PROFILES.sandstone);
        });

        it('should support alternative lighting presets like golden_hour and blue_hour', () => {
            const golden = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
                preset: 'golden_hour'
            });
            expect(golden.sceneLighting.sunLight.intensity).toBe(1.20);
            expect(golden.delightUniforms.uShadowLift).toBe(0.40);

            const blueHour = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
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
            const config = harmonizeLocationObjectAtmosphere();

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
            expect(response.exec.summaryResult).toContain('Resected image location for Colosseum');
            expect(response.exec.summaryResult).toContain('100.0% edge overlap');

            const payload: any = response.resultPayload;
            expect(payload.cameraOpticalCenter.lat).toBeCloseTo(41.8908, 3);
            expect(payload.edgeAlignment.overlapScorePct).toBe(100.0);
        });

        it('should execute geobox_harmonize_location_lighting tool', async () => {
            const registry = createDefaultToolRegistry();
            const response = await registry.dispatch('geobox_harmonize_location_lighting', {
                landmarkName: 'Colosseum, Rome',
                preset: 'civil_twilight_dusk',
                stoneType: 'travertine'
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('Harmonized location 3D lighting for Colosseum, Rome');
            expect(response.exec.summaryResult).toContain('12 architectural portal window fixtures');

            const payload: any = response.resultPayload;
            expect(payload.preset).toBe('civil_twilight_dusk');
            expect(payload.delightUniforms.uShadowLift).toBe(0.60);
            expect(payload.delightUniforms.uStoneAlbedoTint).toEqual([0.86, 0.82, 0.78]);
            expect(payload.architecturalFixtures.length).toBe(12);
        });

        it('should execute atmosphere_harmonize_location_3d alias tool', async () => {
            const registry = createDefaultToolRegistry();
            const response = await registry.dispatch('atmosphere_harmonize_location_3d', {
                preset: 'golden_hour'
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            const payload: any = response.resultPayload;
            expect(payload.preset).toBe('golden_hour');
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
