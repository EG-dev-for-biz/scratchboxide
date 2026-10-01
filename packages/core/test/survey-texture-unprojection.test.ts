/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { SurveySynthesisEngine, stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService, EMPTY_DEPTH } from '../src/node/spatial/SurveyStationRenderService';
import {
    SurveyTextureUnprojector,
    type StationPlate,
    type SurveyTexturePipelineRequest
} from '../src/node/spatial/SurveyTextureUnprojector';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor, ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';

const ANCHOR: GeodeticAnchor = {
    lat: 40.74844,
    lng: -73.98566,
    elevationMeters: 15,
    headingDeg: 0,
    formattedAddress: 'Empire State Building, NYC'
};

const TEST_DIR = path.resolve(process.cwd(), 'build/test_survey_texture');

/**
 * Builds a simple synthetic GLB with positions, normals, and indices.
 */
function createSyntheticCubeGlb(filePath: string, size: number = 10): Buffer {
    const s = size / 2;
    const V: number[] = [];
    const N: number[] = [];
    const UV: number[] = [];
    const I: number[] = [];

    const addQuad = (
        p0: number[], p1: number[], p2: number[], p3: number[],
        norm: number[],
        uRange: [number, number], vRange: [number, number]
    ) => {
        const base = V.length / 3;
        V.push(...p0, ...p1, ...p2, ...p3);
        N.push(...norm, ...norm, ...norm, ...norm);
        UV.push(
            uRange[0], vRange[0],
            uRange[1], vRange[0],
            uRange[1], vRange[1],
            uRange[0], vRange[1]
        );
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    // 6 faces of the cube with distinct atlas quadrants
    // South Face (+Z)
    addQuad([-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s], [0, 0, 1], [0.0, 0.5], [0.0, 0.5]);
    // North Face (-Z)
    addQuad([s, -s, -s], [-s, -s, -s], [-s, s, -s], [s, s, -s], [0, 0, -1], [0.5, 1.0], [0.0, 0.5]);
    // East Face (+X)
    addQuad([s, -s, s], [s, -s, -s], [s, s, -s], [s, s, s], [1, 0, 0], [0.0, 0.5], [0.5, 1.0]);
    // West Face (-X)
    addQuad([-s, -s, -s], [-s, -s, s], [-s, s, s], [-s, s, -s], [-1, 0, 0], [0.5, 1.0], [0.5, 1.0]);
    // Top Face (+Y)
    addQuad([-s, s, s], [s, s, s], [s, s, -s], [-s, s, -s], [0, 1, 0], [0.0, 0.3], [0.3, 0.6]);
    // Bottom Face (-Y)
    addQuad([-s, -s, -s], [s, -s, -s], [s, -s, s], [-s, -s, s], [0, -1, 0], [0.6, 0.9], [0.3, 0.6]);

    const pos = new Float32Array(V);
    const norm = new Float32Array(N);
    const uvs = new Float32Array(UV);
    const idx = new Uint32Array(I);

    const posBytes = Buffer.from(pos.buffer);
    const normBytes = Buffer.from(norm.buffer);
    const uvBytes = Buffer.from(uvs.buffer);
    const idxBytes = Buffer.from(idx.buffer);

    const bin = Buffer.concat([posBytes, normBytes, uvBytes, idxBytes]);

    const min = [-s, -s, -s], max = [s, s, s];
    const vertCount = V.length / 3;

    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{
            primitives: [{
                attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
                indices: 3,
                mode: 4
            }]
        }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: vertCount, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5126, count: vertCount, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: vertCount, type: 'VEC2' },
            { bufferView: 3, componentType: 5125, count: I.length, type: 'SCALAR' }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
            { buffer: 0, byteOffset: posBytes.length, byteLength: normBytes.length },
            { buffer: 0, byteOffset: posBytes.length + normBytes.length, byteLength: uvBytes.length },
            { buffer: 0, byteOffset: posBytes.length + normBytes.length + uvBytes.length, byteLength: idxBytes.length }
        ],
        buffers: [{ byteLength: bin.length }]
    };

    let js = Buffer.from(JSON.stringify(json));
    while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    let bb = bin;
    while (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(1)]);

    const total = 12 + 8 + js.length + 8 + bb.length;
    const h = Buffer.alloc(12);
    h.writeUInt32LE(0x46546c67, 0);
    h.writeUInt32LE(2, 4);
    h.writeUInt32LE(total, 8);

    const jc = Buffer.alloc(8);
    jc.writeUInt32LE(js.length, 0);
    jc.writeUInt32LE(0x4e4f534a, 4);

    const bc = Buffer.alloc(8);
    bc.writeUInt32LE(bb.length, 0);
    bc.writeUInt32LE(0x004e4942, 4);

    const fullGlb = Buffer.concat([h, jc, js, bc, bb]);
    fs.outputFileSync(filePath, fullGlb);
    return fullGlb;
}

