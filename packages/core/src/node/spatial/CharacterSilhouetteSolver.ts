/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CharacterAnatomicalRatios,
    CanonicalShapeBetas,
    CharacterMorphViewType
} from '../../common/character-morph-protocol';

export interface ViewSpecificProportions {
    viewType: CharacterMorphViewType;
    headsTall?: number;
    shoulderToHipRatio?: number;
    waistCinchRatio?: number;
    bustProjectionScore?: number;
    glutealProjectionScore?: number;
    legToTorsoRatio?: number;
    muscularityScore?: number;
    genderDimorphism?: number;
    confidence: number;
}

export class CharacterSilhouetteSolver {
    /**
     * Solves for the canonical 8-mode PCA blendshape vector (\vec{\beta}) from anatomical ratios.
     * Maps extracted 2D proportions directly into the SbHumanModel subspace [-3.0, +3.0].
     */
    public static solveBetasFromRatios(
        ratios: CharacterAnatomicalRatios,
        targetHeightMeters?: number
    ): CanonicalShapeBetas {
        const height = targetHeightMeters ?? (ratios.genderDimorphism > 0 ? 1.80 : 1.66);

        // Mode 0: Stature elongation (normalized against 1.75m neutral baseline)
        const beta0 = Math.max(-3.0, Math.min(3.0, (height - 1.75) / 0.08));

        // Mode 1: Athletic Muscularity / V-Taper (Pectorals, Lats, Quads)
        const vTaperFactor = (ratios.shoulderToHipRatio - 1.05) * 2.5;
        const beta1 = Math.max(-3.0, Math.min(3.0, ratios.muscularityScore * 1.8 + vTaperFactor));

        // Mode 2: Body Mass / BMI (Torso breadth, flanks, limb thickness)
        const massFactor = (ratios.waistCinchRatio - 0.72) * 3.2;
        const beta2 = Math.max(-3.0, Math.min(3.0, massFactor + (ratios.muscularityScore < 0 ? ratios.muscularityScore * 0.8 : 0.0)));

        // Mode 3: Sexual Dimorphic Transition (-3.0 feminine curves <-> +3.0 masculine planes)
        const bustBias = (ratios.bustVolumeScore - 0.20) * 2.2;
        const dimorphicBase = ratios.genderDimorphism * 2.4;
        const beta3 = Math.max(-3.0, Math.min(3.0, dimorphicBase - bustBias));

        // Mode 4: Torso vs Leg Length Ratio (-3.0 long torso <-> +3.0 long anime legs)
        const beta4 = Math.max(-3.0, Math.min(3.0, (ratios.legToTorsoRatio - 1.0) * 3.5));

        // Mode 5: Biacromial Shoulder Width (-3.0 narrow <-> +3.0 broad)
        const beta5 = Math.max(-3.0, Math.min(3.0, (ratios.shoulderToHipRatio - 1.05) * 3.8));

        // Mode 6: Pelvic Breadth & Gluteal Fullness (-3.0 narrow android <-> +3.0 wide gynecoid)
        const pelvicFlare = (1.08 - ratios.shoulderToHipRatio) * 3.0 + (0.78 - ratios.waistCinchRatio) * 2.5;
        const beta6 = Math.max(-3.0, Math.min(3.0, pelvicFlare));

        // Mode 7: Cranial Heads-Tall Proportion (-3.0 heroic 8.5+ <-> +3.0 chibi 4.5)
        // Neutral baseline is 7.5 heads tall
        const beta7 = Math.max(-3.0, Math.min(3.0, (7.5 - ratios.headsTall) * 1.4));

        return [
            Number(beta0.toFixed(3)),
            Number(beta1.toFixed(3)),
            Number(beta2.toFixed(3)),
            Number(beta3.toFixed(3)),
            Number(beta4.toFixed(3)),
            Number(beta5.toFixed(3)),
            Number(beta6.toFixed(3)),
            Number(beta7.toFixed(3))
        ];
    }

