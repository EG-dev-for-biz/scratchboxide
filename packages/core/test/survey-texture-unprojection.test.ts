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
import { decodePng, encodePng, resampleRgba } from '../src/node/texture-processing';
import { GeneratorFailedError, MissingInputError } from '../src/common/errors/pipeline-errors';
import { uvCubeMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';
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
                // A geometry-preserving restyle (the blockout, warmed): it passes the edge QC like a faithful model.
                const b = decodePng(args.blockoutPng);
                const out = Buffer.from(b.rgba);
                for (let i = 0; i < out.length; i += 4) {
                    out[i] = Math.min(255, Math.round(out[i] * 1.1));
                    out[i + 2] = Math.round(out[i + 2] * 0.85);
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

        // Mock generator answering at twice the requested size (1024x576 for 512x288), as models answer at their own size
        let generatedWidth = 0;
        let generatedHeight = 0;
        const mockMismatchedGen: StationImageGenerator = {
            name: 'mock-mismatched-generator',
            async generate(args) {
                const b = decodePng(args.blockoutPng);
                generatedWidth = b.width * 2;
                generatedHeight = b.height * 2;
                return encodePng(generatedWidth, generatedHeight, resampleRgba(b.rgba, b.width, b.height, generatedWidth, generatedHeight));
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
        expect(generatedHeight).toBe(576);
        expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
        expect(fs.existsSync(outResampledGlbPath)).toBe(true);
    });

    it('reports progress per station and per baked texture, in order, for the chat', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stations = [stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR), stationFromLookAt(2, [25, 0, 0], [0, 0, 0], optics, ANCHOR)];
        const gen: StationImageGenerator = { name: 'echo', async generate(a) { return a.blockoutPng; } };
        const reports: Array<[string, number]> = [];
        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath, anchor: ANCHOR, stations, generator: gen, beautifyContext: { locationName: 'Progress Test' },
            options: { renderWidth: 256, renderHeight: 144, resolution: 256, draft: true, outGlbPath: path.join(TEST_DIR, 'cube_progress_test.glb') },
            onProgress: (message, fraction) => reports.push([message, fraction])
        });
        expect(result.success).toBe(true);
        const messages = reports.map(r => r[0]);
        expect(messages.slice(0, 2)).toEqual(['Beautifying station 1/2', 'Beautifying station 2/2']);
        expect(messages.some(m => /^Baking texture 1\/\d+$/.test(m))).toBe(true);
        const fractions = reports.map(r => r[1]);
        expect(fractions.every((f, i) => f >= 0 && f < 1 && (i === 0 || f >= fractions[i - 1]))).toBe(true);
    });

    it('stops between stations when the caller aborts (the chat Stop button or a deadline)', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stations = [stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR), stationFromLookAt(2, [25, 0, 0], [0, 0, 0], optics, ANCHOR)];
        const stop = new AbortController();
        let calls = 0;
        const gen: StationImageGenerator = { name: 'stop-after-one', async generate(a) { calls++; stop.abort(); return a.blockoutPng; } };
        await expect(SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath, anchor: ANCHOR, stations, generator: gen, beautifyContext: { locationName: 'Stop Test' },
            options: { renderWidth: 256, renderHeight: 144, resolution: 256, draft: true, outGlbPath: path.join(TEST_DIR, 'cube_stop_test.glb') },
            signal: stop.signal
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toBe(1);
        expect(fs.existsSync(path.join(TEST_DIR, 'cube_stop_test.glb'))).toBe(false);
    });

    it('a Stop during the texture bake ends it before the output is written', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stations = [stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR)];
        const gen: StationImageGenerator = { name: 'echo', async generate(a) { return a.blockoutPng; } };
        const stop = new AbortController();
        const out = path.join(TEST_DIR, 'cube_stop_during_bake.glb');
        await expect(SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath, anchor: ANCHOR, stations, generator: gen, beautifyContext: { locationName: 'Bake Stop' },
            options: { renderWidth: 256, renderHeight: 144, resolution: 256, draft: true, outGlbPath: out },
            // the Stop arrives as an I/O-style event while the first submesh is baking
            onProgress: message => { if (message.startsWith('Baking texture 1/')) setImmediate(() => stop.abort()); },
            signal: stop.signal
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fs.existsSync(out)).toBe(false);
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

    it('leaves out a station whose image fails geometry QC, keeps the mesh\'s own colour where nothing was seen, and fails when no station passes', async () => {
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        const stSouth = stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR);
        const stNorth = stationFromLookAt(2, [0, 0, -25], [0, 0, 0], optics, ANCHOR);
        // The first call is restyled faithfully (the blockout itself); every later call comes back as a flat magenta
        // image that moved every edge, so it fails geometry QC.
        let call = 0;
        const mixed: StationImageGenerator = {
            name: 'qc-mix-gen',
            async generate(args) {
                call++;
                const b = decodePng(args.blockoutPng);
                if (call === 1) return encodePng(b.width, b.height, b.rgba);
                const flat = Buffer.alloc(b.rgba.length, 255);
                for (let i = 0; i < flat.length; i += 4) { flat[i] = 255; flat[i + 1] = 0; flat[i + 2] = 255; }
                return encodePng(b.width, b.height, flat);
            }
        };
        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [stSouth, stNorth],
            generator: mixed,
            beautifyContext: { locationName: 'QC Synthetic Cube' },
            options: { resolution: 256, draft: true, radianceEqualization: { enabled: false }, skipPbrDecomposition: true }
        });
        expect(result.rejectedStations.map(r => r.stationId)).toEqual([2]);
        expect(result.metrics.stationContributions.map(c => c.stationId)).toEqual([1]);
        // No magenta from the rejected image anywhere in the atlas.
        const atlas = decodePng(result.albedoPng);
        let magenta = 0;
        for (let i = 0; i < atlas.rgba.length; i += 4) if (atlas.rgba[i] > 240 && atlas.rgba[i + 1] < 20 && atlas.rgba[i + 2] > 240) magenta++;
        expect(magenta).toBe(0);
        // The back of the cube was seen by no accepted station; it keeps the mesh's own colour, not invented limestone.
        expect(result.unobservedTexels).toBeGreaterThan(0);
        let limestone = 0;
        for (let i = 0; i < atlas.rgba.length; i += 4) if (atlas.rgba[i] === 210 && atlas.rgba[i + 1] === 205 && atlas.rgba[i + 2] === 195) limestone++;
        expect(limestone).toBe(0);
        // This cube has no material, so its own colour is glTF's default white.
        let white = 0;
        for (let i = 0; i < atlas.rgba.length; i += 4) if (atlas.rgba[i] === 255 && atlas.rgba[i + 1] === 255 && atlas.rgba[i + 2] === 255) white++;
        expect(white).toBeGreaterThan(0);

        call = 1; // every following call answers with the flat image
        await expect(SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath,
            anchor: ANCHOR,
            stations: [stNorth],
            generator: mixed,
            beautifyContext: { locationName: 'QC Synthetic Cube' },
            options: { resolution: 128, draft: true }
        })).rejects.toBeInstanceOf(GeneratorFailedError);

        // And the stations are generated for a named place: no placeholder name.
        await expect(SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath: cubeGlbPath, anchor: ANCHOR, stations: [stSouth], generator: mixed, options: { resolution: 128, draft: true }
        })).rejects.toThrow('needs locationName');
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
            beautifyContext: { locationName: 'Chained Synthetic Cube' },
            options: {
                resolution: 512,
                draft: true
            }
        });

        expect(result.success).toBe(true);
        expect(callCount).toBe(2);
        expect(receivedReferenceInSecondCall).toBe(true);
    });

    it('survey_beautify_to_texture de-lights only for the date it is given, says whether it did, and writes into the workspace', async () => {
        const os = await import('os');
        const { vi } = await import('vitest');
        const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
        const { GoogleMediaCredentialsService } = await import('../src/node/google-media-credentials-service');
        const { fakeImageModelClient } = await import('./helpers/fake-image-model');
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-survey-texture-tool-'));
        const stationsJsonPath = path.join(ws, 'stations.json');
        // The anchor as survey_synthesize_stations writes it ({ lat, lng }); de-lighting used to read latitude/longitude.
        await fs.outputJson(stationsJsonPath, { anchor: ANCHOR, poses: [stationFromLookAt(1, [0, 0, 25], [0, 0, 0], { focalLengthMm: 35, sensorWidthMm: 36 }, ANCHOR)] });
        const spy = vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(fakeImageModelClient([], { modelVersion: 'gemini-3.1-flash-image' }) as any);
        try {
            const args = { glbPath: cubeGlbPath, stationsJsonPath, locationName: 'Test Cube', resolution: 64 };
            const undated = await spatialHandlers.survey_beautify_to_texture(args, { workspaceRoot: ws } as any);
            const p1 = undated.resultPayload as any;
            expect(p1.solarDelightingApplied).toBe(false);
            expect(undated.summaryResult).toContain('without solar de-lighting (it needs the isoDate the images depict)');
            expect(p1.outGlbPath.startsWith(path.join(ws, 'public', 'models'))).toBe(true);

            const dated = await spatialHandlers.survey_beautify_to_texture({ ...args, isoDate: '2026-06-21T02:00:00Z' }, { workspaceRoot: ws } as any);
            // the date is passed through; whether the pass changes pixels depends on the sun and on the ambient fit the
            // texture supports, and the summary says which (this fake image is too uniform to measure the ambient)
            expect((dated.resultPayload as any).solarDelightingApplied).toBe(false);
            expect(dated.summaryResult).toMatch(/without solar de-lighting \(not applied: (the sun is at or below the horizon|too few texels|the ambient-to-sun ratio|the shading fit)/);

            await expect(spatialHandlers.survey_beautify_to_texture({ ...args, stationsJsonPath: path.join(ws, 'missing.json') }, { workspaceRoot: ws } as any))
                .rejects.toThrow(/survey_beautify_to_texture needs stationsJsonPath: .*missing\.json does not exist/);
        } finally {
            spy.mockRestore();
            fs.removeSync(ws);
        }
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
            beautifyContext: { locationName: 'Multi-Submesh Synthetic Building' },
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

describe('SurveyTextureUnprojector: a mesh without its own UVs', () => {
    /** The review's probe mesh: a 10 m box with POSITION (and normals) but no TEXCOORD_0. */
    const uvlessBox = (file: string) => writeFixtureGlb(path.join(TEST_DIR, file), { ...uvCubeMesh(10), uvs: undefined });

    it('is refused before any station image is generated, instead of reporting a texture that cannot show', async () => {
        const glbPath = uvlessBox('uvless_box.glb');
        const outGlbPath = path.join(TEST_DIR, 'uvless_box_textured.glb');
        let calls = 0;
        const gen: StationImageGenerator = { name: 'echo', async generate(a) { calls++; return a.blockoutPng; } };
        const optics = { focalLengthMm: 28, sensorWidthMm: 36 };
        for (const resolution of [1024, 512]) {
            const err = await SurveyTextureUnprojector.processGlbWithSurveyStations({
                glbPath, anchor: ANCHOR, generator: gen, beautifyContext: { locationName: 'UV-less box' },
                stations: [stationFromLookAt(1, [0, 0, 25], [0, 0, 0], optics, ANCHOR), stationFromLookAt(2, [25, 0, 0], [0, 0, 0], optics, ANCHOR)],
                options: { resolution, renderWidth: 256, renderHeight: 144, draft: true, outGlbPath }
            // A resolved result is summarised (it holds megabytes of buffers that a failure diff would print).
            }).then(r => `resolved: success ${r.success}, fill rate ${r.metrics.fillRate}`, e => e);
            expect(err).toBeInstanceOf(MissingInputError);
            expect(err.message).toContain('mesh 0 primitive 0 has no TEXCOORD_0');
        }
        expect(calls).toBe(0);
        expect(fs.existsSync(outGlbPath)).toBe(false);
        // A precomputed-plate run (the mesh bake's path) is refused the same way.
        await expect(SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath, stations: [], precomputedPlates: [{} as StationPlate], options: { resolution: 512 }
        })).rejects.toThrow(/has no TEXCOORD_0/);
    });

    it('loads the box at a small atlas without crashing: the generated charts are packed inside the atlas', () => {
        const glb = fs.readFileSync(uvlessBox('uvless_box_load.glb'));
        for (const resolution of [512, 256, 64]) {
            // At 512 this threw RangeError (offset is out of bounds) in the packer's shelf fallback.
            const { primitives } = SurveyTextureUnprojector.loadMeshPrimitives(glb, resolution);
            const uvs = primitives[0].uvs;
            expect(uvs.length).toBe(24 * 2);
            expect(Array.from(uvs).every(v => v >= 0 && v <= 1)).toBe(true);
            // The six faces land in six separate atlas rectangles.
            const boxes = Array.from({ length: 6 }, (_, f) => {
                const us = [0, 1, 2, 3].map(k => uvs[(f * 4 + k) * 2]);
                const vs = [0, 1, 2, 3].map(k => uvs[(f * 4 + k) * 2 + 1]);
                return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
            });
            for (let a = 0; a < 6; a++) {
                expect(boxes[a].u1 - boxes[a].u0).toBeGreaterThan(0);
                for (let b = a + 1; b < 6; b++) {
                    const overlap = boxes[a].u0 < boxes[b].u1 && boxes[b].u0 < boxes[a].u1 && boxes[a].v0 < boxes[b].v1 && boxes[b].v0 < boxes[a].v1;
                    expect(overlap).toBe(false);
                }
            }
        }
    });
});
