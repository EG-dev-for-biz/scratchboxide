/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Optional film grain on the scene lens (camera.lens.filmGrain): drawn by the viewport's output pass only when its amount
 * is above 0, validated by sb_set_camera_lens, off unless asked for.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAIN_SIZE_UM, planViewportOptics } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { mergeCameraLens } from '../src/browser/generative-canvas/services/operators/lighting-camera-operators';

describe('film grain on the scene lens', () => {
    it('draws only when asked for, with its defaults filled in', () => {
        expect(planViewportOptics(undefined).filmGrain).toBeNull();
        expect(planViewportOptics({ focalLengthMm: 50 }).passes).toEqual([]);
        expect(planViewportOptics({ filmGrain: { amount: 0 } }).passes).toEqual([]);
        const plan = planViewportOptics({ filmGrain: { amount: 0.4 } });
        expect(plan.passes).toEqual(['film-grain', 'output']);
        // grain alone asks for no depth of field
        expect(plan.issues).toEqual([]);
        expect(plan.filmGrain).toEqual({ amount: 0.4, sizeUm: DEFAULT_GRAIN_SIZE_UM, chroma: 0, animate: true });
        expect(planViewportOptics({ filmGrain: { amount: 0.2, sizeUm: 12, chroma: 0.3, animate: false } }).filmGrain).toEqual({ amount: 0.2, sizeUm: 12, chroma: 0.3, animate: false });
    });

    it('merges grain fields into the lens, removes it with null, and refuses values out of range', () => {
        const on = mergeCameraLens(undefined, { filmGrain: { amount: 0.35 } }, 45)!;
        expect(on.filmGrain).toEqual({ amount: 0.35 });
        const sized = mergeCameraLens(on, { filmGrain: { sizeUm: 10 } }, 45)!;
        expect(sized.filmGrain).toEqual({ amount: 0.35, sizeUm: 10 });
        expect(mergeCameraLens(sized, { filmGrain: null }, 45)).toBeUndefined();
        expect(() => mergeCameraLens(on, { filmGrain: { amount: 1.5 } }, 45)).toThrow(/amount/);
        expect(() => mergeCameraLens(on, { filmGrain: { sizeUm: 0 } }, 45)).toThrow(/sizeUm/);
        expect(() => mergeCameraLens(on, { filmGrain: { chroma: -0.1 } }, 45)).toThrow(/chroma/);
    });
});
