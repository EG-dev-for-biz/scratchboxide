import { describe, it, expect } from 'vitest';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { resolveDomainToolPacks } from '../src/node/gemini/domain-tool-packs';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { synthesize3DFallback } from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { synthesizeRawContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

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
    });
});
