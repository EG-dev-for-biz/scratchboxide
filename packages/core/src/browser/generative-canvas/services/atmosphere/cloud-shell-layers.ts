/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Validation and GPU packing for shell cloud decks (`CloudShellLayer`). The sky dome intersects each view ray with a
 * few Earth-concentric spheres per deck and composites them back to front; there is no raymarch, so a deck costs a
 * handful of noise lookups per pixel whatever its distance.
 */

import { CloudShellLayer } from './atmosphere-types';
import { InvalidInputError } from '../../../../common/errors/pipeline-errors';

/** Decks the sky shader holds at once. */
export const MAX_CLOUD_SHELL_LAYERS = 4;
/** Shells per deck the sky shader steps through. */
export const MAX_SHELLS_PER_LAYER = 8;
const METERS_PER_SHELL = 400;

export interface PackedCloudShellLayer {
    baseAltitudeMeters: number;
    thicknessMeters: number;
    coverage: number;
    opticalDepth: number;
    featureSizeMeters: number;
    streakElongation: number;
    streakHeadingRad: number;
    forwardScattering: number;
    scatteringAlbedo: [number, number, number];
    shellCount: number;
    windSpeedMetersPerSecond: number;
}

function finite(tool: string, path: string, v: unknown, ok: (n: number) => boolean, range: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) {
        throw new InvalidInputError(tool, `${path} (${JSON.stringify(v)})`, `must be a number ${range}`);
    }
    return v;
}

/**
 * Checks every deck and resolves its optional fields, highest deck first (the order the shader composites them in).
 * Any out-of-range value is an `InvalidInputError` naming the field; nothing is clamped or dropped.
 */
export function resolveCloudShellLayers(layers: unknown, tool = 'cloudLayers'): PackedCloudShellLayer[] {
    if (layers === undefined || layers === null) return [];
    if (!Array.isArray(layers)) throw new InvalidInputError(tool, 'cloudLayers', 'must be an array of cloud decks');
    if (layers.length > MAX_CLOUD_SHELL_LAYERS) {
        throw new InvalidInputError(tool, `cloudLayers (${layers.length} decks)`, `the sky draws at most ${MAX_CLOUD_SHELL_LAYERS}; merge decks that share an altitude`);
    }
    const packed = layers.map((raw, i): PackedCloudShellLayer => {
        if (typeof raw !== 'object' || raw === null) throw new InvalidInputError(tool, `cloudLayers[${i}]`, 'must be an object');
        const l = raw as CloudShellLayer;
        const at = (k: string) => `cloudLayers[${i}].${k}`;
        const thicknessMeters = finite(tool, at('thicknessMeters'), l.thicknessMeters, n => n >= 0, '>= 0');
        const shellCount = l.shellCount === undefined
            ? Math.min(MAX_SHELLS_PER_LAYER, Math.max(1, Math.round(thicknessMeters / METERS_PER_SHELL)))
            : finite(tool, at('shellCount'), l.shellCount, n => Number.isInteger(n) && n >= 1 && n <= MAX_SHELLS_PER_LAYER, `, an integer 1-${MAX_SHELLS_PER_LAYER}`);
        const albedo = l.scatteringAlbedo ?? [1, 1, 1];
        if (!Array.isArray(albedo) || albedo.length !== 3) throw new InvalidInputError(tool, at('scatteringAlbedo'), 'must be [r, g, b]');
        return {
            baseAltitudeMeters: finite(tool, at('baseAltitudeMeters'), l.baseAltitudeMeters, n => n > 0, '> 0'),
            thicknessMeters,
            coverage: finite(tool, at('coverage'), l.coverage, n => n >= 0 && n <= 1, 'in 0-1'),
            opticalDepth: finite(tool, at('opticalDepth'), l.opticalDepth, n => n > 0, '> 0'),
            featureSizeMeters: finite(tool, at('featureSizeMeters'), l.featureSizeMeters, n => n > 0, '> 0'),
            streakElongation: l.streakElongation === undefined ? 1 : finite(tool, at('streakElongation'), l.streakElongation, n => n >= 1, '>= 1'),
            streakHeadingRad: (l.streakHeadingDeg === undefined ? 0 : finite(tool, at('streakHeadingDeg'), l.streakHeadingDeg, () => true, '')) * Math.PI / 180,
            forwardScattering: l.forwardScattering === undefined ? 0.75 : finite(tool, at('forwardScattering'), l.forwardScattering, n => n > -1 && n < 1, 'in (-1, 1)'),
            scatteringAlbedo: albedo.map((a, c) => finite(tool, `${at('scatteringAlbedo')}[${c}]`, a, n => n >= 0 && n <= 1, 'in 0-1')) as [number, number, number],
            shellCount,
            windSpeedMetersPerSecond: l.windSpeedMetersPerSecond === undefined ? 0 : finite(tool, at('windSpeedMetersPerSecond'), l.windSpeedMetersPerSecond, () => true, '')
        };
    });
    return packed.sort((a, b) => (b.baseAltitudeMeters + b.thicknessMeters) - (a.baseAltitudeMeters + a.thicknessMeters));
}

/** The sky shader's uniform arrays for resolved decks (unused slots zeroed). */
export function cloudShellUniformArrays(layers: PackedCloudShellLayer[]): { count: number; a: number[][]; b: number[][]; c: number[][] } {
    const a: number[][] = [], b: number[][] = [], c: number[][] = [];
    for (let i = 0; i < MAX_CLOUD_SHELL_LAYERS; i++) {
        const l = layers[i];
        a.push(l ? [l.baseAltitudeMeters, l.thicknessMeters, l.coverage, l.opticalDepth] : [0, 0, 0, 0]);
        b.push(l ? [l.featureSizeMeters, l.streakElongation, l.streakHeadingRad, l.forwardScattering] : [1, 1, 0, 0]);
        c.push(l ? [...l.scatteringAlbedo, l.shellCount] : [0, 0, 0, 1]);
    }
    return { count: layers.length, a, b, c };
}

/** Per-deck wind speeds, in shader slot order. */
export function cloudShellWindSpeeds(layers: PackedCloudShellLayer[]): number[] {
    return Array.from({ length: MAX_CLOUD_SHELL_LAYERS }, (_, i) => layers[i]?.windSpeedMetersPerSecond ?? 0);
}
