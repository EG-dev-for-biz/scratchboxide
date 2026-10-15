/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import * as assert from 'assert';
import { CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';
import { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { NativeAiRenderEngineService } from '../src/node/spatial/NativeAiRenderEngineService';
import { SpatialSmartPointInpaintService } from '../src/node/spatial/SpatialSmartPointInpaintService';
import { MeshAiTextureBakingService } from '../src/node/spatial/MeshAiTextureBakingService';
import { SceneKeyframeVideoService } from '../src/node/spatial/SceneKeyframeVideoService';

// Create a simple test mesh (a triangle)
const testMesh: RenderMesh3D = {
    vertices: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0
    ]),
    indices: new Uint32Array([
        0, 1, 2
    ])
};

const testPose: CameraPose6DOF = {
    x: 0,
    y: 0,
    z: 5,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    up: [0, 1, 0],
    fov: 60
};

describe('Native 3D Engine AI Render & Keyframing Suite', () => {
    describe('1. NativeAiRenderEngineService', () => {
        it('can extract render passes (clay, depth, mist, normal)', () => {
            const service = new NativeAiRenderEngineService();
            const passes = service.extractRenderPasses(testMesh, testPose, 64, 48);

            expect(passes.width).toBe(64);
            expect(passes.height).toBe(48);
            expect(passes.clay).toBeInstanceOf(Buffer);
            expect(passes.clay.length).toBeGreaterThan(0);
            expect(passes.depth).toBeInstanceOf(Float32Array);
            expect(passes.depth.length).toBe(64 * 48);
            expect(passes.mist).toBeInstanceOf(Buffer); // Mist is encoded grayscale image
            expect(passes.mist.length).toBeGreaterThan(0);
            expect(passes.normal).toBeInstanceOf(Buffer); // Normal shaded pass
            expect(passes.normal.length).toBeGreaterThan(0);
        });

        it('can synthesize an AI beauty frame using a mock generator', async () => {
            const mockGenerator = {
                name: 'mock-beautify',
                generate: vi.fn(async () => Buffer.from('beauty-frame-data'))
            };
            const service = new NativeAiRenderEngineService({ generator: mockGenerator });
            const result = await service.renderAiBeautyFrame({
                mesh: testMesh,
                pose: testPose,
                prompt: 'Golden hour stone temple',
                width: 64,
                height: 48
            });

            expect(result.image).toEqual(Buffer.from('beauty-frame-data'));
            expect(result.width).toBe(64);
            expect(result.height).toBe(48);
            expect(mockGenerator.generate).toHaveBeenCalled();
        });
    });

    describe('1b. spatial_ai_render_scene tool', () => {
        it('writes the frame into the workspace it was called for, not the server\'s working directory', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const { writeFixtureGlb, skyscraperMesh } = await import('./helpers/mesh-glb-fixtures');
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-ai-render-ws-'));
            // The image model is a fake client (no real call); the tool has no stand-in generator of its own.
            const { GoogleMediaCredentialsService } = await import('../src/node/google-media-credentials-service');
            const { fakeImageModelClient } = await import('./helpers/fake-image-model');
            const spy = vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(fakeImageModelClient([], { modelVersion: 'gemini-3.1-flash-image' }) as any);
            try {
                const glbPath = writeFixtureGlb(path.join(workspaceRoot, 'tower.glb'), skyscraperMesh(10, 15, 20));
                const res = await spatialHandlers.spatial_ai_render_scene({
                    glbPath, prompt: 'dusk', width: 96, height: 72,
                    pose: { x: 0, y: 10, z: -40, targetX: 0, targetY: 10, targetZ: 0, fov: 45 }
                }, { workspaceRoot } as any);
                const payload = res.resultPayload as any;
                expect(payload.imagePath.startsWith(path.join(workspaceRoot, 'public', 'models'))).toBe(true);
                expect(fs.existsSync(payload.imagePath)).toBe(true);
                expect(payload.imageUrl).toBe(`/models/${path.basename(payload.imagePath)}`);
                expect(payload.modelUsed).toBe('gemini-3.1-flash-image');
                expect(res.summaryResult).toContain('gemini-3.1-flash-image');
            } finally {
                spy.mockRestore();
                fs.rmSync(workspaceRoot, { recursive: true, force: true });
            }
        });
    });

    describe('2. SpatialSmartPointInpaintService', () => {
        it('can project a 3D smart point to screen coordinate and construct a mask', () => {
            const service = new SpatialSmartPointInpaintService();
            // Point (0, 0, 0) should project to the center of the viewport
            const result = service.projectSmartPointToMask(testMesh, testPose, [0, 0, 0], 10, 100, 100);

            expect(result.x).toBeCloseTo(50, 0);
            expect(result.y).toBeCloseTo(50, 0);
            expect(result.mask).toBeInstanceOf(Buffer);
            expect(result.mask.length).toBeGreaterThan(0);
            
            // Center of the mask should be projected to near 50, 50
            expect(result.x).toBeCloseTo(50, 0);
            expect(result.y).toBeCloseTo(50, 0);
        });

        it('inpaints at the image\'s own aspect ratio, keeps pixels outside the mask, names the model, and refuses a re-framed answer', async () => {
            const { encodePng, decodePng } = await import('../src/node/texture-processing');
            const { ModelAnswerResolutionError } = await import('../src/node/spatial/Google360PanoramaPipelineService');
            const { fakeImageModelClient } = await import('./helpers/fake-image-model');
            const W = 80, H = 60; // 4:3
            const base = Buffer.alloc(W * H * 4);
            for (let i = 0; i < W * H; i++) { base[i * 4] = 40; base[i * 4 + 1] = 120; base[i * 4 + 2] = 200; base[i * 4 + 3] = 255; }
            const service = new SpatialSmartPointInpaintService();
            const mask = service.projectSmartPointToMask(testMesh, testPose, [0, 0, 0], 10, W, H).mask;

            const calls: Array<{ model: string; aspectRatio?: string }> = [];
            // The fake model answers at 160x120 (same 4:3 ratio, twice the size) in flat red.
            const client = fakeImageModelClient(calls, { flat: [255, 0, 0], flatSize: [160, 120], modelVersion: 'gemini-3.1-flash-image' });
            const result = await new SpatialSmartPointInpaintService({ client }).executeSpatialInpaint({
                image: encodePng(W, H, base), mask, prompt: 'Add an ivy climber here'
            });
            expect(calls[0].aspectRatio).toBe('4:3');
            expect(result.modelUsed).toBe('gemini-3.1-flash-image');
            expect(result.modelNote).toContain('gemini-3.1-flash-image');
            const out = decodePng(result.image);
            expect([out.width, out.height]).toEqual([W, H]);
            const centre = (Math.round(H / 2) * W + Math.round(W / 2)) * 4;
            expect(out.rgba[centre]).toBe(255);
            expect(Array.from(out.rgba.subarray(0, 3))).toEqual([40, 120, 200]); // corner, outside the mask

            // A 16:9 answer to a 4:3 request would put the edit in the wrong place: refused, not stretched.
            const wide = fakeImageModelClient([], { flat: [255, 0, 0], flatSize: [160, 90] });
            await expect(new SpatialSmartPointInpaintService({ client: wide }).executeSpatialInpaint({ image: encodePng(W, H, base), mask, prompt: 'x' }))
                .rejects.toBeInstanceOf(ModelAnswerResolutionError);
        });
    });

    describe('3. MeshAiTextureBakingService', () => {
        it('can generate a 6-camera orthogonal rig around a mesh', () => {
            const service = new MeshAiTextureBakingService();
            const rig = service.generateOrthogonalCameraRig(testMesh);

            expect(rig).toHaveLength(6);
            expect(rig[0].name).toBe('Front');
            expect(rig[1].name).toBe('Back');
            expect(rig[2].name).toBe('Left');
            expect(rig[3].name).toBe('Right');
            expect(rig[4].name).toBe('Top');
            expect(rig[5].name).toBe('Bottom');

            // All poses should look towards the mesh center (0.5, 0.5, 0)
            for (const camera of rig) {
                expect(camera.pose.targetX).toBeCloseTo(0.5, 1);
                expect(camera.pose.targetY).toBeCloseTo(0.5, 1);
                expect(camera.pose.targetZ).toBeCloseTo(0, 1);
            }
        });

        it('bakes the six restyled views onto the mesh UVs and writes a textured copy (the input is unchanged)', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const crypto = await import('crypto');
            const { writeFixtureGlb, uvCubeMesh, readGlbJson } = await import('./helpers/mesh-glb-fixtures');
            const { encodePng, decodePng } = await import('../src/node/texture-processing');
            const { AlgorithmicUvEngine } = await import('../src/node/spatial/AlgorithmicUvEngine');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bake-'));
            const glbPath = writeFixtureGlb(path.join(dir, 'cube.glb'), uvCubeMesh(2));
            const before = crypto.createHash('sha1').update(fs.readFileSync(glbPath)).digest('hex');

            // A test generator that "restyles" each view (Front, Back, Left, Right, Top, Bottom, in that order) to its own
            // flat colour at the asked size and names its model, so each face's chart shows which view painted it.
            const colors: Array<[number, number, number]> = [[176, 120, 60], [40, 90, 200], [30, 160, 70], [200, 40, 40], [230, 210, 40], [120, 40, 160]];
            let call = 0;
            const generate = vi.fn(async (a: { width: number; height: number }) => {
                const c = colors[call++];
                const rgba = Buffer.alloc(a.width * a.height * 4);
                for (let i = 0; i < a.width * a.height; i++) { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255; }
                return { png: encodePng(a.width, a.height, rgba), modelUsed: 'gemini-3.1-flash-image' };
            });
            const service = new MeshAiTextureBakingService({ generator: { name: 'test-bronze', generate }, workspaceRoot: dir });
            const outGlbPath = path.join(dir, 'cube_baked.glb');
            const result = await service.bakeMeshTexturesWithAi({ glbPath, stylePrompt: 'weathered bronze', width: 64, height: 64, outGlbPath, resolution: 96 });

            expect(generate).toHaveBeenCalledTimes(6);
            expect(result.views.map(v => v.name)).toEqual(['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom']);
            expect(result.rejectedViews).toEqual([]);
            expect(result.modelsUsed).toEqual(['gemini-3.1-flash-image']);
            expect(fs.existsSync(outGlbPath)).toBe(true);
            expect(crypto.createHash('sha1').update(fs.readFileSync(glbPath)).digest('hex')).toBe(before);

            // The written GLB carries a base colour texture painted from the views: covered texels are bronze.
            const gltf = readGlbJson(outGlbPath);
            const texIndex = gltf.materials[gltf.meshes[0].primitives[0].material].pbrMetallicRoughness.baseColorTexture.index;
            const { json, bin } = AlgorithmicUvEngine.parseGlb(fs.readFileSync(outGlbPath));
            const view = json.bufferViews[json.images[json.textures[texIndex].source].bufferView];
            const atlas = decodePng(bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
            // Each face's chart (a cell of the 3 x 2 UV grid) carries the colour of the view that faces it.
            const chartColor = (cell: number) => {
                const x = Math.round(((cell % 3) + 0.5) / 3 * (atlas.width - 1)), y = Math.round((Math.floor(cell / 3) + 0.5) / 2 * (atlas.height - 1));
                return Array.from(atlas.rgba.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 3));
            };
            expect(chartColor(0)).toEqual(colors[0]); // +Z face, Front view
            expect(chartColor(3)).toEqual(colors[3]); // +X face, Right view
            expect(chartColor(4)).toEqual(colors[4]); // +Y face, Top view
            expect(result.metrics.coveredMeshTexels).toBeGreaterThan(0);
            expect(result.unobservedTexels).toBeLessThan(result.metrics.coveredMeshTexels * 0.05);
            const shots = path.resolve(__dirname, '../../../test-results/screenshots');
            fs.mkdirSync(shots, { recursive: true });
            fs.writeFileSync(path.join(shots, 'mesh_bake_ai_textures_cube_atlas.png'), encodePng(atlas.width, atlas.height, atlas.rgba));
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('bakes a valid GLB with byte indices and normalized-short UVs onto the same triangles it rendered', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const { writeEncodedPrimitivesGlb, uvCubeMesh, readGlbJson } = await import('./helpers/mesh-glb-fixtures');
            const { encodePng, decodePng } = await import('../src/node/texture-processing');
            const { AlgorithmicUvEngine } = await import('../src/node/spatial/AlgorithmicUvEngine');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bake-u8-'));
            // UNSIGNED_BYTE indices first in the buffer and UNSIGNED_SHORT normalized UVs: valid glTF that the
            // unprojector used to read as 32-bit indices (so nothing was painted while the bake reported success).
            const glbPath = writeEncodedPrimitivesGlb(path.join(dir, 'cube_u8.glb'), [{ mesh: uvCubeMesh(2), indexType: 5121, uvEncoding: 'unorm16' }]);
            const colors: Array<[number, number, number]> = [[176, 120, 60], [40, 90, 200], [30, 160, 70], [200, 40, 40], [230, 210, 40], [120, 40, 160]];
            let call = 0;
            const generate = vi.fn(async (a: { width: number; height: number }) => {
                const c = colors[call++];
                const rgba = Buffer.alloc(a.width * a.height * 4);
                for (let i = 0; i < a.width * a.height; i++) { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255; }
                return { png: encodePng(a.width, a.height, rgba), modelUsed: 'gemini-3.1-flash-image' };
            });
            const service = new MeshAiTextureBakingService({ generator: { name: 'test-colours', generate }, workspaceRoot: dir });
            const outGlbPath = path.join(dir, 'cube_u8_baked.glb');
            const result = await service.bakeMeshTexturesWithAi({ glbPath, stylePrompt: 'glazed tile', width: 64, height: 64, outGlbPath, resolution: 96 });
            expect(result.metrics.directlyPaintedTexels).toBeGreaterThan(0);
            expect(result.unobservedTexels).toBeLessThan(result.metrics.coveredMeshTexels * 0.05);
            const gltf = readGlbJson(outGlbPath);
            const texIndex = gltf.materials[gltf.meshes[0].primitives[0].material].pbrMetallicRoughness.baseColorTexture.index;
            const { json, bin } = AlgorithmicUvEngine.parseGlb(fs.readFileSync(outGlbPath));
            const view = json.bufferViews[json.images[json.textures[texIndex].source].bufferView];
            const atlas = decodePng(bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
            const chartColor = (cell: number) => {
                const x = Math.round(((cell % 3) + 0.5) / 3 * (atlas.width - 1)), y = Math.round((Math.floor(cell / 3) + 0.5) / 2 * (atlas.height - 1));
                return Array.from(atlas.rgba.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 3));
            };
            expect(chartColor(0)).toEqual(colors[0]); // +Z face, Front view
            expect(chartColor(3)).toEqual(colors[3]); // +X face, Right view
            const shots = path.resolve(__dirname, '../../../test-results/screenshots');
            fs.mkdirSync(shots, { recursive: true });
            fs.writeFileSync(path.join(shots, 'mesh_bake_ai_textures_u8_index_atlas.png'), encodePng(atlas.width, atlas.height, atlas.rgba));
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('fails, writing nothing, when a primitive is hidden from every view, and refuses UVs it cannot decode before any model call', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const { writeEncodedPrimitivesGlb, uvCubeMesh } = await import('./helpers/mesh-glb-fixtures');
            const { encodePng } = await import('../src/node/texture-processing');
            const { GeneratorFailedError, MissingInputError } = await import('../src/common/errors/pipeline-errors');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bake-hidden-'));
            const flat = vi.fn(async (a: { width: number; height: number }) => {
                const rgba = Buffer.alloc(a.width * a.height * 4, 200);
                return { png: encodePng(a.width, a.height, rgba), modelUsed: 'gemini-3.1-flash-image' };
            });
            // A small cube sealed inside a larger one: no axis view sees it, so its texture cannot be painted.
            const nested = writeEncodedPrimitivesGlb(path.join(dir, 'nested.glb'), [{ mesh: uvCubeMesh(2) }, { mesh: uvCubeMesh(0.5) }]);
            const outGlbPath = path.join(dir, 'nested_baked.glb');
            const service = new MeshAiTextureBakingService({ generator: { name: 'flat', generate: flat }, workspaceRoot: dir });
            const error = await service.bakeMeshTexturesWithAi({ glbPath: nested, stylePrompt: 'bronze', width: 64, height: 64, outGlbPath, resolution: 64 }).catch(e => e);
            expect(error).toBeInstanceOf(GeneratorFailedError);
            expect(error.message).toContain('1 of 2 primitives');
            expect(error.message).toContain('primitive 1 (hidden from every view)');
            expect(fs.existsSync(outGlbPath)).toBe(false);

            // Integer UVs that are not normalized are not texture coordinates this reader can place: refused up front.
            const rawUv = writeEncodedPrimitivesGlb(path.join(dir, 'raw_uv.glb'), [{ mesh: uvCubeMesh(2), uvEncoding: 'uint16' }]);
            const never = vi.fn();
            const refused = await new MeshAiTextureBakingService({ generator: { name: 'never', generate: never }, workspaceRoot: dir })
                .bakeMeshTexturesWithAi({ glbPath: rawUv, stylePrompt: 'bronze', outGlbPath: path.join(dir, 'raw_out.glb') }).catch(e => e);
            expect(refused).toBeInstanceOf(MissingInputError);
            expect(refused.message).toContain('TEXCOORD_0 uses component type 5123');
            expect(never).not.toHaveBeenCalled();
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('refuses a mesh with no UVs instead of reporting views it never projected', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const { writeFixtureGlb, cylinderMesh } = await import('./helpers/mesh-glb-fixtures');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bake-nouv-'));
            const glbPath = writeFixtureGlb(path.join(dir, 'cyl.glb'), cylinderMesh());
            const generate = vi.fn();
            const service = new MeshAiTextureBakingService({ generator: { name: 'never', generate }, workspaceRoot: dir });
            await expect(service.bakeMeshTexturesWithAi({ glbPath, stylePrompt: 'bronze', outGlbPath: path.join(dir, 'out.glb') }))
                .rejects.toThrow(/has no TEXCOORD_0; a texture needs UVs/);
            expect(generate).not.toHaveBeenCalled();
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });

    describe('4. SceneKeyframeVideoService', () => {
        it('can capture a keyframe pair', () => {
            const service = new SceneKeyframeVideoService();
            const startPose = testPose;
            const endPose = { ...testPose, x: 2, y: 1 };
            const pair = service.captureKeyframePair(testMesh, startPose, endPose, 64, 48);

            expect(pair.start.clay).toBeInstanceOf(Buffer);
            expect(pair.end.clay).toBeInstanceOf(Buffer);
        });

        it('can plan and synthesize keyframe interpolation video using a mock client', async () => {
            // The Interactions API answer shape the service parses: model_output steps with a video part.
            const mockClient = {
                interactions: {
                    create: vi.fn(async () => ({
                        steps: [{
                            type: 'model_output',
                            content: [{ type: 'video', mime_type: 'video/mp4', data: Buffer.from('interpolated-video-bytes').toString('base64') }]
                        }]
                    }))
                }
            } as any;
            // Keyframe stills come from an injected image generator (the default one calls the image model).
            const generator = { name: 'keyframe-test', generate: vi.fn(async () => ({ png: Buffer.from('still'), modelUsed: 'gemini-3.1-flash-image' })) };

            const service = new SceneKeyframeVideoService({ client: mockClient, generator });
            const result = await service.synthesizeKeyframeInterpolationVideo({
                mesh: testMesh,
                startPose: testPose,
                endPose: { ...testPose, x: 2 },
                prompt: 'Camera sweeps around temple',
                width: 64,
                height: 48
            });

            expect(result.video).toEqual(Buffer.from('interpolated-video-bytes'));
            expect(mockClient.interactions.create).toHaveBeenCalled();
            expect(result.videoModel).toBe('gemini-omni-1.1-flash-preview');
            expect(result.imageSources).toEqual(['Generated with gemini-3.1-flash-image.']);
        });
    });
});