    /**
     * Fuses multi-view observations (e.g. Front + Side character turnarounds) into unified 3D proportions.
     * Orthogonal constraints eliminate single-view depth ambiguity:
     * - Front view provides high-confidence transverse measures (shoulder width, waist cinch, hip flare).
     * - Side view provides high-confidence sagittal measures (bust projection, gluteal shelf, spinal lordosis).
     */
    public static fuseMultiViewObservations(
        views: ViewSpecificProportions[]
    ): CharacterAnatomicalRatios {
        if (views.length === 0) {
            return {
                headsTall: 7.5,
                shoulderToHipRatio: 1.05,
                waistCinchRatio: 0.72,
                bustVolumeScore: 0.20,
                legToTorsoRatio: 1.02,
                muscularityScore: 0.0,
                genderDimorphism: 0.0
            };
        }

        const front = views.find(v => v.viewType === 'front');
        const side = views.find(v => v.viewType === 'side');
        const threeQ = views.find(v => v.viewType === 'three_quarter');

        // Heads tall: Front and Side both have clear vertical extent
        const headsValues = views.map(v => v.headsTall).filter((v): v is number => typeof v === 'number');
        const headsTall = headsValues.length > 0
            ? headsValues.reduce((a, b) => a + b, 0) / headsValues.length
            : 7.5;

        // Shoulder-to-hip ratio: Front view is authoritative; side view has no transverse resolution
        let shoulderToHipRatio = front?.shoulderToHipRatio ?? threeQ?.shoulderToHipRatio ?? 1.05;

        // Waist cinch: Front view is authoritative
        let waistCinchRatio = front?.waistCinchRatio ?? threeQ?.waistCinchRatio ?? 0.72;

        // Bust volume score: Side view is authoritative (anterior Z-depth projection)
        let bustVolumeScore = 0.20;
        if (side?.bustProjectionScore !== undefined) {
            bustVolumeScore = front?.bustProjectionScore !== undefined
                ? side.bustProjectionScore * 0.85 + front.bustProjectionScore * 0.15
                : side.bustProjectionScore;
        } else if (front?.bustProjectionScore !== undefined) {
            bustVolumeScore = front.bustProjectionScore;
        }

        // Leg to torso ratio: Front or side provide consistent vertical ratio
        const legRatios = views.map(v => v.legToTorsoRatio).filter((v): v is number => typeof v === 'number');
        const legToTorsoRatio = legRatios.length > 0
            ? legRatios.reduce((a, b) => a + b, 0) / legRatios.length
            : 1.02;

        // Muscularity
        const muscularityScores = views.map(v => v.muscularityScore).filter((v): v is number => typeof v === 'number');
        const muscularityScore = muscularityScores.length > 0
            ? muscularityScores.reduce((a, b) => a + b, 0) / muscularityScores.length
            : 0.0;

        // Gender dimorphism
        const dimorphisms = views.map(v => v.genderDimorphism).filter((v): v is number => typeof v === 'number');
        const genderDimorphism = dimorphisms.length > 0
            ? dimorphisms.reduce((a, b) => a + b, 0) / dimorphisms.length
            : (bustVolumeScore > 0.4 ? -0.8 : (shoulderToHipRatio > 1.18 ? 0.8 : 0.0));

        return {
            headsTall: Number(headsTall.toFixed(2)),
            shoulderToHipRatio: Number(shoulderToHipRatio.toFixed(3)),
            waistCinchRatio: Number(waistCinchRatio.toFixed(3)),
            bustVolumeScore: Number(bustVolumeScore.toFixed(2)),
            legToTorsoRatio: Number(legToTorsoRatio.toFixed(3)),
            muscularityScore: Number(muscularityScore.toFixed(2)),
            genderDimorphism: Number(genderDimorphism.toFixed(2))
        };
    }
}
