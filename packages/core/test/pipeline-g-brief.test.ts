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

    it('publishes brief.json and its images to publicDir, outside the chat tools\' .scratchbox/cache IGNORED_DIRS block, leaving a missing image\'s path unchanged', () => {
        // the "cache" source tree (stands for .scratchbox/cache, which workspace_view_file/workspace_view_image refuse):
        // two plates' colour images happen to share a basename (two different faces' dirs), one render, no roof plate file.
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-brief-cache-'));
        const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-brief-public-'));
        const renderSrc = path.join(cacheDir, 'survey', 'station_3.png');
        fs.mkdirSync(path.dirname(renderSrc), { recursive: true });
        fs.writeFileSync(renderSrc, 'render-bytes');
        const colourA = path.join(cacheDir, 'a', 'face_0_colour.png'), colourB = path.join(cacheDir, 'b', 'face_0_colour.png');
        fs.mkdirSync(path.dirname(colourA), { recursive: true }); fs.writeFileSync(colourA, 'colour-a');
        fs.mkdirSync(path.dirname(colourB), { recursive: true }); fs.writeFileSync(colourB, 'colour-b');
        const station = { id: 3, name: 'G_0_street_g1', positionLocalENU: [5, 1.6, 20] as [number, number, number], forwardVector: [0, 0, -1] as [number, number, number] } as never;
        const walls = [WALL, { ...WALL, index: 2, key: 'w:p:0:1' }];
        const rec = writeBuildingBrief({
            dir: cacheDir, publicDir, place: 'Test Building', groundY: 0,
            massing: { parts: [{ id: 'p', baseY: 0, topY: 8, loops: [[[0, 0], [10, 0], [10, -6], [0, -6]]], planes: [], heightSource: 'vector', heights: {} }] },
            roofObjects: [], builtFaces: walls, facades: [],
            stations: [{ station, face: 0, row: 'street', distanceM: 20, onFace: 0.4 }], renders: [{ station: 3, file: renderSrc }],
            plates: [
                { key: walls[0].key, face: walls[0], coverage: 0.8, widthM: 10, heightM: 8, colour: colourA, relief: path.join(cacheDir, 'missing_relief.png') },
                { key: walls[1].key, face: walls[1], coverage: 0.5, widthM: 10, heightM: 8, colour: colourB, relief: path.join(cacheDir, 'also_missing.png') }
            ],
            roofPlates: [], files: { clayGlb: '/x/clay.glb', texturedGlb: '/x/tex.glb' },
            steps: []
        });
        // brief.json itself lives under publicDir, not the cache dir
        expect(path.dirname(rec.path)).toBe(publicDir);
        expect(fs.existsSync(path.join(cacheDir, 'brief.json'))).toBe(false);
        const b = JSON.parse(fs.readFileSync(rec.path, 'utf8'));
        // the render and both colour images were copied into publicDir, their content intact, never left pointing into cacheDir
        const render = b.stations[0].render as string;
        expect(path.dirname(render)).toBe(publicDir);
        expect(fs.readFileSync(render, 'utf8')).toBe('render-bytes');
        const [c0, c1] = [b.plates[0].colourImage as string, b.plates[1].colourImage as string];
        expect(path.dirname(c0)).toBe(publicDir); expect(path.dirname(c1)).toBe(publicDir);
        expect(fs.readFileSync(c0, 'utf8')).toBe('colour-a'); expect(fs.readFileSync(c1, 'utf8')).toBe('colour-b');
        // same basename from two different source dirs: the second copy is renamed, not overwritten or dropped
        expect(c0).not.toBe(c1);
        expect(path.basename(c0)).toBe('face_0_colour.png');
        expect(path.basename(c1)).toBe('face_0_colour_2.png');
        // a reliefImage that was never written stays as its original (missing) path rather than breaking the brief
        expect(b.plates[0].reliefImage).toBe(path.join(cacheDir, 'missing_relief.png'));
        expect(fs.existsSync(b.plates[0].reliefImage)).toBe(false);
        expect(rec.images).toBe(5);
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