/**
 * Builds a synthetic GLB with 2 submeshes (each having distinct vertices, [0, 1] UVs, and distinct materials).
 */
function createSyntheticMultiSubmeshGlb(filePath: string, size: number = 10): Buffer {
    const s = size / 2;
    // Primitive 0: South face (+Z)
    const V0 = [-s, -s, s,  s, -s, s,  s, s, s,  -s, s, s];
    const N0 = [0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1];
    const UV0 = [0, 0,  1, 0,  1, 1,  0, 1];
    const I0 = [0, 1, 2,  0, 2, 3];

    // Primitive 1: North face (-Z)
    const V1 = [s, -s, -s,  -s, -s, -s,  -s, s, -s,  s, s, -s];
    const N1 = [0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1];
    const UV1 = [0, 0,  1, 0,  1, 1,  0, 1];
    const I1 = [0, 1, 2,  0, 2, 3];

    const pos0 = new Float32Array(V0);
    const norm0 = new Float32Array(N0);
    const uvs0 = new Float32Array(UV0);
    const idx0 = new Uint32Array(I0);

    const pos1 = new Float32Array(V1);
    const norm1 = new Float32Array(N1);
    const uvs1 = new Float32Array(UV1);
    const idx1 = new Uint32Array(I1);

    const bPos0 = Buffer.from(pos0.buffer);
    const bNorm0 = Buffer.from(norm0.buffer);
    const bUv0 = Buffer.from(uvs0.buffer);
    const bIdx0 = Buffer.from(idx0.buffer);

    const bPos1 = Buffer.from(pos1.buffer);
    const bNorm1 = Buffer.from(norm1.buffer);
    const bUv1 = Buffer.from(uvs1.buffer);
    const bIdx1 = Buffer.from(idx1.buffer);

    const bin = Buffer.concat([bPos0, bNorm0, bUv0, bIdx0, bPos1, bNorm1, bUv1, bIdx1]);

    const offPos0 = 0;
    const offNorm0 = bPos0.length;
    const offUv0 = offNorm0 + bNorm0.length;
    const offIdx0 = offUv0 + bUv0.length;
    const offPos1 = offIdx0 + bIdx0.length;
    const offNorm1 = offPos1 + bPos1.length;
    const offUv1 = offNorm1 + bNorm1.length;
    const offIdx1 = offUv1 + bUv1.length;

    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        materials: [{ name: 'mat_south' }, { name: 'mat_north' }],
        meshes: [{
            primitives: [
                {
                    attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
                    indices: 3,
                    material: 0,
                    mode: 4
                },
                {
                    attributes: { POSITION: 4, NORMAL: 5, TEXCOORD_0: 6 },
                    indices: 7,
                    material: 1,
                    mode: 4
                }
            ]
        }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-s, -s, s], max: [s, s, s] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 3, componentType: 5125, count: 6, type: 'SCALAR' },
            { bufferView: 4, componentType: 5126, count: 4, type: 'VEC3', min: [-s, -s, -s], max: [s, s, -s] },
            { bufferView: 5, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 6, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 7, componentType: 5125, count: 6, type: 'SCALAR' }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: offPos0, byteLength: bPos0.length },
            { buffer: 0, byteOffset: offNorm0, byteLength: bNorm0.length },
            { buffer: 0, byteOffset: offUv0, byteLength: bUv0.length },
            { buffer: 0, byteOffset: offIdx0, byteLength: bIdx0.length },
            { buffer: 0, byteOffset: offPos1, byteLength: bPos1.length },
            { buffer: 0, byteOffset: offNorm1, byteLength: bNorm1.length },
            { buffer: 0, byteOffset: offUv1, byteLength: bUv1.length },
            { buffer: 0, byteOffset: offIdx1, byteLength: bIdx1.length }
        ],
        buffers: [{ byteLength: bin.length }]
    };

    let js = Buffer.from(JSON.stringify(json));
    while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    let bb = bin;
    while (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(1)]);

    const total = 12 + 8 + js.length + 8 + bb.length;
    const h = Buffer.alloc(12);
    h.writeUInt32LE(0x46546c67, 0);
    h.writeUInt32LE(2, 4);
    h.writeUInt32LE(total, 8);

    const jc = Buffer.alloc(8);
    jc.writeUInt32LE(js.length, 0);
    jc.writeUInt32LE(0x4e4f534a, 4);

    const bc = Buffer.alloc(8);
    bc.writeUInt32LE(bb.length, 0);
    bc.writeUInt32LE(0x004e4942, 4);

    const fullGlb = Buffer.concat([h, jc, js, bc, bb]);
    fs.outputFileSync(filePath, fullGlb);
    return fullGlb;
}

