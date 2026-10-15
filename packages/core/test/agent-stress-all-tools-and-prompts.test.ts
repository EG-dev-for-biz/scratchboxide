/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    createDefaultToolRegistry,
    ToolRegistry,
    buildToolDeclarations
} from '../src/node/gemini/tool-registry';
import { DEFAULT_TOOL_DECLARATIONS } from '../src/node/gemini/tools';
import type { ToolContext } from '../src/node/gemini/tools/types';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import { encodePng } from '../src/node/texture-processing';
import { requireAssets, withReason } from './helpers/requirements';

const avatar2785536 = requireAssets(
    ['models/performer_4dgs/demos/2785536/human_4dgs.ply', 'models/performer_4dgs/demos/2785536/motion.json'],
    'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
);

/** Writes a minimal textured binary glTF 2.0 (one UV-mapped quad with an embedded PNG baseColorTexture). */
function writeTexturedQuadGlb(filePath: string): void {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const W = 8, H = 8;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([200, 180 - (i % 7) * 10, 150, 255], i * 4);
    const png = encodePng(W, H, rgba);
    const pad4 = (n: number) => (n + 3) & ~3;
    const chunks = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer), png];
    const views: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
    let offset = 0;
    for (const c of chunks) {
        views.push({ buffer: 0, byteOffset: offset, byteLength: c.length });
        offset = pad4(offset + c.length);
    }
    const bin = Buffer.alloc(offset);
    chunks.forEach((c, i) => c.copy(bin, views[i].byteOffset));
    const json = {
        asset: { version: '2.0', generator: 'agent-stress-all-tools-and-prompts.test' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        materials: [{ name: 'Stone', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.8, metallicFactor: 0 } }],
        textures: [{ source: 0 }],
        images: [{ bufferView: 3, mimeType: 'image/png' }],
        buffers: [{ byteLength: bin.length }],
        bufferViews: views,
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }
        ]
    };
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf-8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const chunkHeader = (len: number, type: number) => {
        const b = Buffer.alloc(8);
        b.writeUInt32LE(len, 0);
        b.writeUInt32LE(type, 4);
        return b;
    };
    fs.writeFileSync(filePath, Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(bin.length, 0x004e4942), bin]));
}

