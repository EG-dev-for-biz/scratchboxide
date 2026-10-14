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
import type { ToolContext } from '../src/node/gemini/tools/types';
import { requireAssets, withReason } from './helpers/requirements';

const avatar2785536 = requireAssets(
    ['models/performer_4dgs/demos/2785536/human_4dgs.ply', 'models/performer_4dgs/demos/2785536/motion.json'],
    'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
);

describe('Agent Multi-Turn Interactive User Journeys & End-to-End Stress Test', () => {
    let registry: ToolRegistry;
    let mockContext: ToolContext;
    // Agent workspace for the journeys; kept out of the repo (packages/ is tracked).
    const testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-agent-journeys-')));
    const existingGlbPath = path.resolve(__dirname, '../../../public/colosseum_clay_styled_test.glb');

    beforeAll(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        registry = createDefaultToolRegistry();

        mockContext = {
            request: {
                prompt: 'End-to-End User Journey Simulation',
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
                    if (action === 'evaluate') return { result: 1 };
                    return { status: 200, title: 'Journey Stage', url: args?.url || 'http://localhost:3000' };
                },
                getActiveState: () => ({ url: 'http://localhost:3000', title: 'Journey Stage', markdown: '# Stage Active', elements: [] })
            } as any,
            lens: {
                executeLensProject: async (filePath: string) => ({ success: true, artifactId: 'art-journey-1', filePath, code: 'class Journey {}' }),
                executeLensUnproject: async (artifactId: string) => ({ success: true, artifactId }),
                executeLensListBindings: () => [{ artifactId: 'art-journey-1', filePath: 'src/journey.ts', status: 'synced' }],
                executeLensSync: () => ({ success: true, artifactId: 'art-journey-1', status: 'synced' })
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
    // Journey 1: Photorealistic Real-World Landmark Ingestion & VFX Compositing
    // =========================================================================
    it('Journey 1: Executes complete 7-step Colosseum photogrammetry pipeline', async () => {
        // Step 1: Headless Clay Blockout Runner
        const blockoutRes = await registry.dispatch('google_3d_tiles_clay_blockout_runner', {
            query: '41.890210, 12.492231',
            trajectoryPreset: 'cinematic_arc',
            mockExecution: true,
            // The mock tile GLB defaults to public/models; keep it in the test workspace
            outputGlbPath: path.join(testDir, 'clay_blockout.glb')
        }, mockContext);
        expect(blockoutRes.exec.status).toBe('completed');
        expect((blockoutRes.resultPayload as any).videoRef).toBe('<VIDEO_REF_0>');

        // Step 2: UTDRA Geometric Classification & Probe
        const probeRes = await registry.dispatch('utdra_probe_tile', {
            benchmark: 'urban'
        }, mockContext);
        expect(probeRes.exec.status).toBe('completed');
        expect((probeRes.resultPayload as any).telemetry.dominantDomain).toBeDefined();

        // Step 3: Elevation Slicing with Sutherland-Hodgman clipping (subterranean pruning)
        const sliceRes = await registry.dispatch('utdra_slice_elevation', {
            cutoffY: 2.5,
            benchmark: 'slicer'
        }, mockContext);
        expect(sliceRes.exec.status).toBe('completed');
        expect((sliceRes.resultPayload as any).success).toBe(true);

        // Step 4: NOAA Solar Ephemeris Calculation for Rome at 16:30 CEST
        const solarRes = await registry.dispatch('atmosphere_calculate_solar_position', {
            latitude: 41.890210,
            longitude: 12.492231,
            isoDate: '2026-06-21T14:30:00Z'
        }, mockContext);
        expect(solarRes.exec.status).toBe('completed');
        const elevationDeg = (solarRes.resultPayload as any).elevationDeg;
        expect(elevationDeg).toBeGreaterThan(0);

        // Step 5: Diurnal Lighting Profile Calculation
        const diurnalRes = await registry.dispatch('atmosphere_get_diurnal_profile', {
            elevationDeg,
            turbidity: 2.2
        }, mockContext);
        expect(diurnalRes.exec.status).toBe('completed');
        expect((diurnalRes.resultPayload as any).kelvinTemperature).toBeDefined();

        // Step 6: Cinematic Gaffer Rig Setup
        const gafferRes = await registry.dispatch('lighting_configure_gaffer_rig', {
            style: 'golden_hour_glamour'
        }, mockContext);
        expect(gafferRes.exec.status).toBe('completed');
        expect((gafferRes.resultPayload as any).lights.length).toBeGreaterThan(0);

        // Step 7: AI Beautify Prompt Synthesis strictly maintaining camera framing
        const beautifyRes = await registry.dispatch('build_beautify_prompt', {
            locationName: 'Colosseum, Rome',
            coords: '41.890210, 12.492231',
            heading: 180.0,
            aspectRatio: '16:9',
            moodPromptContext: 'warm cinematic golden hour, authentic travertine textures and sharp cornices'
        }, mockContext);
        expect(beautifyRes.exec.status).toBe('completed');
        const prompt = (beautifyRes.resultPayload as any).prompt;
        expect(prompt).toContain('Colosseum, Rome');
        expect(prompt).toContain('Preserve the EXACT same camera angle');
    });

    // =========================================================================
    // Journey 2: Performer Avatar & 4D Dynamic Gaussian Splatting
    // =========================================================================
    it('Journey 2, steps 1-4: builds performer prompts, tracks points and builds the 4DGS rigidity graph', async () => {
        // Step 1: Build Neutral Studio Performer Prompt (Strict #808080 studio baseline)
        const neutralRes = await registry.dispatch('build_neutral_performer_prompt', {
            subject: 'Contemporary dancer in fitted athletic apparel',
            wardrobe: 'minimalist dark grey compression suit and flat dance shoes',
            aspectRatio: '9:16',
            isAFramePose: true
        }, mockContext);
        expect(neutralRes.exec.status).toBe('completed');
        expect((neutralRes.resultPayload as any).aspectRatio).toBe('9:16');
        expect((neutralRes.resultPayload as any).prompt).toContain('neutral grey studio backdrop');

        // Step 2: Build Frame-Motivated Video Prompt using Wan2.2 Backbone
        const motionRes = await registry.dispatch('build_frame_motivated_performer_prompt', {
            referenceFrameRef: '<IMAGE_REF_0>',
            cameraPosition: 'front',
            heroPoseType: 'a-pose',
            actionPrompt: 'fluid rhythmic body wave and gradual arm elevation',
            videoDiffusionModel: 'Wan2.2-TI2V-5B'
        }, mockContext);
        expect(motionRes.exec.status).toBe('completed');
        expect((motionRes.resultPayload as any).prompt).toContain('<FIRST_FRAME><IMAGE_REF_0></FIRST_FRAME>');

        // Step 3: TAPIR Point Tracking across video frames
        const trackRes = await registry.dispatch('tapir_track_video_points', {
            samplerType: 'grid',
            maxPoints: 256,
            numFrames: 30,
            backend: 'mock'
        }, mockContext);
        expect(trackRes.exec.status).toBe('completed');
        expect((trackRes.resultPayload as any).numPoints).toBe(256);

        // Step 4: Build 4DGS with ARAP Rigidity Graph
        const arapRes = await registry.dispatch('build_4dgs_from_video', {
            canonicalSubject: [
                { position: [0, 1.2, 0], colorRgb: [0.8, 0.7, 0.6], scale: [0.015, 0.015, 0.015], opacity: 0.95 },
                { position: [0.3, 1.0, 0], colorRgb: [0.2, 0.2, 0.2], scale: [0.02, 0.02, 0.02], opacity: 1.0 }
            ],
            numFrames: 15,
            trackingBackend: 'mock'
        }, mockContext);
        expect(arapRes.exec.status).toBe('completed');
        expect((arapRes.resultPayload as any).telemetry).toBeDefined();
    });

    it.skipIf(!avatar2785536.ok)(withReason('Journey 2, step 5: animates the installed Performer avatar and exports deformed splats', avatar2785536), async () => {
        // Step 5: Animate Avatar and Export Deformed Splats
        const animRes = await registry.dispatch('avatar_4dgs_animate', {
            avatarId: '2785536',
            frameIndex: 2,
            exportSplat: true
        }, mockContext);
        expect(animRes.exec.status).toBe('completed');
        expect((animRes.resultPayload as any).numSplats).toBeGreaterThan(0);
    });

    // =========================================================================
    // Journey 3: Optical Camera Calibration & Brown-Conrady VFX Handoff
    // =========================================================================
    it('Journey 3: Calibrates optical lens, computes overscan and exports multi-format VFX scripts', async () => {
        // Step 1: Configure Brown-Conrady Lens Distortion
        const lensRes = await registry.dispatch('optics_configure_lens_distortion', {
            presetId: 'arri_ultra_prime_24mm',
            sampleUvs: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]],
            aspectRatio: 16 / 9,
            includeGlslShader: true
        }, mockContext);
        expect(lensRes.exec.status).toBe('completed');
        expect((lensRes.resultPayload as any).overscanMargin).toBeGreaterThan(0);
        expect((lensRes.resultPayload as any).shader).toBeDefined();

        // Step 2: Configure Physical Camera sensor and depth of field
        const camRes = await registry.dispatch('configure_physical_camera', {
            focalLengthMm: 24,
            apertureFStop: 2.0,
            focusDistanceMeters: 4.5,
            sensorFormat: 'super35'
        }, mockContext);
        expect(camRes.exec.status).toBe('completed');
        expect((camRes.resultPayload as any).frustum.horizontalFovDeg).toBeGreaterThan(50);

        // Step 3: Export to 3DEqualizer, Nuke, OpenCV and STMap
        const exportRes = await registry.dispatch('optics_export_lens_distortion', {
            format: 'all',
            presetId: 'arri_ultra_prime_24mm',
            metadata: {
                lensName: 'ARRI Ultra Prime 24mm',
                resolutionWidth: 3840,
                resolutionHeight: 2160
            }
        }, mockContext);
        expect(exportRes.exec.status).toBe('completed');
        expect((exportRes.resultPayload as any).threeDEqualizerLensFile).toContain('3DEqualizer');
        expect((exportRes.resultPayload as any).nukeScript).toContain('LensDistortion');
        expect((exportRes.resultPayload as any).openCvCalibration).toBeDefined();
        expect((exportRes.resultPayload as any).stMapInfo).toBeDefined();
    });

    // =========================================================================
    // Journey 4: Environmental Botanical Ecosystem & Architectural Clearances
    // =========================================================================
    it('Journey 4: Queries botanical separation and synthesizes anatomically accurate trees', async () => {
        // Step 1: Query separator trees for Oppian Hill Zone
        const botQueryRes = await registry.dispatch('botanical_query_separator_trees', {
            zone: 'oppian_hill_crest'
        }, mockContext);
        expect(botQueryRes.exec.status).toBe('completed');
        const trees = (botQueryRes.resultPayload as any).trees;
        expect(trees.length).toBeGreaterThan(0);

        // Step 2: Synthesize Pinus Pinea (Italian Stone Pine) with anatomical crown
        const botSynthRes = await registry.dispatch('botanical_synthesize_tree', {
            species: 'pinus_pinea',
            canopyHeightMeters: 16.0,
            crownDiameterMeters: 13.0
        }, mockContext);
        expect(botSynthRes.exec.status).toBe('completed');
        expect((botSynthRes.resultPayload as any).success).toBe(true);
        expect((botSynthRes.resultPayload as any).species).toBe('pinus_pinea');
    });

    // =========================================================================
    // Journey 6: Generative UI, Multi-Phase Plan Cards & User Interaction
    // =========================================================================
    it('Journey 6: Mounts canvas primitives, renders plan cards, and prompts user', async () => {
        // Mount 3D Scene Viewport
        const mountRes = await registry.dispatch('mount_canvas_primitive', {
            primitiveType: '3d-scene',
            title: 'Interactive 3D Stage',
            payload: { sceneId: 'stage-roma-01' }
        }, mockContext);
        expect(mountRes.exec.status).toBe('completed');
        expect((mountRes.resultPayload as any).artifactId).toBeDefined();

        // Present Multi-Phase Execution Plan Card
        const planRes = await registry.dispatch('present_execution_plan', {
            title: 'Colosseum Ingestion & 4DGS Reconstruction',
            goal: 'Stream high-res tiles and reconstruct animated avatar',
            steps: [
                { id: 'step-1', title: 'Tile Ingestion' },
                { id: 'step-2', title: '4DGS Alignment' }
            ]
        }, mockContext);
        expect(planRes.exec.status).toBe('completed');
        expect((planRes.resultPayload as any).executionPlanCard).toBeDefined();

        // Ask Interactive Question Card
        const questionRes = await registry.dispatch('ask_user_question', {
            title: 'Execution Mode',
            questions: [
                {
                    id: 'exec-mode',
                    prompt: 'Select reconstruction quality:',
                    options: [
                        { id: 'draft', label: 'Draft' },
                        { id: 'final', label: 'Final' }
                    ]
                }
            ]
        }, mockContext);
        expect(questionRes.exec.status).toBe('completed');
        expect((questionRes.resultPayload as any).questionCard.questions[0].options.length).toBe(2);
    });
});
