/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { synthesizeContextual3DScene, detect3DSceneTheme } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { CANVAS_TOOL_DECLARATIONS, canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import { buildContents, buildSystemInstruction } from '../src/node/gemini/prompt-builder';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Location 3DGS & Nano Banana Restyling Frontend Integration', () => {
    describe('1. TaskCapabilityResolver for 3DGS Location Requests (Implicit Nano Banana)', () => {
        it('resolves location Gaussian splat prompt natively WITHOUT the user invoking nano banana', () => {
            // User does NOT mention "nano banana" - it should be assumed because of our pipeline. The request says it
            // is about a real place; the resolver no longer recognises place names ("Colosseum") from a list.
            const result = TaskCapabilityResolver.resolveTaskCapability(
                'Make a gaussian splat of this landmark, the Colosseum'
            );

            expect(result.canSolveNatively).toBe(true);
            expect(result.canSolveNatively).toBe(true);
            expect(result.suggestedNativeAction).toBeDefined();
            expect(result.suggestedNativeAction?.primitiveType).toBe('3d-scene');
            expect(result.nativeCapabilities.some(c => /splat|3dgs|survey/i.test(c))).toBe(true);
            expect(result.tier1Assessment.rationale).toContain('Nano Banana');
            expect(result.tier1Assessment.rationale).toContain('without requiring the user to invoke or mention Nano Banana explicitly');
        });

        it('resolves 3dgs prompt for Empire State Building natively without nano banana in prompt', () => {
            const result = TaskCapabilityResolver.resolveTaskCapability(
                'Create a 3dgs radiance field of Empire State Building'
            );

            expect(result.canSolveNatively).toBe(true);
            expect(result.canSolveNatively).toBe(true);
            expect(result.suggestedNativeAction?.primitiveType).toBe('3d-scene');
        });

        it('resolves 3d gaussian splat of Eiffel Tower natively without nano banana', () => {
            const result = TaskCapabilityResolver.resolveTaskCapability(
                'Make a 3d gaussian splat of the Eiffel Tower'
            );

            expect(result.canSolveNatively).toBe(true);
            expect(result.canSolveNatively).toBe(true);
            expect(result.suggestedNativeAction?.primitiveType).toBe('3d-scene');
        });
    });

    describe('3. procedural-3d-synthesizer Location 3DGS Intent & Scene Generation', () => {
        it('detects 3DGS theme for location splat prompts', () => {
            const theme = detect3DSceneTheme('Make a gaussian splat of the Colosseum');
            expect(theme).toBe('gaussian_splat');
        });

        // A place named in a template prompt is never looked up in a table: no anchor and no canned splat for it.
        // Location splats come from location_generate_3dgs, which resolves the place with Google Places.
        it.each([
            ['Make a gaussian splat of the Colosseum', 'Colosseum'],
            ['Generate a 3dgs of Empire State Building', 'Empire State']
        ])('"%s" gets no table-looked-up anchor or canned splat', (prompt, name) => {
            const data = synthesizeContextual3DScene(prompt) as Scene3DData;
            expect(data.title).toContain(name);
            expect(data.geoAnchor).toBeUndefined();
            expect(data.splatUrl).toBeUndefined();
        });

        it('a named place with no coordinates offline gets no invented anchor or stand-in splat', () => {
            // Grand Army Plaza is not in the offline registry; it needs online geocoding to be placed. No template scene
            // stands in: the step fails, so nothing is anchored and no splat is mounted.
            expect(() => synthesizeContextual3DScene('Create a gaussian splat of Grand Army Plaza'))
                .toThrow(/^No 3D scene was built for "Create a gaussian splat of Grand Army Plaza"/);
        });
    });

    describe('4. prompt-builder and fallback prompt classification', () => {
        it('buildContents passes a splat prompt on as written; the agent instructions name the survey pipeline instead', async () => {
            const contents = buildContents({
                prompt: 'Make a gaussian splat of the Colosseum'
            });

            expect(contents).toHaveLength(1);
            expect(contents[0].parts[0].text).toBe('Make a gaussian splat of the Colosseum');
            const system = await buildSystemInstruction({ prompt: 'Make a gaussian splat of the Colosseum', mode: 'agent' });
            expect(system).toContain('survey_synthesize_stations');
            expect(system).toContain('survey_beautify_to_splats');
            expect(system).toContain('never mount a splat path or tileset a tool did not produce');
            expect(system).not.toContain("splatUrl: '/models/<location>_splat.splat'");
        });
    });

    describe('5. mount_canvas_primitive Gemini Tool Splat Preservation', () => {
        it('preserves splatUrl, splatTilesetUrl, and splatOptions in mounted 3d-scene', async () => {
            const handler = canvasHandlers.mount_canvas_primitive;
            const res = await handler({
                primitiveType: '3d-scene',
                title: 'Rome Colosseum — 3DGS',
                summary: 'Location 3D Gaussian Splat',
                payload: {
                    title: 'Rome Colosseum — 3DGS',
                    splatUrl: '/models/colosseum_splat.splat',
                    splatTilesetUrl: '/tilesets/colosseum/tileset.json',
                    splatOptions: { splatScale: 1.0, contactShadow: true },
                    objects: [
                        {
                            id: 'colosseum-splat',
                            content: {
                                type: 'gaussian-splat',
                                durableUri: '/models/colosseum_splat.splat',
                                mimeType: 'application/octet-stream'
                            },
                            space: { spatial3d: { x: 0, y: 0, z: 0 } }
                        }
                    ]
                }
            }, { request: { prompt: 'Make a gaussian splat of the Colosseum' } } as any);

            const artifact = (res.resultPayload as any).artifact;
            expect(artifact.type).toBe('3d-scene');
            const sceneData = artifact.data as Scene3DData;
            expect(sceneData.splatUrl).toBe('/models/colosseum_splat.splat');
            expect(sceneData.splatTilesetUrl).toBe('/tilesets/colosseum/tileset.json');
            expect(sceneData.splatOptions?.splatScale).toBe(1.0);
            expect(sceneData.objects?.some(o => o.content?.type === 'gaussian-splat')).toBe(true);
        });
    });
});
