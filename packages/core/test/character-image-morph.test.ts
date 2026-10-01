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
        it('should return valid baseline drawing figure when empty request provided', async () => {
            const estimator = new CharacterImageMorphEstimator();
            const res = await estimator.estimateMorphFromImages({ images: [] });

            expect(res.success).toBe(true);
            expect(res.betas.length).toBe(8);
            expect(res.ratios.headsTall).toBe(7.5);
        });

        it('should return feminine standard drawing figure proportions on female hint fallback', async () => {
            const estimator = new CharacterImageMorphEstimator();
            const req: CharacterMorphRequest = {
                images: [{ imageData: 'fake_base64_data', viewType: 'front' }],
                genderHint: 'female'
            };

            const res = await estimator.estimateMorphFromImages(req);
            expect(res.success).toBe(true);
            expect(res.ratios.bustVolumeScore).toBeGreaterThan(0.5);
            expect(res.ratios.waistCinchRatio).toBeLessThan(0.70);
            expect(res.betas[3]).toBeLessThan(-1.0);
            expect(res.matchedArchetype).toContain('Feminine');
        });

        it('should return masculine standard drawing figure proportions on male hint fallback', async () => {
            const estimator = new CharacterImageMorphEstimator();
            const req: CharacterMorphRequest = {
                images: [{ imageData: 'fake_base64_data', viewType: 'front' }],
                genderHint: 'male'
            };

            const res = await estimator.estimateMorphFromImages(req);
            expect(res.success).toBe(true);
            expect(res.ratios.shoulderToHipRatio).toBeGreaterThan(1.20);
            expect(res.ratios.waistCinchRatio).toBeGreaterThan(0.80);
            expect(res.betas[1]).toBeGreaterThan(0.5);
            expect(res.betas[3]).toBeGreaterThan(1.0);
            expect(res.matchedArchetype).toContain('Masculine');
        });
    });
});
