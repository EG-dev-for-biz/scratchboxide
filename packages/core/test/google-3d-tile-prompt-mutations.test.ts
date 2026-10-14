/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    classifyFallbackPrompt,
    synthesize3DFallback,
    mutateExisting3DScene
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Google Maps 3D Tile Prompt Mutations Audit', () => {

    const initial3DColosseumArtifact: CanvasArtifact = {
        id: 'artifact-colosseum-3d',
        type: '3d-scene',
        title: 'Colosseum, Rome — Google Maps 3D Tile',
        data: {
            title: 'Colosseum, Rome — Google Maps 3D Tile',
            subtitle: 'Photorealistic 3D Tile Ingestion',
            renderMode: 'shaded',
            objects: [
                {
                    id: 'obj-colosseum-tile',
                    content: {
                        type: '3d-scene',
                        durableUri: '/models/colosseum_clay.glb',
                        mimeType: 'model/gltf-binary',
                        metadata: {
                            vertexCount: 234679,
                            triangleCount: 170802
                        }
                    },
                    space: { spatial3d: { x: 0, y: 0, z: 0 } },
                    time: { startMs: 0, durationMs: 10000 },
                    lineage: { version: 1 }
                }
            ],
            geoAnchor: {
                lat: 41.8902,
                lng: 12.4922,
                elevation: 22.0,
                active: true,
                landmarkName: 'Colosseum, Rome'
            },
            camera: {
                position: [180, 120, 220],
                target: [0, 15, 0],
                fov: 45
            }
        } as Scene3DData
    };

    describe('3. Shading & Clay Presets (TileClayProcessor.ts)', () => {
        const presets = [
            { prompt: 'Switch to warm clay mode', expectedPreset: 'warm-clay' },
            { prompt: 'Apply alabaster clay preset', expectedPreset: 'alabaster' },
            { prompt: 'Switch to onyx clay', expectedPreset: 'onyx' },
            { prompt: 'Change to studio grey', expectedPreset: 'studio-grey' },
            { prompt: 'Switch to terracotta clay mode', expectedPreset: 'terracotta' },
            { prompt: 'Apply porcelain clay', expectedPreset: 'porcelain' },
            { prompt: 'Switch to concrete clay', expectedPreset: 'concrete' }
        ];

        presets.forEach(({ prompt, expectedPreset }) => {
            it(`applies clay preset "${expectedPreset}" for: "${prompt}"`, () => {
                const classification = classifyFallbackPrompt(prompt, initial3DColosseumArtifact, '3d', undefined);
                expect(classification.is3DRequest).toBe(true);

                const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
                const data = result.artifact?.data as Scene3DData;
                expect(data.renderMode).toBe('shaded');
                expect(data.clayPreset).toBe(expectedPreset);
            });
        });
    });

    describe('4. Photorealistic PBR & Wireframe Modes', () => {
        it('switches to photorealistic textured PBR mode', () => {
            const prompt = 'Switch to textured mode with photorealistic PBR textures';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.renderMode).toBe('pbr');
            expect(data.clayPreset).toBeUndefined();
        });

        it('switches to wireframe mode', () => {
            const prompt = 'Toggle wireframe mode';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.renderMode).toBe('wireframe');
        });
    });

    describe('5. Travertine Stone Albedo & Dusk Window Portals (location-object-lighting)', () => {
        it('applies travertine calibration, shadow lift, and 2800K window portals', () => {
            const prompt = 'Travertine dusk with window lighting and shadow lift';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.renderMode).toBe('pbr');
            expect(data.environment?.lightingKelvin).toBe(2800);
            expect(data.environment?.timeOfDay).toBe(19.0);
            expect(result.explanation).toContain('travertine');
        });
    });

    describe('6. Architectural Entity Separation & 3D Bounding Boxes', () => {
        it('segments discrete entities and generates 3D oriented bounding boxes', () => {
            const prompt = 'Separate discrete architectural entities and show 3d bounding boxes';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.features?.showBoundingBoxes).toBe(true);
            expect(data.features?.objectSeparation).toBe(true);
            expect(data.objects?.length).toBeGreaterThanOrEqual(2);
            expect(result.explanation).toContain('74.2%');
        });
    });

    describe('7. Camera Trajectory Modes', () => {
        it('configures cinematic arc camera trajectory', () => {
            const prompt = 'Set cinematic arc camera trajectory';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.timeline?.isPlaying).toBe(true);
            expect(result.explanation).toContain('Cinematic Arc Camera Trajectory');
            expect(result.explanation).toContain('<VIDEO_REF_0>');
        });

        it('configures canyon push camera trajectory', () => {
            const prompt = 'Run canyon push forward trajectory';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.timeline?.isPlaying).toBe(true);
            expect(result.explanation).toContain('Canyon Push Camera Trajectory');
        });
    });

    describe('8. Scene Export', () => {
        it('handles glb export prompt', () => {
            const prompt = 'Export scene to glb';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            expect(result.explanation).toContain('glTF 2.0 (.glb)');
        });
    });

    describe('9. Real-World Geodetic Landmark Ingestion', () => {
        it('does not move the scene to a place named in the prompt: places are resolved by the location tools', () => {
            const prompt = 'Navigate to Ferry Building, San Francisco';
            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), initial3DColosseumArtifact, [], undefined);
            const data = result.artifact?.data as Scene3DData;
            expect(data.geoAnchor?.landmarkName ?? '').not.toContain('Ferry Building');
            expect(data.title).not.toContain('Ferry Building');
            expect(data.objects?.some(o => o.content?.durableUri === '/models/sf_ferry_raw.glb')).not.toBe(true);
        });
    });
});
