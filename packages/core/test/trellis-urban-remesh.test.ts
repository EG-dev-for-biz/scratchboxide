/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('3D Scene vs Discrete Object Capability Policy', () => {
    it('resolves 3D scenes, urban blocks, and architectural footprints natively in the C++ engine', () => {
        const res = TaskCapabilityResolver.resolveTaskCapability(
            'Remesh noisy Google Maps 3D tile with building footprint vector map and create urban architectural district'
        );

        expect(res.tier1Assessment.canSolveNatively).toBe(true);
        expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
    });

    it('reports neural image-to-3D prop reconstruction as not natively solvable', () => {
        const res = TaskCapabilityResolver.resolveTaskCapability(
            'Reconstruct 3D prop chair from photo using Trellis image-to-3d diffusion model',
            { hasInputImage: true }
        );

        expect(res.tier1Assessment.canSolveNatively).toBe(false);
        expect(res.tier1Assessment.primaryNativeEngine).toBe('none');
        expect(res.tier1Assessment.rationale).not.toBe('');
    });
});
