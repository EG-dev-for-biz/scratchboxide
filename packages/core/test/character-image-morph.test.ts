/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { CharacterSilhouetteSolver } from '../src/node/spatial/CharacterSilhouetteSolver';
import { CharacterImageMorphEstimator } from '../src/node/spatial/CharacterImageMorphEstimator';
import { CharacterMorphRequest, CharacterAnatomicalRatios } from '../src/common/character-morph-protocol';

describe('CharacterSilhouetteSolver & CharacterImageMorphEstimator', () => {
    describe('CharacterSilhouetteSolver', () => {
        it('should solve canonical betas for masculine drawing figure proportions', () => {
            const maleRatios: CharacterAnatomicalRatios = {
                headsTall: 7.6,
                shoulderToHipRatio: 1.25,
                waistCinchRatio: 0.82,
                bustVolumeScore: 0.10,
                legToTorsoRatio: 1.05,
                muscularityScore: 0.50,
                genderDimorphism: 0.85
            };

            const betas = CharacterSilhouetteSolver.solveBetasFromRatios(maleRatios, 1.80);
            expect(betas.length).toBe(8);

            // Mode 0: Stature elongation for 1.80m should be positive
            expect(betas[0]).toBeGreaterThan(0.0);
            // Mode 1: Muscularity / V-Taper should be positive
            expect(betas[1]).toBeGreaterThan(0.5);
            // Mode 3: Masculine dimorphism should be strongly positive
            expect(betas[3]).toBeGreaterThan(1.0);
            // Mode 5: Broad biacromial shoulders should be positive
            expect(betas[5]).toBeGreaterThan(0.5);
            // Mode 7: Cranial proportion near neutral standard
            expect(Math.abs(betas[7])).toBeLessThan(0.5);
        });

        it('should solve canonical betas for feminine drawing figure proportions', () => {
            const femaleRatios: CharacterAnatomicalRatios = {
                headsTall: 7.3,
                shoulderToHipRatio: 0.94,
                waistCinchRatio: 0.64,
                bustVolumeScore: 0.65,
                legToTorsoRatio: 1.08,
                muscularityScore: -0.20,
                genderDimorphism: -0.90
            };

            const betas = CharacterSilhouetteSolver.solveBetasFromRatios(femaleRatios, 1.66);
            expect(betas.length).toBe(8);

            // Mode 0: Stature reduction for 1.66m should be negative
            expect(betas[0]).toBeLessThan(0.0);
            // Mode 3: Feminine hourglass + teardrop bust dimorphism should be strongly negative
            expect(betas[3]).toBeLessThan(-1.5);
            // Mode 6: Pelvic breadth & hip flare should be positive
            expect(betas[6]).toBeGreaterThan(0.5);
        });

        it('should solve canonical betas for stylized chibi proportions', () => {
            const chibiRatios: CharacterAnatomicalRatios = {
                headsTall: 4.5,
                shoulderToHipRatio: 1.02,
                waistCinchRatio: 0.85,
                bustVolumeScore: 0.05,
                legToTorsoRatio: 0.88,
                muscularityScore: -0.50,
                genderDimorphism: 0.0
            };

            const betas = CharacterSilhouetteSolver.solveBetasFromRatios(chibiRatios, 1.30);
            expect(betas.length).toBe(8);

            // Mode 7: Large cranial ratio should be strongly positive (chibi mode)
            expect(betas[7]).toBeGreaterThan(2.0);
            // Mode 0: Small stature should be negative
            expect(betas[0]).toBeLessThan(-2.0);
        });

        it('should accurately fuse orthogonal Front + Side view observations', () => {
            const fused = CharacterSilhouetteSolver.fuseMultiViewObservations([
                {
                    viewType: 'front',
                    headsTall: 7.4,
                    shoulderToHipRatio: 0.92,
                    waistCinchRatio: 0.62,
                    bustProjectionScore: 0.40,
                    confidence: 0.90
                },
                {
                    viewType: 'side',
                    headsTall: 7.4,
                    bustProjectionScore: 0.70,
                    glutealProjectionScore: 0.65,
                    confidence: 0.95
                }
            ]);

            // Front view should drive transverse shoulder and waist
            expect(fused.shoulderToHipRatio).toBe(0.92);
            expect(fused.waistCinchRatio).toBe(0.62);

            // Side view should dominate sagittal bust projection (85% weight)
            expect(fused.bustVolumeScore).toBeGreaterThan(0.60);
            expect(fused.headsTall).toBe(7.4);
        });
    });

    describe('CharacterImageMorphEstimator', () => {
        const IMAGE = [{ imageData: 'iVBORw0KGgo=', viewType: 'front' as const, mimeType: 'image/png' }];
        const answering = (text: string, calls: any[] = []) => ({
            requestGenerateContent: async (model: string, contents: any[]) => {
                calls.push({ model, contents });
                return { json: { candidates: [{ content: { parts: [{ text }] } }] }, credential: 'vertex' as const };
            }
        }) as any;

        it('with no images there is nothing to measure, and no baseline figure is returned', async () => {
            const res = await new CharacterImageMorphEstimator(answering('{}')).estimateMorphFromImages({ images: [] });
            expect(res).toEqual({ success: false, error: expect.stringContaining('No character images') });
        });

        it('a failed vision request is a failure with its error, not a "drawing figure prior"', async () => {
            const failing = { requestGenerateContent: async () => { throw new Error('Vertex AI error (400): INVALID_ARGUMENT'); } } as any;
            for (const genderHint of ['female', 'male'] as const) {
                const res = await new CharacterImageMorphEstimator(failing).estimateMorphFromImages({ images: IMAGE, genderHint });
                expect(res.success).toBe(false);
                if (res.success) return;
                expect(res.error).toContain('Vertex AI error (400): INVALID_ARGUMENT');
                expect(res).not.toHaveProperty('ratios');
                expect(res).not.toHaveProperty('betas');
            }
        });

        it('returns the proportions the model measured, solved into betas, with the model and credential', async () => {
            const calls: any[] = [];
            const measured = { headsTall: 7.3, shoulderToHipRatio: 0.94, waistCinchRatio: 0.65, bustVolumeScore: 0.62, legToTorsoRatio: 1.05, muscularityScore: -0.2, genderDimorphism: -0.85, confidence: 0.81, matchedArchetype: 'Stylized heroine' };
            const res = await new CharacterImageMorphEstimator(answering('```json\n' + JSON.stringify(measured) + '\n```', calls)).estimateMorphFromImages({ images: IMAGE });
            expect(res.success).toBe(true);
            if (!res.success) return;
            expect(res.ratios).toEqual({ headsTall: 7.3, shoulderToHipRatio: 0.94, waistCinchRatio: 0.65, bustVolumeScore: 0.62, legToTorsoRatio: 1.05, muscularityScore: -0.2, genderDimorphism: -0.85 });
            expect(res.betas).toHaveLength(8);
            expect(res.betas[3]).toBeLessThan(-1.0);
            expect(res).toMatchObject({ confidence: 0.81, matchedArchetype: 'Stylized heroine', credential: 'vertex' });
            expect(calls[0].contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' });
        });

        it('a reply missing proportions fails and names them (none are filled in)', async () => {
            const res = await new CharacterImageMorphEstimator(answering(JSON.stringify({ headsTall: 7.5, explanation: 'partial' }))).estimateMorphFromImages({ images: IMAGE });
            expect(res.success).toBe(false);
            if (res.success) return;
            expect(res.error).toContain('shoulderToHipRatio');
            expect(res.error).toContain('genderDimorphism');
        });
    });
});