describe('SurveyTextureUnprojector: Survey-to-Atlas Inverse Projection (SAIP)', () => {
    const cubeGlbPath = path.join(TEST_DIR, 'test_cube.glb');
    const outGlbPath = path.join(TEST_DIR, 'test_cube_pbr.glb');
    let cubeGlbBuffer: Buffer;

    beforeAll(async () => {
        await fs.emptyDir(TEST_DIR);
        cubeGlbBuffer = createSyntheticCubeGlb(cubeGlbPath, 10);
    });

    it('loads mesh primitives and extracts UVs accurately', () => {
        const { primitives, glbJson } = SurveyTextureUnprojector.loadMeshPrimitives(cubeGlbBuffer, 512);
        expect(primitives.length).toBe(1);
        const prim = primitives[0];
        expect(prim.positions.length).toBe(24 * 3);
        expect(prim.normals.length).toBe(24 * 3);
        expect(prim.uvs.length).toBe(24 * 2);
        expect(prim.indices.length).toBe(36); // 12 triangles * 3
        expect(glbJson.asset.version).toBe('2.0');
    });

    it('synthesizes non-overlapping box UVs via MaxRects if mesh lacks TEXCOORD_0', () => {
        const positions = new Float32Array([
            -5, -5, 5,   5, -5, 5,   5, 5, 5,
            -5, -5, 5,   5, 5, 5,   -5, 5, 5
        ]);
        const normals = new Float32Array([
            0, 0, 1,   0, 0, 1,   0, 0, 1,
            0, 0, 1,   0, 0, 1,   0, 0, 1
        ]);
        const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);

        const uvs = SurveyTextureUnprojector.generateBoxUvs(positions, normals, indices, 512);
        expect(uvs.length).toBe(6 * 2);
        for (let i = 0; i < uvs.length; i++) {
            expect(uvs[i]).toBeGreaterThanOrEqual(0.0);
            expect(uvs[i]).toBeLessThanOrEqual(1.0);
        }
    });

    it('analytically culls occluded geometry via software metric-depth test', () => {
        // Create 2 stations:
        // Station 1: South looking North towards +Z face (Z=5) from Z=25 (dist = 20m)
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], { focalLengthMm: 35, sensorWidthMm: 36 }, ANCHOR);
        // Station 2: North looking South towards -Z face (Z=-5) from Z=-25 (dist = 20m)
        const stNorth = stationFromLookAt(2, [0, 0, -25], [0, 0, 0], { focalLengthMm: 35, sensorWidthMm: 36 }, ANCHOR);

        const renderer = new SurveyStationRenderService();
        renderer.loadMesh(cubeGlbBuffer);

        const blockoutSouth = renderer.renderStationBlockout(stSouth, { width: 320, height: 240 });
        const blockoutNorth = renderer.renderStationBlockout(stNorth, { width: 320, height: 240 });

        // Center pixel of south blockout must record metric depth ~20 meters to the front face (Z=5)
        const centerDepthSouth = blockoutSouth.depth[120 * 320 + 160];
        expect(centerDepthSouth).toBeCloseTo(20.0, 1);

        // Center pixel of north blockout must record metric depth ~20 meters to the back face (Z=-5)
        const centerDepthNorth = blockoutNorth.depth[120 * 320 + 160];
        expect(centerDepthNorth).toBeCloseTo(20.0, 1);
    });

    it('orthogonal station dominates over grazing-angle views in score weighting', () => {
        // Station 1: Direct perpendicular view (cos theta ~ 1.0)
        const poseDirect = SurveyStationRenderService.stationToCameraPose6DOF(
            stationFromLookAt(1, [0, 0, 25], [0, 0, 0], { focalLengthMm: 35, sensorWidthMm: 36 }, ANCHOR),
            320, 240
        );
        // Station 2: Steep angle view at 75 degrees (cos theta ~ 0.25)
        const poseGlance = SurveyStationRenderService.stationToCameraPose6DOF(
            stationFromLookAt(2, [30, 0, 8], [0, 0, 5], { focalLengthMm: 35, sensorWidthMm: 36 }, ANCHOR),
            320, 240
        );

        const VPDirect = SurveyTextureUnprojector.buildViewProjectionMatrix(poseDirect, 320, 240);
        const VPGlance = SurveyTextureUnprojector.buildViewProjectionMatrix(poseGlance, 320, 240);

        expect(VPDirect.length).toBe(16);
        expect(VPGlance.length).toBe(16);
    });

    it('executes complete end-to-end SAIP pipeline with multi-view stations and PBR generation', async () => {
        // 4 orthogonal survey stations observing the 4 vertical facades (South, North, East, West)
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const stNorth = stationFromLookAt(2, [0, 0, -25], [0, 0, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const stEast = stationFromLookAt(3, [25, 0, 0], [0, 0, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const stWest = stationFromLookAt(4, [-25, 0, 0], [0, 0, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);

        // Mock generator: paints distinct architectural colors per station
        // Station 1: Terracotta red facade [200, 80, 60]
        // Station 2: Limestone buff facade [215, 205, 185]
        // Station 3: Granite grey facade [160, 160, 165]
        // Station 4: Sandstone warm facade [210, 180, 130]
        const mockGenerator: StationImageGenerator = {
            name: 'mock-facade-generator',
            async generate(args) {
                const b = decodePng(args.blockoutPng);
                const out = Buffer.alloc(b.rgba.length);
                for (let i = 0; i < b.rgba.length; i += 4) {
                    const r = b.rgba[i], g = b.rgba[i + 1], bl = b.rgba[i + 2];
                    const isSky = bl > 170 && r < 140;
                    if (isSky) {
                        out[i] = 135; out[i + 1] = 175; out[i + 2] = 220; out[i + 3] = 255;
                    } else {
                        // Ground or box facade
                        out[i] = Math.min(255, r + 40);
                        out[i + 1] = Math.min(255, g + 25);
                        out[i + 2] = Math.min(255, bl + 10);
                        out[i + 3] = 255;
                    }
                }
                return encodePng(b.width, b.height, out);
            }
        };

        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [stSouth, stNorth, stEast, stWest],
            generator: mockGenerator,
            beautifyContext: {
                locationName: 'Synthetic Architectural Tower',
                moodPromptContext: 'Warm late afternoon sunlight with crisp architectural shadows',
                styleSuffix: 'photorealistic 8k architectural survey'
            },
            options: {
                resolution: 512, // fast test resolution
                depthTolerance: 0.25,
                minCosIncidence: 0.08,
                solarDelighting: {
                    lat: ANCHOR.lat,
                    lng: ANCHOR.lng,
                    isoDate: '2024-06-21T16:00:00Z'
                },
                outGlbPath
            }
        });

        expect(result.success).toBe(true);
        expect(result.metrics.resolution).toBe(512);
        expect(result.metrics.coveredMeshTexels).toBeGreaterThan(0);
        expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
        expect(result.metrics.fillRate).toBeGreaterThan(0.05); // Valid fraction of 512x512 atlas
        expect(result.metrics.stationContributions.length).toBeGreaterThanOrEqual(1);

        // Validate texture buffers
        expect(result.albedoPng.length).toBeGreaterThan(100);
        expect(result.normalPng.length).toBeGreaterThan(100);
        expect(result.ormPng.length).toBeGreaterThan(100);
        expect(result.roughnessPng.length).toBeGreaterThan(100);
        expect(result.aoPng.length).toBeGreaterThan(100);

        // Validate that decoded normal map has +Z normal blue [128, 128, 255] baseline
        const decodedNormal = decodePng(result.normalPng);
        expect(decodedNormal.width).toBe(512);
        expect(decodedNormal.height).toBe(512);

        // Validate output GLB file
        expect(fs.existsSync(outGlbPath)).toBe(true);
        const outStat = await fs.stat(outGlbPath);
        expect(outStat.size).toBeGreaterThan(result.albedoPng.length + result.normalPng.length);

        // Re-parse output GLB to verify structure
        const outParsed = AlgorithmicUvEngine.parseGlb(result.glbBuffer);
        expect(outParsed.json.asset.version).toBe('2.0');
        expect(outParsed.json.images.length).toBeGreaterThanOrEqual(3); // albedo, normal, orm
        expect(outParsed.json.materials.length).toBeGreaterThanOrEqual(1);
        const mat = outParsed.json.materials[0];
        expect(mat.pbrMetallicRoughness.baseColorTexture).toBeDefined();
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(mat.normalTexture).toBeDefined();

        // KHR_materials_unlit must be absent
        if (mat.extensions) {
            expect(mat.extensions.KHR_materials_unlit).toBeUndefined();
        }
        if (outParsed.json.extensionsUsed) {
            expect(outParsed.json.extensionsUsed).not.toContain('KHR_materials_unlit');
        }
    });

    it('executes draft mode with auto aspect ratio, multiStationBlend, and metricJacobianScaling on synthetic geometry', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stSouth = stationFromLookAt(1, [0, 8, 30], [0, 10, 0], optics, ANCHOR);
        // North-up steep camera looking up at tower (pitch > 25 deg)
        const stNorthSteep = stationFromLookAt(2, [0, 2, -20], [0, 25, 0], optics, ANCHOR);

        let capturedAspectRatio = '';
        const mockDraftGen: StationImageGenerator = {
            name: 'mock-draft-generator',
            async generate(args) {
                capturedAspectRatio = args.aspectRatio || '';
                const b = decodePng(args.blockoutPng);
                const out = Buffer.alloc(b.rgba.length);
                for (let i = 0; i < out.length; i += 4) {
                    out[i] = 210;
                    out[i + 1] = 200;
                    out[i + 2] = 180;
                    out[i + 3] = 255;
                }
                return encodePng(b.width, b.height, out);
            }
        };

        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [stSouth, stNorthSteep],
            generator: mockDraftGen,
            beautifyContext: {
                locationName: 'Draft Aspect Ratio Synthetic Building'
            },
            options: {
                resolution: 512,
                draft: true,
                aspectRatio: 'auto',
                multiStationBlend: true,
                metricJacobianScaling: true,
                outGlbPath
            }
        });

        expect(result.success).toBe(true);
        expect(result.metrics.resolution).toBe(512);
        expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
        expect(fs.existsSync(outGlbPath)).toBe(true);
        expect(result.normalPng.length).toBeGreaterThan(100);
        expect(result.ormPng.length).toBeGreaterThan(100);
    });

    it('resamples generated plate when mock generator returns different resolution than requested', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR);

        // Mock generator returning 1024x1024 plate regardless of requested dimensions (e.g. 512x288)
        let generatedWidth = 0;
        let generatedHeight = 0;
        const mockMismatchedGen: StationImageGenerator = {
            name: 'mock-mismatched-generator',
            async generate() {
                generatedWidth = 1024;
                generatedHeight = 1024;
                const buf = Buffer.alloc(1024 * 1024 * 4);
                buf.fill(200);
                return encodePng(1024, 1024, buf);
            }
        };

        const outResampledGlbPath = path.join(TEST_DIR, 'cube_resampled_test.glb');
        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [stSouth],
            generator: mockMismatchedGen,
            beautifyContext: { locationName: 'Resample Test' },
            options: {
                renderWidth: 512,
                renderHeight: 288,
                resolution: 512,
                draft: true,
                outGlbPath: outResampledGlbPath
            }
        });

        expect(result.success).toBe(true);
        expect(generatedWidth).toBe(1024);
        expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
        expect(fs.existsSync(outResampledGlbPath)).toBe(true);
    });

    it('enforces fidelity routing: rejects mismatched generator fidelity', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR);

        const prodGenerator: StationImageGenerator = {
            name: 'prod-gen',
            fidelity: 'production',
            async generate(args) { return args.blockoutPng; }
        };

        // Draft mode with production generator must throw
        await expect(
            SurveyTextureUnprojector.processGlbWithSurveyStations({
                glbPath: cubeGlbPath,
                anchor: ANCHOR,
                stations: [stSouth],
                generator: prodGenerator,
                options: { draft: true }
            })
        ).rejects.toThrow(/fidelity.*disagrees/i);

        const draftGenerator: StationImageGenerator = {
            name: 'draft-gen',
            fidelity: 'draft',
            async generate(args) { return args.blockoutPng; }
        };

        // Production mode with draft generator must throw
        await expect(
            SurveyTextureUnprojector.processGlbWithSurveyStations({
                glbPath: cubeGlbPath,
                anchor: ANCHOR,
                stations: [stSouth],
                generator: draftGenerator,
                options: { draft: false }
            })
        ).rejects.toThrow(/fidelity.*disagrees/i);
    });

    it('chains stations by passing previousAccepted reference', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const st1 = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR);
        const st2 = stationFromLookAt(2, [5, 0, 25], [0, 0, 0], optics, ANCHOR);

        let receivedReferenceInSecondCall = false;
        let callCount = 0;
        const mockChainingGen: StationImageGenerator = {
            name: 'mock-chaining-gen',
            async generate(args) {
                callCount++;
                if (callCount === 2 && args.referencePng && args.referencePng.length > 0) {
                    receivedReferenceInSecondCall = true;
                }
                const b = decodePng(args.blockoutPng);
                return encodePng(b.width, b.height, b.rgba);
            }
        };

        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [st1, st2],
            generator: mockChainingGen,
            options: {
                resolution: 512,
                draft: true
            }
        });

        expect(result.success).toBe(true);
        expect(callCount).toBe(2);
        expect(receivedReferenceInSecondCall).toBe(true);
    });

    it('processes multi-submesh GLB into per-submesh original-UV atlases without repacking or UV write-backs', async () => {
        const multiGlbPath = path.join(TEST_DIR, 'multi_submesh.glb');
        createSyntheticMultiSubmeshGlb(multiGlbPath);

        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR);
        const stNorth = stationFromLookAt(2, [0, 0, -25], [0, 0, 0], optics, ANCHOR);

        const mockGen: StationImageGenerator = {
            name: 'mock-multi-gen',
            async generate(args) {
                const b = decodePng(args.blockoutPng);
                return encodePng(b.width, b.height, b.rgba);
            }
        };

        const outMultiGlbPath = path.join(TEST_DIR, 'multi_submesh_out.glb');
        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: multiGlbPath,
            anchor: ANCHOR,
            stations: [stSouth, stNorth],
            generator: mockGen,
            options: {
                resolution: 512,
                draft: true,
                outGlbPath: outMultiGlbPath
            }
        });

        expect(result.success).toBe(true);
        expect(result.submeshes).toBeDefined();
        expect(result.submeshes!.length).toBe(2);

        // Verify each submesh has its own textures
        expect(result.submeshes![0].albedoPng.length).toBeGreaterThan(100);
        expect(result.submeshes![1].albedoPng.length).toBeGreaterThan(100);

        // Verify that the output GLB preserves distinct materials per submesh
        const parsed = AlgorithmicUvEngine.parseGlb(result.glbBuffer);
        expect(parsed.json.materials.length).toBeGreaterThanOrEqual(2);
        const prim0 = parsed.json.meshes[0].primitives[0];
        const prim1 = parsed.json.meshes[0].primitives[1];
        expect(prim0.material).not.toBe(prim1.material);

        // Verify original UV accessors were NOT modified or squashed into sub-rectangles:
        // The original quad UVs had u=1.0 and v=1.0. If repacked into sub-rects, max UV would be < 1.0.
        const uvAcc0 = parsed.json.accessors[prim0.attributes.TEXCOORD_0];
        const uvAcc1 = parsed.json.accessors[prim1.attributes.TEXCOORD_0];
        const view0 = parsed.json.bufferViews[uvAcc0.bufferView];
        const view1 = parsed.json.bufferViews[uvAcc1.bufferView];
        const uvs0 = new Float32Array(parsed.bin.buffer, parsed.bin.byteOffset + (view0.byteOffset || 0) + (uvAcc0.byteOffset || 0), uvAcc0.count * 2);
        const uvs1 = new Float32Array(parsed.bin.buffer, parsed.bin.byteOffset + (view1.byteOffset || 0) + (uvAcc1.byteOffset || 0), uvAcc1.count * 2);

        let maxU0 = 0, maxV0 = 0;
        for (let i = 0; i < uvs0.length; i += 2) {
            maxU0 = Math.max(maxU0, uvs0[i]);
            maxV0 = Math.max(maxV0, uvs0[i + 1]);
        }
        expect(maxU0).toBeCloseTo(1.0, 2);
        expect(maxV0).toBeCloseTo(1.0, 2);
    });

    it('processes real-world Empire State Building mesh with orbital survey stations', async () => {
        const esbRawPath = path.resolve(process.cwd(), 'public/models/spce_esb_isolated_full_quality_raw.glb');
        if (!fs.existsSync(esbRawPath)) {
            console.log('Skipping ESB test because file does not exist');
            return;
        }

        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(ANCHOR, {
            type: 'orbital-multi-tier',
            cameraCount: 4,
            targetRadiusMeters: 120,
            lookAtOffsetLocalENU: [0, 80, 0]
        });

        expect(stations.length).toBe(4);

        const outEsbGlbPath = path.join(TEST_DIR, 'esb_survey_pbr.glb');

        // Generator simulating AI Beautify limestone and dark reflective glass
        const mockBeautifier: StationImageGenerator = {
            name: 'mock-esb-beautifier',
            fidelity: 'draft',
            async generate(args) {
                const b = decodePng(args.blockoutPng);
                const out = Buffer.alloc(b.rgba.length);
                for (let i = 0; i < b.rgba.length; i += 4) {
                    const r = b.rgba[i], g = b.rgba[i + 1], bl = b.rgba[i + 2];
                    const isSky = bl > 180 && r < 120;
                    if (isSky) {
                        out[i] = 140; out[i + 1] = 180; out[i + 2] = 230; out[i + 3] = 255;
                    } else {
                        // Dark glass vs limestone
                        const isWindow = (i / 4) % 17 < 3;
                        if (isWindow) {
                            out[i] = 30; out[i + 1] = 38; out[i + 2] = 52; out[i + 3] = 255;
                        } else {
                            out[i] = 215; out[i + 1] = 205; out[i + 2] = 185; out[i + 3] = 255;
                        }
                    }
                }
                return encodePng(b.width, b.height, out);
            }
        };

        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: esbRawPath,
            anchor: ANCHOR,
            stations,
            generator: mockBeautifier,
            beautifyContext: {
                locationName: 'Empire State Building, New York',
                moodPromptContext: 'Art Deco limestone facade with Indiana limestone and cast aluminum spandrels',
                styleSuffix: 'photorealistic architectural photography'
            },
            options: {
                draft: true,
                resolution: 1024,
                renderWidth: 640,
                renderHeight: 360,
                depthTolerance: 0.5,
                gutterDilationPixels: 4,
                solarDelighting: {
                    lat: ANCHOR.lat,
                    lng: ANCHOR.lng,
                    isoDate: '2024-06-21T15:00:00Z'
                },
                outGlbPath: outEsbGlbPath
            }
        });

        expect(result.success).toBe(true);
        expect(result.metrics.resolution).toBe(1024);
        expect(result.metrics.coveredMeshTexels).toBeGreaterThan(0);
        expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
        expect(result.metrics.fillRate).toBeGreaterThan(0.01);
        expect(fs.existsSync(outEsbGlbPath)).toBe(true);

        // Save outputs to build/test_survey_texture/ (never public/models)
        const testGlbPath = path.resolve(TEST_DIR, 'spce_esb_saip_survey_pbr.glb');
        const testAlbedoPath = path.resolve(TEST_DIR, 'spce_esb_saip_albedo.png');
        await fs.copyFile(outEsbGlbPath, testGlbPath);
        await fs.writeFile(testAlbedoPath, result.albedoPng);
    }, 180000);
});
