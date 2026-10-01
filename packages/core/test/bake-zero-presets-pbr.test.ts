/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { SurveySynthesisEngine, stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { SurveyTextureUnprojector, type StationPlate } from '../src/node/spatial/SurveyTextureUnprojector';
import { NativeTilePathTracerService } from '../src/node/3d-engine/native-tile-path-tracer-service';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b';
const ANCHOR: GeodeticAnchor = {
    lat: 32.5363,
    lng: 44.4208,
    elevationMeters: 25.0
};

describe('Frontier 1: Photorealism Texture Baking & UV Spatial Lock into 3D .GLB', () => {
    it('Bakes photorealistic plates onto Zero-Preset Scene 2 (Babylonian Ziggurat Observatory) and renders from novel viewpoints', async () => {
        const glbPath = path.resolve(process.cwd(), 'build/scene_2_ziggurat.glb');
        const platePngPath = path.join(ARTIFACT_DIR, 'scene_2_photorealistic_final.png');
        const outGlbPath = path.resolve(process.cwd(), 'build/scene_2_textured.glb');

        expect(fs.existsSync(glbPath)).toBe(true);
        expect(fs.existsSync(platePngPath)).toBe(true);

        const glbBuffer = await fs.readFile(glbPath);
        const plateBuffer = await fs.readFile(platePngPath);
        const plateImg = decodePng(plateBuffer);
        console.log(`[Scene 2 Plate] Decoded ${plateImg.width}x${plateImg.height} (${plateImg.rgba.length} bytes)`);

        // Exact camera pose from stats.json
        const camPos: [number, number, number] = [-12.6151047, 13.1188269, 18.7026634];
        const camTarget: [number, number, number] = [0, 2.11582971, 0];
        const verticalFov = 44.0;
        const aspect = plateImg.width / plateImg.height;
        const halfVRad = (verticalFov * 0.5 * Math.PI) / 180;
        const halfHRad = Math.atan(Math.tan(halfVRad) * aspect);
        const horizFovDeg = (2 * halfHRad * 180) / Math.PI;
        const focalLengthMm = (36 * 0.5) / Math.tan(halfHRad);

        const station = stationFromLookAt(
            201,
            camPos,
            camTarget,
            { focalLengthMm, sensorWidthMm: 36, aspectRatio: aspect },
            ANCHOR
        );

        // Step 1: Render exact metric depth buffer matching plate resolution
        console.log('📐 [Step 1] Rendering exact metric depth buffer via SurveyStationRenderService...');
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glbBuffer);
        const blockout = renderer.renderStationBlockout(station, {
            width: plateImg.width,
            height: plateImg.height
        });

        expect(blockout.depth.length).toBe(plateImg.width * plateImg.height);

        // Step 2: Prepare StationPlate with 1:1 camera pose and depth
        const plate: StationPlate = {
            station,
            rgba: plateImg.rgba,
            width: plateImg.width,
            height: plateImg.height,
            depth: blockout.depth,
            pose: blockout.cameraPose,
            intrinsics: blockout.intrinsics
        };

        // Step 3: Unproject photorealistic plate into UV texture atlas & synthesize PBR maps
        console.log('🎨 [Step 2] Executing Survey-to-Atlas Inverse Projection (SAIP) & PBR Synthesis...');
        const unprojectResult = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath,
            anchor: ANCHOR,
            stations: [station],
            precomputedPlates: [plate],
            options: {
                outGlbPath,
                resolution: 1024,
                pbrDecomposition: {
                    enableAlbedoDeLighting: false,
                    enableSolarInverseDelighting: false,
                    enableMultiFrequencyNormals: false,
                    enableHbaoMicroCavity: false,
                    enableBiophysicalRoughness: true,
                    generateNormalMaps: true,
                    generateRoughnessMaps: true,
                    generateAoMaps: true,
                    packOrm: true,
                    normalStrength: 1.8
                }
            }
        });

        expect(unprojectResult.success).toBe(true);
        expect(fs.existsSync(outGlbPath)).toBe(true);
        console.log(`✅ Baked 3D GLB created: ${outGlbPath} (${fs.statSync(outGlbPath).size} bytes)`);
        console.log(`📊 Unprojection Metrics:
           - Total Covered Texels: ${unprojectResult.metrics.coveredMeshTexels}
           - Directly Painted Texels: ${unprojectResult.metrics.directlyPaintedTexels}
           - Fill Rate: ${(unprojectResult.metrics.fillRate * 100).toFixed(2)}%
           - Submeshes with PBR textures: ${unprojectResult.submeshes.length}`);

        // Save generated PBR texture atlases to artifacts
        if (unprojectResult.albedoPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_2_baked_albedo_atlas.png'), unprojectResult.albedoPng);
        }
        if (unprojectResult.normalPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_2_baked_normal_atlas.png'), unprojectResult.normalPng);
        }
        if (unprojectResult.ormPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_2_baked_orm_atlas.png'), unprojectResult.ormPng);
        }

        // Step 4: Render from NOVEL CAMERA ANGLE to verify 3D UV Spatial Lock
        console.log('📷 [Step 3] Path-tracing textured 3D GLB from NOVEL ROTATED CAMERA VIEWPOINT...');
        const pathTracer = new NativeTilePathTracerService();
        const novelOutputDir = path.resolve(process.cwd(), 'build/zero_presets_renders/scene_2_novel_view');
        fs.mkdirSync(novelOutputDir, { recursive: true });

        // Novel Camera: Rotated +55 degrees azimuth, slightly lower dramatic angle
        const novelRender = await pathTracer.render({
            glbPath: outGlbPath,
            outputDir: novelOutputDir,
            width: 1280,
            height: 720,
            samplesPerPixel: 48,
            maxBounces: 4,
            shadingMode: 'relit',
            denoise: true,
            groundPlane: true,
            sun: { elevationDeg: 30, azimuthDeg: 210 },
            camera: {
                position: [18.5, 9.2, 14.8], // Novel position: opposite quadrant!
                target: [0, 2.8, 0],
                up: [0, 1, 0],
                verticalFovDeg: 42
            }
        });

        expect(fs.existsSync(novelRender.beautyPngPath)).toBe(true);
        const novelArtifactPath = path.join(ARTIFACT_DIR, 'screenshot_scene_2_textured_novel_angle.png');
        fs.copyFileSync(novelRender.beautyPngPath, novelArtifactPath);
        console.log(`📸 Novel-Angle Path-Traced Screenshot saved to: ${novelArtifactPath}`);
    }, 180000);

    it('Bakes photorealistic plates onto Zero-Preset Scene 3 (Fusion Thruster) and renders from novel viewpoints', async () => {
        const glbPath = path.resolve(process.cwd(), 'build/scene_3_thruster.glb');
        const platePngPath = path.join(ARTIFACT_DIR, 'scene_3_photorealistic_final.png');
        const outGlbPath = path.resolve(process.cwd(), 'build/scene_3_textured.glb');

        expect(fs.existsSync(glbPath)).toBe(true);
        expect(fs.existsSync(platePngPath)).toBe(true);

        const glbBuffer = await fs.readFile(glbPath);
        const plateBuffer = await fs.readFile(platePngPath);
        const plateImg = decodePng(plateBuffer);

        // Exact camera pose from stats.json
        const camPos: [number, number, number] = [-6.17362213, 5.11795044, 7.35743713];
        const camTarget: [number, number, number] = [0, 1.23750007, 0];
        const verticalFov = 44.0;
        const aspect = plateImg.width / plateImg.height;
        const halfVRad = (verticalFov * 0.5 * Math.PI) / 180;
        const halfHRad = Math.atan(Math.tan(halfVRad) * aspect);
        const horizFovDeg = (2 * halfHRad * 180) / Math.PI;
        const focalLengthMm = (36 * 0.5) / Math.tan(halfHRad);

        const station = stationFromLookAt(
            301,
            camPos,
            camTarget,
            { focalLengthMm, sensorWidthMm: 36, aspectRatio: aspect },
            ANCHOR
        );

        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glbBuffer);
        const blockout = renderer.renderStationBlockout(station, {
            width: plateImg.width,
            height: plateImg.height
        });

        const plate: StationPlate = {
            station,
            rgba: plateImg.rgba,
            width: plateImg.width,
            height: plateImg.height,
            depth: blockout.depth,
            pose: blockout.cameraPose,
            intrinsics: blockout.intrinsics
        };

        const unprojectResult = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath,
            anchor: ANCHOR,
            stations: [station],
            precomputedPlates: [plate],
            options: {
                outGlbPath,
                resolution: 1024,
                pbrDecomposition: {
                    enableAlbedoDeLighting: false,
                    enableSolarInverseDelighting: false,
                    enableMultiFrequencyNormals: false,
                    enableHbaoMicroCavity: false,
                    enableBiophysicalRoughness: true,
                    generateNormalMaps: true,
                    generateRoughnessMaps: true,
                    generateAoMaps: true,
                    packOrm: true,
                    normalStrength: 1.8
                }
            }
        });

        expect(unprojectResult.success).toBe(true);
        expect(fs.existsSync(outGlbPath)).toBe(true);

        if (unprojectResult.albedoPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_3_baked_albedo_atlas.png'), unprojectResult.albedoPng);
        }
        if (unprojectResult.normalPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_3_baked_normal_atlas.png'), unprojectResult.normalPng);
        }
        if (unprojectResult.ormPng) {
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_3_baked_orm_atlas.png'), unprojectResult.ormPng);
        }

        // Novel Camera: Rotated to inspect the opposite magnetic nozzle intake and reactor core
        const pathTracer = new NativeTilePathTracerService();
        const novelOutputDir = path.resolve(process.cwd(), 'build/zero_presets_renders/scene_3_novel_view');
        fs.mkdirSync(novelOutputDir, { recursive: true });

        const novelRender = await pathTracer.render({
            glbPath: outGlbPath,
            outputDir: novelOutputDir,
            width: 1280,
            height: 720,
            samplesPerPixel: 48,
            maxBounces: 4,
            shadingMode: 'relit',
            denoise: true,
            groundPlane: true,
            sun: { elevationDeg: 50, azimuthDeg: 160 },
            camera: {
                position: [7.8, 4.5, 6.2], // Novel rotated angle
                target: [0, 1.2, 0],
                up: [0, 1, 0],
                verticalFovDeg: 45
            }
        });

        expect(fs.existsSync(novelRender.beautyPngPath)).toBe(true);
        const novelArtifactPath = path.join(ARTIFACT_DIR, 'screenshot_scene_3_textured_novel_angle.png');
        fs.copyFileSync(novelRender.beautyPngPath, novelArtifactPath);
        console.log(`📸 Scene 3 Novel-Angle Path-Traced Screenshot saved to: ${novelArtifactPath}`);
    }, 180000);

    it('Bakes photorealistic plates onto Zero-Preset Scene 1 (Hydrothermal Vent Chimney) and renders from novel viewpoints', async () => {
        const glbPath = path.resolve(process.cwd(), 'build/scene_1_hydrothermal.glb');
        const platePngPath = path.join(ARTIFACT_DIR, 'scene_1_photorealistic_final.png');
        const outGlbPath = path.resolve(process.cwd(), 'build/scene_1_textured.glb');

        expect(fs.existsSync(glbPath)).toBe(true);
        expect(fs.existsSync(platePngPath)).toBe(true);

        const glbBuffer = await fs.readFile(glbPath);
        const plateBuffer = await fs.readFile(platePngPath);
        const plateImg = decodePng(plateBuffer);

        // Exact camera pose from stats.json
        const camPos: [number, number, number] = [-6.518, 5.704, 9.310];
        const camTarget: [number, number, number] = [0.0, 1.113, 0.0];
        const verticalFov = 42.0;
        const aspect = plateImg.width / plateImg.height;
        const halfVRad = (verticalFov * 0.5 * Math.PI) / 180;
        const halfHRad = Math.atan(Math.tan(halfVRad) * aspect);
        const horizFovDeg = (2 * halfHRad * 180) / Math.PI;
        const focalLengthMm = (36 * 0.5) / Math.tan(halfHRad);

        const station = stationFromLookAt(
            101,
            camPos,
            camTarget,
            { focalLengthMm, sensorWidthMm: 36, aspectRatio: aspect },
            ANCHOR
        );

        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glbBuffer);
        const blockout = renderer.renderStationBlockout(station, {
            width: plateImg.width,
            height: plateImg.height
        });

        const plate: StationPlate = {
            station,
            rgba: plateImg.rgba,
            width: plateImg.width,
            height: plateImg.height,
            depth: blockout.depth,
            pose: blockout.cameraPose,
            intrinsics: blockout.intrinsics
        };

        const unprojectResult = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath,
            precomputedPlates: [plate],
            options: {
                outGlbPath,
                resolution: 1024,
                pbrDecomposition: {
                    enableAlbedoDeLighting: false,
                    enableSolarInverseDelighting: false,
                    enableMultiFrequencyNormals: false,
                    enableHbaoMicroCavity: false,
                    enableBiophysicalRoughness: true,
                    generateNormalMaps: true,
                    generateRoughnessMaps: true,
                    generateAoMaps: true,
                    packOrm: true,
                    normalStrength: 1.8
                }
            }
        });

        expect(fs.existsSync(outGlbPath)).toBe(true);
        const stat = fs.statSync(outGlbPath);
        expect(stat.size).toBeGreaterThan(100000);

        if (unprojectResult.submeshes.length > 0) {
            const sm0 = unprojectResult.submeshes[0];
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_1_baked_albedo_atlas.png'), sm0.albedoPng);
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_1_baked_normal_atlas.png'), sm0.normalPng);
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'scene_1_baked_orm_atlas.png'), sm0.ormPng);
        }

        // Novel Camera: Rotated 120 degrees around chimney
        const pathTracer = new NativeTilePathTracerService();
        const novelOutputDir = path.resolve(process.cwd(), 'build/zero_presets_renders/scene_1_novel_view');
        fs.mkdirSync(novelOutputDir, { recursive: true });

        const novelRender = await pathTracer.render({
            glbPath: outGlbPath,
            outputDir: novelOutputDir,
            width: 1280,
            height: 720,
            samplesPerPixel: 48,
            maxBounces: 4,
            shadingMode: 'relit',
            denoise: true,
            groundPlane: true,
            sun: { elevationDeg: 35, azimuthDeg: 220 },
            camera: {
                position: [8.5, 5.2, 6.4],
                target: [0, 1.113, 0],
                up: [0, 1, 0],
                verticalFovDeg: 42
            }
        });

        expect(fs.existsSync(novelRender.beautyPngPath)).toBe(true);
        const novelArtifactPath = path.join(ARTIFACT_DIR, 'screenshot_scene_1_textured_novel_angle.png');
        fs.copyFileSync(novelRender.beautyPngPath, novelArtifactPath);
        console.log(`📸 Scene 1 Novel-Angle Path-Traced Screenshot saved to: ${novelArtifactPath}`);
    }, 180000);
});
