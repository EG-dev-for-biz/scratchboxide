/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

/**
 * The model must not be able to switch a tool into offline mock mode: a mock result is placeholder data,
 * and mounting it as the user's answer is a fabricated result. Offline mocks stay a service option for
 * unit tests only. (google_3d_tiles_get_clay / get_full_texture are handled with their handlers.)
 */
describe('model-facing tool declarations', () => {
    it('no declaration offers mockExecution', () => {
        const pending = new Set(['google_3d_tiles_get_clay', 'google_3d_tiles_get_full_texture']);
        const offenders = createDefaultToolRegistry().declarations()
            .filter(d => !pending.has(d.name))
            .filter(d => Object.prototype.hasOwnProperty.call((d.parameters as any)?.properties ?? {}, 'mockExecution'))
            .map(d => d.name);
        expect(offenders).toEqual([]);
    });
});
