import { describe, it, expect } from 'vitest';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { resolveDomainToolPacks } from '../src/node/gemini/domain-tool-packs';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { synthesize3DFallback } from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { synthesizeRawContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { synthesizeAdaptiveHeroObjectContract } from '../src/common/spatial/adaptive-hero-synthesizer';
import { Google3DTileService, detectRealWorldLocationIntent } from '../src/browser/generative-canvas/services/Google3DTileService';
import { GoogleVectorMappingService } from '../src/browser/generative-canvas/services/google-vector-mapping-service';
import { Google3DTileBlockoutPipelineService } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import type { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { requireAnyEnv, withReason } from './helpers/requirements';

// execute_3d_python_script with a location ingests live Google 3D Tiles (GeospatialTileExtractionBridge ->
// getGoogle3DTilesClay). Without a Maps key the leaf crawler is skipped and the headless-Chrome blockout
// runner waits on tiles that never stream (watchdogs >= 60s, overall >= 5 min), so the test can only run online.
const mapsTilesKey = requireAnyEnv(['GOOGLE_MAPS_API_KEY', 'MAP_TILES_API_KEY'], 'live Google Photorealistic 3D Tiles ingestion for location staging');

describe('3D Staging Intent Routing & Active Scene Preservation Invariants', () => {
    const mockBasketballCourtArtifact: CanvasArtifact = {
        id: 'art-3d-court-123',
        type: '3d-scene',
        title: 'Venice Beach Basketball Court',
        summary: 'Procedural 3D basketball court generated via C++20 Scratchbox engine.',
        version: 3,
        createdAt: Date.now(),
        data: {
            title: 'Venice Beach Basketball Court',
            subtitle: '18% Studio Grey Clay | Contact Grounding',
            renderMode: 'clay',
            objects: [
                {
                    id: 'court-mesh-1',
                    content: {
                        type: '3d-model',
                        durableUri: '/models/basketball_court.glb',
                        mimeType: 'model/gltf-binary'
                    },
                    space: { spatial3d: { x: 0, y: 0, z: 0 } },
                    time: { startMs: 0, durationMs: 10000 },
                    lineage: { version: 1 }
                }
            ]
        } as Scene3DData
    };

    describe('1. Task Capability & Domain Resolution', () => {
        it('classifies "stage it at venice beach" as 3d domain when activeArtifact is 3d-scene', () => {
            const domain = TaskCapabilityResolver.classifyTaskDomain('stage it at venice beach', {
                activeArtifact: mockBasketballCourtArtifact
            });
            expect(domain).toBe('3d');
        });

        it('resolves Tier 1 native capability for 3D vector world staging', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability('stage it at venice beach', {
                activeArtifact: mockBasketballCourtArtifact
            });
            expect(res.canSolveNatively).toBe(true);
            expect(res.taskDomain).toBe('3d');
        });

        it('classifies plinth staging as 3d domain', () => {
            const domain = TaskCapabilityResolver.classifyTaskDomain('stage it on an environmental curved cyclorama cove plinth', {
                activeArtifact: mockBasketballCourtArtifact
            });
            expect(domain).toBe('3d');
        });
    });

    describe('2. Tool Pack Packing Invariants', () => {
        it('includes geospatial_3d and core_workspace when staging with active 3d scene', () => {
            const { packs } = resolveDomainToolPacks({
                prompt: 'stage it at venice beach',
                activeArtifact: mockBasketballCourtArtifact
            });
            expect(packs).toContain('geospatial_3d');
            expect(packs).toContain('core_workspace');
            expect(packs).toContain('mesh_surface');
        });
    });

    describe('3. Artifact Synthesis Preservation Invariants', () => {
        it('never degrades active 3D scene into a markdown document when user says "stage it at venice beach"', () => {
            const result = parseOrSynthesizeArtifact(
                'stage it at venice beach',
                'Here is the staged 3D scene at Venice Beach with real-world spatial grounding.',
                {
                    prompt: 'stage it at venice beach',
                    activeArtifact: mockBasketballCourtArtifact
                },
                [],
                undefined
            );

            expect(result.type).toBe('3d-scene');
            expect(result.type).not.toBe('markdown-document');
            const data = result.data as Scene3DData;
            expect(data.geoAnchor).toBeDefined();
            expect(data.geoAnchor?.landmarkName).toContain('Venice');
            expect(data.geoAnchor?.lat).toBeCloseTo(33.9850, 2);
            expect(data.geoAnchor?.lng).toBeCloseTo(-118.4695, 2);
            expect(data.geoAnchor?.active).toBe(true);
        });

        it('mounts staged vector world GLB into objects when stage_3d_vector_world was executed', () => {
            const mockExecutions = [
                {
                    toolName: 'stage_3d_vector_world',
                    callId: 'call_1',
                    status: 'success' as const,
                    resultPayload: {
                        success: true,
                        glbPath: '/models/staged_vector_world_venice.glb',
                        resolvedAddress: 'Venice Beach, Los Angeles, CA',
                        featureCounts: { buildings: 45, roads: 12, trees: 30 }
                    }
                }
            ];

            const result = parseOrSynthesizeArtifact(
                'stage it at venice beach',
                'Successfully populated 3D vector world around the basketball court.',
                {
                    prompt: 'stage it at venice beach',
                    activeArtifact: mockBasketballCourtArtifact
                },
                mockExecutions,
                undefined
            );

            expect(result.type).toBe('3d-scene');
            const data = result.data as Scene3DData;
            expect(data.objects).toBeDefined();
            const vectorWorldObj = data.objects?.find(o => o.content?.durableUri === '/models/staged_vector_world_venice.glb');
            expect(vectorWorldObj).toBeDefined();
            expect(vectorWorldObj?.content?.metadata?.source).toBe('stage_3d_vector_world');
        });
    });

    describe('4. Client-side Fallback Mutation Invariants', () => {
        it('mutates existing 3D scene without blowing away hero objects when staging at real-world location', () => {
            const fallback = synthesize3DFallback(
                'stage it at venice beach',
                'stage it at venice beach',
                mockBasketballCourtArtifact,
                [],
                undefined
            );

            expect(fallback.artifact).toBeDefined();
            expect(fallback.artifact?.type).toBe('3d-scene');
            const data = fallback.artifact?.data as Scene3DData;
            expect(data.title).toContain('Venice Beach');
            expect(data.geoAnchor?.landmarkName).toContain('Venice');
            expect(data.objects?.length).toBeGreaterThan(0);
        });

        it('mutates existing 3D scene when staging on an environmental plinth', () => {
            const fallback = synthesize3DFallback(
                'stage it on a curved cyclorama cove plinth',
                'stage it on a curved cyclorama cove plinth',
                mockBasketballCourtArtifact,
                [],
                undefined
            );

            expect(fallback.artifact?.type).toBe('3d-scene');
            const data = fallback.artifact?.data as Scene3DData;
            expect(data.title).toContain('Staged on Studio Plinth');
        });
    });

    describe('5. Initial Prompt with Explicit Location Invariant', () => {
        it('synthesizes hero object staged in real-world location tiles for "build a 3d scene of race car in central park"', () => {
            const scene = synthesizeRawContextual3DScene('build a 3d scene of race car in central park');

            expect(scene.title).toContain('Central Park');
            expect(scene.geoAnchor).toBeDefined();
            expect(scene.geoAnchor?.landmarkName).toContain('Central Park');
            expect(scene.geoAnchor?.lat).toBeCloseTo(40.78, 1);
            expect(scene.geoAnchor?.lng).toBeCloseTo(-73.96, 1);
            expect(scene.geoAnchor?.active).toBe(true);
            expect(scene.renderMode).toBe('clay');
            expect(scene.environment.ground).toBe(true);
            expect(scene.objects?.length).toBeGreaterThan(0);
        });

        it('synthesizes hero object staged in real-world location tiles for "F1 car in monaco"', () => {
            const scene = synthesizeRawContextual3DScene('F1 car in monaco');

            expect(scene.title).toContain('Monaco');
            expect(scene.geoAnchor).toBeDefined();
            expect(scene.geoAnchor?.landmarkName).toContain('Monaco');
            expect(scene.geoAnchor?.active).toBe(true);
            expect(scene.renderMode).toBe('clay');
            expect(scene.environment.ground).toBe(true);
        });

        it('mounts hero GLB and location GLB when execute_3d_python_script runs with location staging', () => {
            const mockExecutions = [
                {
                    toolName: 'execute_3d_python_script',
                    callId: 'call_python_1',
                    status: 'success' as const,
                    resultPayload: {
                        success: true,
                        glbPath: '/models/race_car.glb',
                        locationGlbPath: '/build/3d-geospatial/central_park_tiles.glb',
                        locationQuery: 'Central Park, New York',
                        description: 'Race car'
                    }
                }
            ];

            const result = parseOrSynthesizeArtifact(
                'build a 3d scene of race car in central park',
                'Synthesized race car staged in Central Park in studio grey clay.',
                {
                    prompt: 'build a 3d scene of race car in central park'
                },
                mockExecutions,
                undefined
            );

            expect(result.type).toBe('3d-scene');
            const data = result.data as Scene3DData;
            expect(data.title).toContain('Central Park');
            expect(data.geoAnchor?.landmarkName).toContain('Central Park');
            expect(data.objects?.some(o => o.content?.durableUri === '/models/race_car.glb')).toBe(true);
            expect(data.objects?.some(o => o.content?.durableUri === '/build/3d-geospatial/central_park_tiles.glb')).toBe(true);
        });

        it('synthesizes hero GT race cars staged in Washington Square Park Arch tiles with 70-20-10 form', () => {
            const prompt = 'High-speed car race around Washington Square Park Arch with chicane';
            const scene = synthesizeRawContextual3DScene(prompt);

            expect(scene.title).toContain('Washington Square Park Arch');
            expect(scene.geoAnchor).toBeDefined();
            expect(scene.geoAnchor?.landmarkName).toContain('Washington Square Park Arch');
            expect(scene.geoAnchor?.lat).toBeCloseTo(40.7308, 2);
            expect(scene.geoAnchor?.lng).toBeCloseTo(-73.9973, 2);
            expect(scene.renderMode).toBe('clay');
            expect(scene.environment.ground).toBe(true);
            expect(scene.objects?.length).toBeGreaterThan(0);
        });

        it('synthesizes adaptive hero GT racer with 70-20-10 form hierarchy and upright wheels', () => {
            const prompt = 'High-speed car race around Washington Square Park Arch with chicane';
            const heroContract = synthesizeAdaptiveHeroObjectContract(prompt);

            // 70% Primary Edifice: Aerodynamic GT proportions
            expect(heroContract.boundingScaleMeters[2]).toBeGreaterThanOrEqual(4.5); // Length >= 4.5m
            expect(heroContract.boundingScaleMeters[1]).toBeLessThanOrEqual(1.3);    // Low-slung height <= 1.3m
            expect(heroContract.primaryHull.stations.length).toBeGreaterThanOrEqual(7);

            // 20% Secondary Articulated Assemblies: Aerodynamics & Grounding
            expect(heroContract.aerodynamics).toBeDefined();
            expect(heroContract.aerodynamics?.some(a => a.id.includes('wing'))).toBe(true);
            expect(heroContract.grounding?.[0].type).toBe('MULTILINK_WHEEL');
            expect(heroContract.grounding?.[0].camberAngleDeg).toBeLessThan(0); // Negative camber

            // 10% Tertiary Micro-Detail & Differential Operators: 4 upright forged wheel rims
            const wheelRims = (heroContract.revolvedHarmonics || []).filter(h => h.id.startsWith('wheel_rim'));
            expect(wheelRims.length).toBe(4);
            expect(heroContract.materialAttributes?.renderMode).toBe('clay');
        });

        it('detects authentic Manhattan location intent and coordinates for "make me a car race in manhattan"', () => {
            const prompt = 'make me a car race in manhattan';
            const locIntent = detectRealWorldLocationIntent(prompt);

            expect(locIntent).toBeDefined();
            expect(locIntent?.isRealWorld).toBe(true);
            expect(locIntent?.landmarkName).toContain('Manhattan');
            expect(locIntent?.lat).toBeCloseTo(40.7831, 2);
            expect(locIntent?.lng).toBeCloseTo(-73.9712, 2);
        });

        it('resolves Manhattan queries to canonical geodetic anchor via GoogleVectorMappingService', () => {
            const anchor = GoogleVectorMappingService.searchFeatures('manhattan');
            expect(anchor).toBeDefined();
            expect(anchor?.lat).toBeCloseTo(40.7484, 2);
            expect(anchor?.lng).toBeCloseTo(-73.9857, 2);
        });

        it('resolves Manhattan queries via Google3DTileBlockoutPipelineService.prototype.resolveAddress', async () => {
            const service = new Google3DTileBlockoutPipelineService();
            const resolved = await service.resolveAddress('Manhattan, New York');
            expect(resolved).toBeDefined();
            expect(resolved.lat).toBeGreaterThan(40.0);
            expect(resolved.lng).toBeLessThan(-70.0);
            expect(resolved.landmarkName).toBeDefined();
        });

        it('synthesizes scene staged in authentic Manhattan Google 3D tiles for "make me a car race in manhattan"', () => {
            const prompt = 'make me a car race in manhattan';
            const scene = synthesizeRawContextual3DScene(prompt);

            expect(scene.title).toContain('Manhattan');
            expect(scene.geoAnchor).toBeDefined();
            expect(scene.geoAnchor?.landmarkName).toContain('Manhattan');
            expect(scene.geoAnchor?.lat).toBeCloseTo(40.7831, 2);
            expect(scene.geoAnchor?.lng).toBeCloseTo(-73.9712, 2);
            expect(scene.renderMode).toBe('clay');
            expect(scene.environment.ground).toBe(true);

            // Objects must contain the Manhattan 3D tile object
            const tileObject = scene.objects?.find(o => 
                o.content?.type === 'map-3d' ||
                o.id.startsWith('tile_mesh_') ||
                o.id === 'google-3d-tiles-base' ||
                o.id === 'google-vector-world-base' ||
                o.content?.metadata?.source?.toLowerCase().includes('tile')
            );
            expect(tileObject).toBeDefined();
            expect(tileObject?.content?.metadata?.source?.toLowerCase()).toContain('tile');
        });
    });

    describe('4. ADA Standards & Zero-Preset Open-Domain Invariants', () => {
        const tileService = Google3DTileService.getInstance();

        it('does NOT silently fall back to San Francisco when a novel/unresolvable location is requested', async () => {
            // resolveLocationSync should report isResolved: false, NOT silently inject San Francisco coords
            const syncResult = tileService.resolveLocationSync('unknown extraterrestrial geothermal base alpha');
            expect(syncResult.isResolved).toBe(false);
            expect(syncResult.lat).toBe(0);
            expect(syncResult.lng).toBe(0);

            // Asynchronous resolveLocation should reject with an ADA-actionable error instead of defaulting
            await expect(tileService.resolveLocation('unknown fictitious underwater metropolis 404'))
                .rejects
                .toThrow(/ADA Zero-Presets|Could not resolve geodetic coordinates/);
        });

        it('ingests open-domain geodetic coordinates directly via bracketed strings', () => {
            const result = tileService.resolveLocationSync('[43.7384, 7.4246]');
            expect(result.isResolved).toBe(true);
            expect(result.lat).toBeCloseTo(43.7384, 4);
            expect(result.lng).toBeCloseTo(7.4246, 4);
            expect(result.elevationSource).toBe('explicit_coordinates');
        });

        it('detects real-world intent from raw WGS-84 coordinate strings in prompts', () => {
            const detected = detectRealWorldLocationIntent('build 3d formula 1 car around [43.7384, 7.4246] in clay');
            expect(detected).toBeDefined();
            expect(detected?.isRealWorld).toBe(true);
            expect(detected?.lat).toBeCloseTo(43.7384, 4);
            expect(detected?.lng).toBeCloseTo(7.4246, 4);
        });

        it.skipIf(!mapsTilesKey.ok)(withReason('supports direct geodetic coordinates [lat, lng] in execute_3d_python_script without static dictionaries', mapsTilesKey), async () => {
            // Passing explicit coordinates directly in tool arguments
            const outcome = await python3DHandlers.execute_3d_python_script({
                script: 'import scratchbox as sb\nscene = sb.Scene()\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)',
                location: 'Circuit de Monaco Waterfront',
                coordinates: [43.7384, 7.4246],
                description: 'F1 race car staged in Monaco'
            });

            expect(outcome.status).toBe('completed');
            const payload = outcome.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.geoAnchor).toBeDefined();
            expect(payload.geoAnchor.lat).toBeCloseTo(43.7384, 4);
            expect(payload.geoAnchor.lng).toBeCloseTo(7.4246, 4);
            expect(payload.geoAnchor.elevationSource).toBe('explicit_coordinates');
            expect(payload.artifact.data.subtitle).toContain('43.7384');
        });

        it('respects ContinuousPhysicalParameters overrides in synthesizeAdaptiveHeroObjectContract (Alien Planet Test)', () => {
            // An entity the developer never conceived of with continuous parameter overrides
            const novelPrompt = 'Bioluminescent geothermal mycelium forest spire';
            const heroContract = synthesizeAdaptiveHeroObjectContract(novelPrompt, {
                parameterOverrides: {
                    scaleLength: 7.5,
                    scaleWidth: 3.8,
                    scaleHeight: 12.0,
                    superellipseExponent: 3.5,
                    appendageCount: 8
                }
            });

            // Overrides must directly govern continuous dimensions
            expect(heroContract.boundingScaleMeters[0]).toBeCloseTo(3.8, 1);  // Width
            expect(heroContract.boundingScaleMeters[1]).toBeCloseTo(12.0, 1); // Height
            expect(heroContract.boundingScaleMeters[2]).toBeCloseTo(7.5, 1);  // Length
            expect(heroContract.primaryHull.stations[0].superellipseExponent).toBeCloseTo(3.5, 1);
            expect(heroContract.revolvedHarmonics?.length).toBeGreaterThanOrEqual(1);
        });
    });
});

