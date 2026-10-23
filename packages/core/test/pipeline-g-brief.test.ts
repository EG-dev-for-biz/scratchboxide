/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's building brief (pipeline-g/brief.ts): written beside the build with the massing, roof objects, faces,
 * stations with their renders, plates with their readings and fit, and the build's files; the result's buildingBrief
 * validates against the staged result's schema.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { writeBuildingBrief, BRIEF_SCHEMA } from '../src/node/3d-engine/staged-location/pipeline-g/brief';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { STAGED_LOCATION_SCHEMA } from '../src/common/spatial/staged-location-contracts';

const WALL: MassingFace = {
    index: 0, key: 'w:p:0:0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true,
    normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
    sMin: 0, sMax: 10, tMin: 0, tMax: 8, tBottom: 0, area: 80, pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: 200, height: 160, coverage: 1, openings: [], top: []
};

describe('pipeline G building brief', () => {
    it('writes what the build measured, read and rendered, with the paths to its images and files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-brief-'));
        const station = { id: 3, name: 'G_0_street_g1', positionLocalENU: [5, 1.6, 20] as [number, number, number], forwardVector: [0, 0, -1] as [number, number, number] } as never;
        const rec = writeBuildingBrief({
            dir, place: 'Test Building', groundY: 0,
            massing: { parts: [{ id: 'p', baseY: 0, topY: 8, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} }] },
            roofObjects: [], builtFaces: [WALL, { ...WALL, index: 1, key: 'b:p:0', kind: 'base' }], facades: [],
            stations: [{ station, face: 0, row: 'street', distanceM: 20, onFace: 0.4 }], renders: [{ station: 3, file: path.join(dir, 'survey', 'station_3.png') }],
            plates: [{ key: WALL.key, face: WALL, coverage: 0.8, widthM: 10, heightM: 8, colour: '/x/face_0_colour.png', relief: '/x/face_0_relief.png', program: { wallColour: '#aa8866', openings: [{ h0: 1, h1: 3, cols: [[1, 2]] }] }, check: { explained: 0.2, lift: 4, weak: false } as never }],
            roofPlates: [], files: { clayGlb: '/x/clay.glb', texturedGlb: '/x/tex.glb' },
            steps: [{ step: 'facade reading', proposed: 1, accepted: 1, rejected: 0, notes: ['ok'], ms: 1 }]
        });
        expect(rec.images).toBe(3);
        const b = JSON.parse(fs.readFileSync(rec.path, 'utf8'));
        expect(b.schema).toBe(BRIEF_SCHEMA);
        expect(b.faces.map((f: { kind: string }) => f.kind)).toEqual(['wall']);
        expect(b.massing[0].loops[0]).toHaveLength(4);
        expect(b.stations[0]).toMatchObject({ name: 'G_0_street_g1', row: 'street', render: path.join(dir, 'survey', 'station_3.png') });
        expect(b.plates[0].reading.openings[0].cols).toEqual([[1, 2]]);
        expect(b.plates[0].readingFit).toEqual({ explains: 0.2, lift: 4, weak: false });
        expect(b.build.clayGlb).toBe('/x/clay.glb');
        // the result's field validates against the staged result schema's property
        const prop = (STAGED_LOCATION_SCHEMA.definitions.StagedLocationResult as { properties: Record<string, { required?: string[] }> }).properties.buildingBrief;
        expect(prop.required).toEqual(['path', 'images']);
    });
});
