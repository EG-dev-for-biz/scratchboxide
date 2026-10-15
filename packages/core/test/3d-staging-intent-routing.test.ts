import { describe, it, expect } from 'vitest';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { resolveDomainToolPacks } from '../src/node/gemini/domain-tool-packs';
import { synthesizeRawContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Google3DTileService } from '../src/browser/generative-canvas/services/Google3DTileService';
import { Google3DTileBlockoutPipelineService } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
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

    describe('5. Initial Prompt with Explicit Location Invariant', () => {
        it.each([
            'build a 3d scene of race car in central park',
            'F1 car in monaco',
            'High-speed car race around Washington Square Park Arch with chicane',
            'make me a car race in manhattan'
        ])('does not turn the place named in "%s" into coordinates during template synthesis', (prompt) => {
            const scene = synthesizeRawContextual3DScene(prompt);
            expect(scene.geoAnchor).toBeUndefined();
            const tileObject = scene.objects?.find(o => String(o.content?.metadata?.source || '').toLowerCase().includes('tile'));
            expect(tileObject).toBeUndefined();
        });

        it('resolves a place name only with Google Places: without a Maps key it throws LocationUnresolvedError', async () => {
            const service = new Google3DTileBlockoutPipelineService();
            const saved = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
            delete process.env.GOOGLE_MAPS_API_KEY;
            delete process.env.MAP_TILES_API_KEY;
            try {
                await expect(service.resolveAddress('Manhattan, New York')).rejects.toBeInstanceOf(LocationUnresolvedError);
            } finally {
                if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
                if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
            }
        });
    });

    describe('4. ADA Standards & Zero-Preset Open-Domain Invariants', () => {
        const tileService = Google3DTileService.getInstance();

        it('does NOT silently fall back to San Francisco (or Null Island) when a location cannot be resolved', async () => {
            // Place names need Google Places: the sync resolver throws instead of returning (0, 0)
            expect(() => tileService.resolveLocationSync('unknown extraterrestrial geothermal base alpha')).toThrow(LocationUnresolvedError);
            expect(() => tileService.resolveLocationSync('0, 0')).toThrow(LocationUnresolvedError);

            // Without a Maps key the async resolver rejects instead of defaulting
            const saved = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
            delete process.env.GOOGLE_MAPS_API_KEY;
            delete process.env.MAP_TILES_API_KEY;
            try {
                await expect(tileService.resolveLocation('unknown fictitious underwater metropolis 404')).rejects.toBeInstanceOf(LocationUnresolvedError);
            } finally {
                if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
                if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
            }
        });

        it('ingests open-domain geodetic coordinates directly via bracketed strings', () => {
            const result = tileService.resolveLocationSync('[43.7384, 7.4246]');
            expect(result.isResolved).toBe(true);
            expect(result.lat).toBeCloseTo(43.7384, 4);
            expect(result.lng).toBeCloseTo(7.4246, 4);
            // No elevation was stated, so none is reported (never a registry or 15 m guess).
            expect(result.elevation).toBeUndefined();
        });

        it('execute_3d_python_script does not stage scripts on places: coordinates fail the call instead of mounting raw tiles', async () => {
            // Places come from google_3d_tiles_get_clay (remeshed clay with trees); a script run never mounts raw tiles.
            const outcome = await python3DHandlers.execute_3d_python_script({
                script: 'import scratchbox as sb\nscene = sb.Scene()\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)',
                location: 'Circuit de Monaco Waterfront',
                coordinates: [43.7384, 7.4246],
                description: 'F1 race car staged in Monaco'
            });

            expect(outcome.status).toBe('failed');
            const payload = outcome.resultPayload as any;
            expect(payload.success).toBe(false);
            expect(payload.artifact).toBeUndefined();
            expect(payload.geoAnchor).toBeUndefined();
            expect(payload.error).toContain('google_3d_tiles_get_clay');
        });
    });
});

