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
import { compactJson, COMPACT_WIDTH, writeBuildingBrief, BRIEF_SCHEMA } from '../src/node/3d-engine/staged-location/pipeline-g/brief';
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
        // short, a handful of faces and one plate: readable in one workspace_view_file call, not thousands of lines
        expect(fs.readFileSync(rec.path, 'utf8').split('\n').length).toBeLessThan(150);
        // the result's field validates against the staged result schema's property
        const prop = (STAGED_LOCATION_SCHEMA.definitions.StagedLocationResult as { properties: Record<string, { required?: string[] }> }).properties.buildingBrief;
        expect(prop.required).toEqual(['path', 'images']);
    });
});

describe('compactJson', () => {
    it('keeps a value that fits on one line exactly as JSON.stringify would, however nested', () => {
        const value = { origin: [1.5, 0, -2.25], nested: { a: [1, 2], b: { c: 3 } }, empty: [], emptyObj: {}, omitted: undefined };
        const out = compactJson(value);
        expect(out).toBe(JSON.stringify(value));
        expect(JSON.parse(out)).toEqual({ origin: [1.5, 0, -2.25], nested: { a: [1, 2], b: { c: 3 } }, empty: [], emptyObj: {} });
        expect(out).not.toContain('omitted');
    });

    it('expands only a value whose compact form runs past COMPACT_WIDTH, one line per element or property, each compacted again', () => {
        // an array of 20 small objects: compact as a whole is long, but each object alone is short and stays one line
        const faces = Array.from({ length: 20 }, (_, i) => ({ key: `w:${i}`, origin: [i, 0, -i || 0], normal: [0, 0, 1] }));
        const value = { place: 'Test Building', faces };
        const out = compactJson(value);
        expect(JSON.stringify(value).length).toBeGreaterThan(COMPACT_WIDTH);
        expect(JSON.parse(out)).toEqual(value);
        const lines = out.split('\n');
        // one line per face, each still compact (the per-face flat form), none of them exploded further
        expect(lines.filter(l => /^\s*\{"key":"w:\d+","origin":\[\d+,0,-?\d+\],"normal":\[0,0,1\]\},?$/.test(l))).toHaveLength(20);
        // far fewer lines than the old per-number pretty-printer would have produced for the same data (20 x ~9 lines)
        expect(lines.length).toBeLessThan(30);
    });

    it('expands a value whose own compact form is still too long, nesting the expansion', () => {
        const longRing = Array.from({ length: 60 }, (_, i) => [i * 0.37, (-i * 1.1) || 0]);
        const value = { loops: [longRing] };
        const out = compactJson(value);
        expect(JSON.parse(out)).toEqual(value);
        // the ring itself exceeds the width, so it expands one pair per line; the outer "loops" and inner pair stay compact
        expect(out).toContain('"loops": [\n');
        expect(out).toMatch(/\n\s+\[0,0\],\n\s+\[0\.37,-1\.1\],/);
    });
});
