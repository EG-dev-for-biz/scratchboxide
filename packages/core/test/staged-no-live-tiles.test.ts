/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { liveTilesAnchorProblem, sceneAsksForLiveTiles } from '../src/browser/generative-canvas/primitives/scene3d/liveTilesAnchor';

// A staged scene as composeStagedArtifact writes it: the place's anchor (here the Flatiron Building), the photoreal
// ground mode, and the build's state.
const FLATIRON = { lat: 40.74106, lng: -73.989699, elevation: 10 };
const staged = { geoAnchor: FLATIRON, groundTileMode: 'photoreal-clay', objects: [{ id: 'layer-0', content: { type: 'glb' } }], stagedBuild: { runId: 'ee634ff6', layers: [] } } as any;

describe('a staged build never streams live tiles', () => {
    it('asks for no live tiles, whatever ground tile mode it carries', () => {
        expect(sceneAsksForLiveTiles(staged)).toBe(false);
        expect(sceneAsksForLiveTiles({ ...staged, groundTileMode: 'photoreal-textured' })).toBe(false);
        // and so has no anchor problem to report: its anchor is used for the sun and weather, not for tiles
        expect(liveTilesAnchorProblem({ ...staged, geoAnchor: { lat: 0, lng: 0 } })).toBeNull();
    });

    it('a scene that is not a staged build still streams them from its anchor or a map-3d object', () => {
        const { stagedBuild: _omit, ...plain } = staged;
        expect(sceneAsksForLiveTiles(plain)).toBe(true);
        expect(sceneAsksForLiveTiles({ objects: [{ id: 'm', content: { type: 'map-3d' } }] } as any)).toBe(true);
        expect(sceneAsksForLiveTiles({ geoAnchor: { ...FLATIRON, active: false }, objects: [] } as any)).toBe(false);
        expect(liveTilesAnchorProblem({ geoAnchor: { lat: 0, lng: 0 }, objects: [] } as any)).toMatch(/unset location/);
    });
});
