/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every generated reference or plate of a real place is obstruction-free by default (trees, vehicles, people, street
 * furniture in front of the subject are not drawn; trees come back via SB-Veggie): each image-model prompt builder carries
 * the one shared note, and buildBeautifyPrompt keeps its camera-framing rules alongside it.
 */

import { describe, expect, it } from 'vitest';
import {
    buildBeautifyPrompt, buildHybridBeautifyPrompt, buildLocationBeautifyPrompt, buildStreetViewSeedBeautifyPrompt,
    buildTexturePlatePrompt, OBSTRUCTION_FREE_NOTE, obstructionFreeNote, streetViewObstructionsNote
} from '../src/browser/generative-canvas/services/location-beautify-service';
import { groundedReferencePrompt } from '../src/node/spatial/search-grounded-reference';
import { enhancePrompt, recreatePrompt } from '../src/node/3d-engine/staged-location/texture-enhance';
import { roofPlatePrompt } from '../src/node/3d-engine/staged-location/pipeline-g/roof-texture';

const coordinates = { lat: 40.7223, lng: -73.999 };

describe('obstruction-free generated references', () => {
    it('the note names trees and the other obstructions, and says trees are added separately', () => {
        for (const w of ['trees', 'vehicles', 'people', 'street furniture', 'scaffolding', 'added to the scene separately']) expect(OBSTRUCTION_FREE_NOTE).toContain(w);
    });

    it('the tile-render beautify prompts carry it, and buildBeautifyPrompt keeps its framing rules', () => {
        const b = buildBeautifyPrompt({ locationName: 'X', coordinates, heading: 90 });
        expect(b).toContain(OBSTRUCTION_FREE_NOTE);
        expect(b).toContain('Preserve the EXACT same camera angle');
        expect(b).toContain('do not pan, zoom, crop, recompose, or change the horizon line');
        expect(buildLocationBeautifyPrompt({ locationName: 'X', coordinates } as never)).toContain(OBSTRUCTION_FREE_NOTE);
        expect(buildHybridBeautifyPrompt({ locationName: 'X', coordinates, heading: 90 } as never)).toContain(OBSTRUCTION_FREE_NOTE);
    });

    it('wall, roof, albedo and search-grounded prompts carry it for their own surface', () => {
        expect(buildTexturePlatePrompt({ locationName: 'X', widthM: 10, heightM: 20, widthPx: 200, heightPx: 400, preserveClause: '' })).toContain(obstructionFreeNote('this wall'));
        expect(roofPlatePrompt({ locationName: 'X', widthM: 10, heightM: 10, widthPx: 200, heightPx: 200 })).toContain(obstructionFreeNote('the roof'));
        expect(enhancePrompt(64, 64, 0)).toContain(obstructionFreeNote('this surface'));
        expect(recreatePrompt(64, 64, 1)).toContain(obstructionFreeNote('this surface'));
        expect(groundedReferencePrompt({ subject: 'the facade', place: 'X' } as never)).toContain(OBSTRUCTION_FREE_NOTE);
    });

    it('the Street View seed prompt keeps its own, stronger clearing note', () => {
        const station = { coordinatesWGS84: { lat: coordinates.lat, lng: coordinates.lng }, yawDegrees: 90, pitchDegrees: 0 } as never;
        expect(buildStreetViewSeedBeautifyPrompt(station, { locationName: 'X' })).toContain(streetViewObstructionsNote('X'));
    });
});
