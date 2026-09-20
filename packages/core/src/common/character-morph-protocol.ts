/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type CharacterMorphViewType = 'front' | 'side' | 'three_quarter' | 'back' | 'auto';

export interface CharacterImageSource {
    /** Raw base64 data, data URL (data:image/png;base64,...), or absolute file path */
    imageData: string;
    /** View angle orientation hint */
    viewType?: CharacterMorphViewType;
    /** MIME type (e.g. image/png, image/jpeg, image/webp) */
    mimeType?: string;
    /** Image dimensions if known */
    width?: number;
    height?: number;
}

/**
 * Normalized anatomical ratios extracted from 2D character concept art
 */
export interface CharacterAnatomicalRatios {
    /** Total body height measured in head units (4.0 = Chibi, 6.5 = Manga, 7.5 = Standard, 8.5 = Heroic) */
    headsTall: number;
    /** Biacromial shoulder width divided by biiliac pelvic width (>1.15 = V-taper, <0.95 = Hourglass) */
    shoulderToHipRatio: number;
    /** Narrowest waist width divided by maximum pelvic width (0.55 = Deep cinch, 0.85 = Athletic block) */
    waistCinchRatio: number;
    /** Bust / pectoral anterior projection score [0.0 = flat/male plate, 0.5 = moderate teardrop, 1.0 = voluminous] */
    bustVolumeScore: number;
    /** Inseam leg length divided by torso height [0.9 = compact, 1.0 = realistic, 1.25 = long-legged anime] */
    legToTorsoRatio: number;
    /** Muscular definition and contour fullness [-1.0 = slender/lithe, 0.0 = standard, +1.0 = heavy athletic] */
    muscularityScore: number;
    /** Morphological dimorphism [-1.0 = full feminine curves, 0.0 = neutral drawing figure, +1.0 = masculine planes] */
    genderDimorphism: number;
    /** Cranium width relative to height [0.65 = slender anime face, 0.80 = realistic oval] */
    headWidthToHeightRatio?: number;
}

/**
 * 8-Mode PCA Blendshape Vector corresponding to SbHumanModel:
 *   [0]: Stature / Height elongation
 *   [1]: Athletic Muscularity / V-Taper (Pectorals, Lats, Quads)
 *   [2]: Body Mass / BMI (Torso, Flanks, Limb thickness)
 *   [3]: Dimorphic Transition (-3.0 feminine hourglass <-> +3.0 masculine planes)
 *   [4]: Torso vs Leg Length Ratio (-3.0 long torso <-> +3.0 long legs)
 *   [5]: Biacromial Shoulder Width (-3.0 narrow <-> +3.0 broad)
 *   [6]: Pelvic Breadth & Gluteal Fullness (-3.0 narrow <-> +3.0 wide)
 *   [7]: Cranial Heads-Tall Proportion (-3.0 heroic 8.5 <-> +3.0 chibi 4.5)
 */
export type CanonicalShapeBetas = [number, number, number, number, number, number, number, number];

export interface CharacterMorphRequest {
    /** 1 to 4 images representing the character (single illustration, turnaround sheet, etc.) */
    images: CharacterImageSource[];
    /** Optional manual gender override or hint */
    genderHint?: 'male' | 'female' | 'neutral' | 'auto';
    /** Optional stylization aesthetic hint */
    styleHint?: 'anime' | 'realistic' | 'stylized' | 'chibi' | 'auto';
    /** Target metric height in meters (defaults: 1.80m for male, 1.66m for female, 1.75m for neutral) */
    heightMeters?: number;
}

export interface CharacterMorphResponse {
    success: boolean;
    ratios: CharacterAnatomicalRatios;
    betas: CanonicalShapeBetas;
    confidence: number;
    explanation: string;
    matchedArchetype: string;
    error?: string;
}