describe('Master Agent Tool Registry & Multi-Scenario Stress Test Suite', () => {
    let registry: ToolRegistry;
    let mockContext: ToolContext;
    // Agent workspace for the tool calls; kept out of the repo (packages/ is tracked).
    const testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-agent-tools-')));
    // Any textured GLB exercises the UV rewrap tool; a generated quad replaces the gitignored Colosseum test GLB.
    const existingGlbPath = path.join(testDir, 'textured_quad.glb');

    beforeAll(() => {
        writeTexturedQuadGlb(existingGlbPath);

        registry = createDefaultToolRegistry();

        mockContext = {
            request: {
                prompt: 'Master Agent Interaction & Tool Stress Test',
                enableWorkspaceTools: true,
                enableBrowserTools: true,
                enableLensTools: true
            },
            workspaceRoot: testDir,
            sandbox: {
                execute: async (cmd: string) => ({ exitCode: 0, stdout: `Executed: ${cmd}`, stderr: '' }),
                readFile: async (p: string) => `Mock content of ${p}`,
                writeFile: async (_p: string, _c: string) => {},
                mkdirp: async (_p: string) => {},
                exists: async (_p: string) => true
            } as any,
            lsp: {
                getDiagnostics: async () => [],
                getDiagnosticsForFile: (_fp: string) => [],
                getSummary: () => ({ totalCount: 0, errorCount: 0, warningCount: 0, infoCount: 0, fileCount: 0, diagnostics: [] })
            } as any,
            contextGraph: {
                findSymbols: async () => [],
                search: async () => [],
                retrieveSymbolGraph: () => ({ matchingSymbols: [], relevanceScores: {} })
            } as any,
            browserProxy: {
                queueAction: async (action: string, args: any) => {
                    if (action === 'evaluate') return { result: 42 };
                    return { status: 200, title: 'Mock Page', url: args?.url || 'http://localhost:3000' };
                },
                getActiveState: () => ({ url: 'http://localhost:3000', title: 'Mock Page', markdown: '# Mock Page Content', elements: [] })
            } as any,
            lens: {
                executeLensProject: async (filePath: string) => ({ success: true, artifactId: 'art-mock-1', filePath, code: 'class Mock {}' }),
                executeLensUnproject: async (artifactId: string) => ({ success: true, artifactId }),
                executeLensListBindings: () => [{ artifactId: 'art-mock-1', filePath: 'src/mock.ts', status: 'synced' }],
                executeLensSync: () => ({ success: true, artifactId: 'art-mock-1', status: 'synced' })
            } as any,
            executeSubagent: async (params: any) => ({
                result: `Completed ${params.taskType}: ${params.prompt}`,
                success: true
            }) as any
        };
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    // =========================================================================
    // Category 1: Comprehensive Registration Audit across All 23 Groups
    // =========================================================================
    describe('1. Tool Registry Declarations & Discovery Audit', () => {
        it('registers all default tool declarations in the central registry', () => {
            const registeredNames = registry.names();
            expect(registeredNames.length).toBeGreaterThanOrEqual(70);

            for (const decl of DEFAULT_TOOL_DECLARATIONS) {
                expect(registeredNames).toContain(decl.name);
            }
        });

        it('dynamically activates function declarations based on prompt intent', () => {
            const promptsAndExpectedTools = [
                {
                    prompt: 'Decompose and rectify photogrammetric 3D tile with UTDRA',
                    expected: ['utdra_probe_tile', 'utdra_decompose_tile']
                },
                {
                    prompt: 'Ingest Google Maps 3D Tiles clay blockout for Colosseum',
                    expected: ['google_3d_tiles_get_clay', 'google_3d_tiles_get_full_texture']
                },
                {
                    prompt: 'Reshape 3D mesh taper and bend deformers',
                    expected: ['mesh_apply_deformers', 'mesh_reshape_via_prompt']
                },
                {
                    prompt: 'Simulate atmospheric lighting and NOAA solar ephemeris',
                    expected: ['atmosphere_calculate_solar_position', 'atmosphere_get_diurnal_profile']
                },
                {
                    prompt: 'Match photographic lighting gaffer rig OpenUSD',
                    expected: ['lighting_estimate_from_photo', 'lighting_configure_gaffer_rig']
                },
                {
                    prompt: 'Calibrate optical camera lens distortion Brown-Conrady',
                    expected: ['optics_configure_lens_distortion', 'optics_export_lens_distortion']
                },
                {
                    prompt: 'Track video points with TAPIR and solve 4DGS rigid clusters',
                    expected: ['tapir_track_video_points', 'build_4dgs_from_video']
                },
                {
                    prompt: 'Build video timeline and audit with visual critic',
                    expected: ['vfx_visual_critic_audit', 'build_beautify_prompt']
                }
            ];

            for (const item of promptsAndExpectedTools) {
                const req: GeminiGenerateRequest = {
                    prompt: item.prompt,
                    enableWorkspaceTools: true
                };
                const toolConfigs = buildToolDeclarations(req, registry);
                expect(toolConfigs).toBeDefined();

                const fnConfig = toolConfigs!.find(c => 'functionDeclarations' in c) as any;
                expect(fnConfig).toBeDefined();

                const names = fnConfig.functionDeclarations.map((d: any) => d.name);
                for (const expectedName of item.expected) {
                    expect(names).toContain(expectedName);
                }
            }
        });
    });

    // =========================================================================
    // Category 2: Workspace & AST Tools
    // =========================================================================
    describe('2. Workspace & AST Code Intelligence Tools', () => {
        it('executes workspace_list_directory', async () => {
            const res = await registry.dispatch('workspace_list_directory', { directoryPath: '.' }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect(res.resultPayload).toBeDefined();
        });

        it('executes workspace_write_file and workspace_read_file', async () => {
            const testFilePath = path.join(testDir, 'test_sample.txt');
            const writeRes = await registry.dispatch('workspace_write_file', {
                filePath: testFilePath,
                content: 'Hello Scratchbox IDE Master Agent!'
            }, mockContext);
            expect(writeRes.exec.status).toBe('completed');

            const readRes = await registry.dispatch('workspace_read_file', { filePath: testFilePath }, mockContext);
            expect(readRes.exec.status).toBe('completed');
            expect((readRes.resultPayload as any).content).toContain('Hello Scratchbox IDE Master Agent!');
        });

        it('executes workspace_view_file with slice notation', async () => {
            const testFilePath = path.join(testDir, 'test_slice.txt');
            fs.writeFileSync(testFilePath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n', 'utf8');

            const res = await registry.dispatch('workspace_view_file', {
                filePath: testFilePath,
                startLine: 2,
                endLine: 4
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).content).toContain('Line 2');
        });

        it('executes workspace_get_diagnostics', async () => {
            const res = await registry.dispatch('workspace_get_diagnostics', {}, mockContext);
            expect(res.exec.status).toBe('completed');
            expect(Array.isArray((res.resultPayload as any).diagnostics)).toBe(true);
        });
    });

    // =========================================================================
    // Category 3: Canvas Primitives & Interactive Generative UI Cards
    // =========================================================================
    describe('3. Canvas Primitives & Generative UI Tools', () => {
        it('executes mount_canvas_primitive for 3d-scene', async () => {
            const res = await registry.dispatch('mount_canvas_primitive', {
                primitiveType: '3d-scene',
                title: 'Urban Colosseum Metrology Stage',
                payload: {
                    camera: { position: [10, 15, 20], target: [0, 0, 0] },
                    environment: { ephemeris: { solarElevationDeg: 42.5 } }
                }
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).status).toBe('success');
            expect((res.resultPayload as any).artifactId).toBeDefined();
        });

        it('executes ask_user_question with interactive choices', async () => {
            const res = await registry.dispatch('ask_user_question', {
                title: 'LOD Mesh Quality Selection',
                questions: [
                    {
                        id: 'lod-tier',
                        prompt: 'Which LOD mesh quality tier do you wish to stream?',
                        options: [
                            { id: 'leaf', label: 'Deepest Leaf LOD (errorTarget <= 0.5, 4K SSE)' },
                            { id: 'med', label: 'Balanced Medium LOD (errorTarget = 1.0)' },
                            { id: 'coarse', label: 'Coarse Volumetric Massing' }
                        ]
                    }
                ]
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).questionCard).toBeDefined();
            expect((res.resultPayload as any).questionCard.title).toContain('LOD Mesh Quality');
        });

        it('executes present_execution_plan with milestone phases', async () => {
            const res = await registry.dispatch('present_execution_plan', {
                title: 'High-Fidelity 3D Tiles & 4DGS Reconstruction Plan',
                goal: 'Reconstruct high-fidelity 4D Gaussian Splat with real-world 3D tiles and UTDRA metrology',
                steps: [
                    { id: 's1', title: 'Ingest leaf LOD photogrammetric tiles via headless blockout runner' },
                    { id: 's2', title: 'Apply UTDRA elevation slicing & architectural crown preservation' },
                    { id: 's3', title: 'Calibrate diurnal solar lighting & Rayleigh sky scattering' },
                    { id: 's4', title: 'Reconstruct 4D performer Gaussians via Wan2.2-TI2V-5B backbone' }
                ]
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).executionPlanCard).toBeDefined();
            expect((res.resultPayload as any).executionPlanCard.steps.length).toBe(4);
        });
    });

    // =========================================================================
    // Category 4: Real-World Google 3D Tiles & UTDRA Metrology
    // =========================================================================
    describe('4. Google 3D Tiles & UTDRA Decomposition Tools', () => {
        it('executes utdra_probe_tile across geometric benchmarks', async () => {
            const res = await registry.dispatch('utdra_probe_tile', {
                benchmark: 'urban',
                samplePointCount: 1500
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).telemetry.dominantDomain).toBeDefined();
        });

        it('executes utdra_decompose_tile with non-destructive classification', async () => {
            const res = await registry.dispatch('utdra_decompose_tile', {
                benchmark: 'hybrid'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).mode).toBe('full');
            expect((res.resultPayload as any).telemetry.inputTriangles).toBeGreaterThan(0);
        });

        it('executes utdra_slice_elevation with Sutherland-Hodgman clipping', async () => {
            const res = await registry.dispatch('utdra_slice_elevation', {
                cutoffY: 5.0,
                benchmark: 'slicer'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).telemetry.outputTriangles).toBeDefined();
        });

        it('executes utdra_carve_bridge_voids', async () => {
            const res = await registry.dispatch('utdra_carve_bridge_voids', {
                minVoidHeightMeters: 3.5,
                benchmark: 'bridge'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
        });

        it('executes google_3d_tiles_clay_blockout_runner dry run', async () => {
            const res = await registry.dispatch('google_3d_tiles_clay_blockout_runner', {
                query: '41.890210, 12.492231',
                trajectoryPreset: 'cinematic_arc',
                mockExecution: true, // ignored: the model cannot switch the runner to placeholder output
                // The mock tile GLB defaults to public/models; keep it in the test workspace
                outputGlbPath: path.join(testDir, 'clay_blockout.glb')
            }, mockContext);
            // No Maps key here: the real runner fails (it cannot measure the ground) instead of a placeholder video.
            expect(res.exec.status).toBe('failed');
            expect(String((res.resultPayload as any).error)).toMatch(/Maps API key|elevation/);
        });
    });

    // =========================================================================
    // Category 5: Native C++20 Astro Engine Mesh Shaping
    // =========================================================================
    describe('5. Native C++20 Astro Engine Mesh Shaping Tools', () => {
        it('executes mesh_apply_deformers (taper, twist, bend, bulge)', async () => {
            const res = await registry.dispatch('mesh_apply_deformers', {
                operations: [
                    { type: 'taper', axis: 'y', factor: 0.65 },
                    { type: 'twist', axis: 'y', factor: 0.5 }
                ],
                benchmark: 'cylinder'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).telemetry.outputVertices).toBeGreaterThan(0);
        });

        it('executes mesh_reshape_via_prompt with parametric synthesis', async () => {
            const res = await registry.dispatch('mesh_reshape_via_prompt', {
                prompt: 'taper the top of the cylinder by 35% and twist 20 degrees',
                benchmark: 'cylinder'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).telemetry.outputVertices).toBeGreaterThan(0);
        });

        it('executes tile_restructure_via_prompt for architectural terraforming', async () => {
            const res = await registry.dispatch('tile_restructure_via_prompt', {
                prompt: 'flatten ground foundation and preserve upper architectural crown',
                benchmark: 'hillside_monument'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
        });

        it('executes tile_apply_terraforming_and_primitives with foundational leveling', async () => {
            const res = await registry.dispatch('tile_apply_terraforming_and_primitives', {
                terraforming: [
                    { type: 'plateau_level', targetElevation: 0.0, radius: 25.0 }
                ],
                benchmark: 'city_district'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
        });
    });

    // =========================================================================
    // Category 6: Atmospheric Scattering, Diurnal Lighting & Photometrics
    // =========================================================================
    describe('6. Atmospheric Scattering & Photometric Lighting Tools', () => {
        it('executes atmosphere_calculate_solar_position with NOAA ephemeris', async () => {
            const res = await registry.dispatch('atmosphere_calculate_solar_position', {
                latitude: 41.890210,
                longitude: 12.492231,
                isoDate: '2026-06-21T12:00:00Z'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            const data = res.resultPayload as any;
            expect(data.elevationDeg).toBeGreaterThan(0);
            expect(data.azimuthDeg).toBeDefined();
        });

        it('executes atmosphere_get_diurnal_profile with physical turbidity', async () => {
            const res = await registry.dispatch('atmosphere_get_diurnal_profile', {
                elevationDeg: 35.0,
                turbidity: 2.5
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).kelvinTemperature).toBeDefined();
            expect((res.resultPayload as any).phase).toBeDefined();
        });

        it('executes lighting_configure_gaffer_rig for classical cinematic styles', async () => {
            const res = await registry.dispatch('lighting_configure_gaffer_rig', {
                style: 'rembrandt'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).rigId).toBeDefined();
            expect((res.resultPayload as any).lights.length).toBeGreaterThan(0);
        });

        it('executes lighting_export_usd to standard UsdLux and MaterialX schemas', async () => {
            const usdPath = path.join(testDir, 'test_cinematic_rig.usda');
            const res = await registry.dispatch('lighting_export_usd', {
                style: 'noir',
                outputPath: usdPath
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).usdaFilePath).toBeDefined();
        });
    });

    // =========================================================================
    // Category 7: Optical Camera Calibration & Brown-Conrady Undistortion
    // =========================================================================
    describe('7. Optical Camera Calibration & Brown-Conrady Tools', () => {
        it('executes optics_configure_lens_distortion with radial & tangential coefficients', async () => {
            const res = await registry.dispatch('optics_configure_lens_distortion', {
                focalLengthMm: 35.0,
                presetId: 'cooke_s4_wide_18mm'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).overscanMargin).toBeDefined();
            expect((res.resultPayload as any).config).toBeDefined();
        });

        it('executes optics_export_lens_distortion for VFX camera handoff', async () => {
            const res = await registry.dispatch('optics_export_lens_distortion', {
                format: 'all',
                presetId: 'cooke_s4_wide_18mm'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).threeDEqualizerLensFile).toBeDefined();
            expect((res.resultPayload as any).nukeScript).toBeDefined();
        });

        it('executes configure_physical_camera with photographic sensor & FOV calculations', async () => {
            const res = await registry.dispatch('configure_physical_camera', {
                focalLengthMm: 50,
                apertureFStop: 2.8,
                focusDistanceMeters: 5.0,
                sensorFormat: 'full_frame_35mm'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).frustum.horizontalFovDeg).toBeGreaterThan(35);
            expect((res.resultPayload as any).depthOfField).toBeDefined();
        });
    });

    // =========================================================================
    // Category 8: Algorithmic UV Rewrap & Tactile Micro-Detail Synthesis
    // =========================================================================
    describe('8. Algorithmic UV Rewrap & Texture Synthesis Tools', () => {
        it('executes algorithmic_uv_unwrap_rewrap with 100% geometric spatial lock', async () => {
            const res = await registry.dispatch('algorithmic_uv_unwrap_rewrap', {
                inputGlbPath: existingGlbPath,
                mode: 'preserve-100-lock'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
        });

        it('executes atlas_maxrects_pack for high-density chart binning', async () => {
            const res = await registry.dispatch('atlas_maxrects_pack', {
                rectangles: [
                    { id: 'c1', width: 128, height: 128 },
                    { id: 'c2', width: 64, height: 64 },
                    { id: 'c3', width: 256, height: 128 }
                ]
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).fillRate).toBeGreaterThan(0.5);
        });

        it('executes nano_banana_extract_color_palette & nano_banana_apply_color_palette', async () => {
            const extractRes = await registry.dispatch('nano_banana_extract_color_palette', {
                referenceImageUrl: '/workspace/input_photo.png',
                focusArea: 'global'
            }, mockContext);
            expect(extractRes.exec.status).toBe('completed');
            const palette = (extractRes.resultPayload as any).palette;
            expect(palette).toBeDefined();
            expect(palette.primaryTones.length).toBeGreaterThan(0);

            const applyRes = await registry.dispatch('nano_banana_apply_color_palette', {
                palette,
                targetImageUrl: '/workspace/target.png'
            }, mockContext);
            expect(applyRes.exec.status).toBe('completed');
            expect((applyRes.resultPayload as any).success).toBe(true);
        });
    });

    // =========================================================================
    // Category 9: VFX Video Editing, Compositor & Director Tools
    // =========================================================================
    describe('9. VFX Video Editing, Compositor & Director Tools', () => {
        it('executes build_beautify_prompt enforcing 3D camera spatial lock', async () => {
            const res = await registry.dispatch('build_beautify_prompt', {
                locationName: 'Arch of Constantine, Rome',
                coords: '41.889764, 12.490710',
                heading: 145.5,
                aspectRatio: '16:9',
                moodPromptContext: 'warm late-afternoon golden hour sunlight'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            const prompt = (res.resultPayload as any).prompt;
            expect(prompt).toContain('Arch of Constantine, Rome');
            expect(prompt).toContain('41.889764, 12.490710');
            expect(prompt).toContain('16:9');
            expect(prompt).toContain('Preserve the EXACT same camera angle');
        });

        it('executes build_neutral_performer_prompt with strict studio invariants', async () => {
            const res = await registry.dispatch('build_neutral_performer_prompt', {
                subject: 'Contemporary dancer in athletic sportswear',
                aspectRatio: '9:16',
                isAFramePose: true
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).aspectRatio).toBe('9:16');
            const prompt = (res.resultPayload as any).prompt;
            expect(prompt).toContain('neutral grey studio backdrop');
            expect(prompt).toContain('symmetrical A-frame pose');
        });

        it('executes build_frame_motivated_performer_prompt with <FIRST_FRAME> motivation', async () => {
            const res = await registry.dispatch('build_frame_motivated_performer_prompt', {
                referenceFrameRef: '<IMAGE_REF_0>',
                cameraPosition: 'front',
                heroPoseType: 'a-pose',
                actionPrompt: 'subtle rhythmic swaying with natural breathing',
                videoDiffusionModel: 'Wan2.2-TI2V-5B'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            const prompt = (res.resultPayload as any).prompt;
            expect(prompt).toContain('<FIRST_FRAME><IMAGE_REF_0></FIRST_FRAME>');
            expect(prompt).toContain('Wan2.2-TI2V-5B');
        });

        it('executes vfx_ffmpeg_quick_edit in dryRun mode', async () => {
            const res = await registry.dispatch('vfx_ffmpeg_quick_edit', {
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output.mp4',
                startSec: 2.0,
                durationSec: 4.5,
                colorTemperatureKelvin: 6500,
                dryRun: true
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).commandString).toContain('-ss 2');
        });

        it('executes vfx_visual_critic_audit on video output', async () => {
            const res = await registry.dispatch('vfx_visual_critic_audit', {
                videoPath: '/workspace/rendered_scene.mp4',
                promptContext: 'Photorealistic Colosseum architectural orbit',
                minPassingScore: 8.5,
                dryRun: true
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).overallScore).toBeGreaterThanOrEqual(8.0);
        });
    });

    // =========================================================================
    // Category 10: 4D Dynamic Gaussian Splats & TAPIR Point Tracking
    // =========================================================================
    describe('10. 4DGS Tracking & Dynamic Avatar Tools', () => {
        it('executes tapir_track_video_points with sub-pixel optical flow', async () => {
            const res = await registry.dispatch('tapir_track_video_points', {
                samplerType: 'hybrid',
                maxPoints: 128,
                numFrames: 24,
                backend: 'mock'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).numPoints).toBe(128);
            expect((res.resultPayload as any).backendUsed).toBe('mock');
        });

        it('executes build_4dgs_from_video with ARAP local rigidity graph', async () => {
            const res = await registry.dispatch('build_4dgs_from_video', {
                canonicalSubject: [
                    { position: [0, 0, 0], colorRgb: [1, 0, 0], scale: [0.01, 0.01, 0.01], opacity: 1.0 }
                ],
                numFrames: 12,
                trackingBackend: 'mock'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).telemetry).toBeDefined();
        });

        it.skipIf(!avatar2785536.ok)(withReason('executes avatar_4dgs_list and avatar_4dgs_get', avatar2785536), async () => {
            const listRes = await registry.dispatch('avatar_4dgs_list', {}, mockContext);
            expect(listRes.exec.status).toBe('completed');
            expect((listRes.resultPayload as any).totalAvatars).toBeGreaterThanOrEqual(1);

            const getRes = await registry.dispatch('avatar_4dgs_get', { avatarId: '2785536' }, mockContext);
            expect(getRes.exec.status).toBe('completed');
            expect((getRes.resultPayload as any).details).toBeDefined();
        });

        it.skipIf(!avatar2785536.ok)(withReason('executes avatar_4dgs_animate with deformation telemetry', avatar2785536), async () => {
            const res = await registry.dispatch('avatar_4dgs_animate', {
                avatarId: '2785536',
                frameIndex: 0,
                exportSplat: true
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).numSplats).toBeGreaterThan(0);
            expect((res.resultPayload as any).splatByteLength).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // Category 12: Botanical Trees & Stand Generation
    // =========================================================================
    describe('12. Botanical Trees & Biological Stand Tools', () => {
        it('executes botanical_query_separator_trees with architectural clearances', async () => {
            const res = await registry.dispatch('botanical_query_separator_trees', {
                zone: 'oppian_hill_crest'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect(Array.isArray((res.resultPayload as any).trees)).toBe(true);
        });

        it('executes botanical_synthesize_tree with 70-20-10 anatomical branching', async () => {
            const res = await registry.dispatch('botanical_synthesize_tree', {
                species: 'pinus_pinea',
                canopyHeightMeters: 14.2,
                crownDiameterMeters: 11.5
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).success).toBe(true);
            expect((res.resultPayload as any).fittedHeightMeters).toBeGreaterThan(10);
        });
    });

    // =========================================================================
    // Category 13: Browser Automation & Web MCP Proxy
    // =========================================================================
    describe('13. Browser Automation & Proxy Tools', () => {
        it('executes browser_navigate and returns page metadata', async () => {
            const res = await registry.dispatch('browser_navigate', {
                url: 'http://localhost:3000/demo/viewport'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).data.status).toBe(200);
        });

        it('executes browser_snapshot', async () => {
            const res = await registry.dispatch('browser_snapshot', {}, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).data.url).toBe('http://localhost:3000');
        });

        it('executes browser_evaluate to inspect clientside DOM or canvas', async () => {
            const res = await registry.dispatch('browser_evaluate', {
                expression: 'document.querySelectorAll("canvas").length'
            }, mockContext);
            expect(res.exec.status).toBe('completed');
            expect((res.resultPayload as any).data.result).toBe(42);
        });
    });

    // =========================================================================
    // Category 14: Subagent Orchestration & Codebase Lens
    // =========================================================================
    describe('14. Subagent Orchestration & Codebase Lens Bridge', () => {
        it('executes lens_project and lens_sync', async () => {
            const projRes = await registry.dispatch('lens_project', {
                filePath: 'src/math.ts'
            }, mockContext);
            expect(projRes.exec.status).toBe('completed');

            const syncRes = await registry.dispatch('lens_sync', {
                artifactId: 'art-mock-1',
                direction: 'in'
            }, mockContext);
            expect(syncRes.exec.status).toBe('completed');
        });

        it('invoke_subagent fails plainly when no subagent runner is available', async () => {
            const res = await registry.dispatch('invoke_subagent', {
                role: 'Codebase Researcher',
                prompt: 'Audit C++20 Astro Engine SIMD vector math performance'
            }, { ...mockContext, runSubagent: undefined });
            expect(res.exec.status).toBe('failed');
            expect(String((res.resultPayload as any).error)).toContain('nothing was delegated');
        });
    });
});
