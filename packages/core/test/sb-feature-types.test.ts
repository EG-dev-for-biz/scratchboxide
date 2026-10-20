/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sb-feature/1 model: the code list is well formed, the vocabulary is open (unknown codes kept and reported, never
 * added), Google's decoded features pass through unchanged, and no execution code branches on one of our codes (a code is
 * a label for prompting, filtering and export, never a geometry path).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { featureCodeEntry, featureCodeIsA, featureCodeLineage, reviewUnknownCodes, SB_FEATURE_CODES, SB_FEATURE_PREFIX, sbFeatureFromGoogle, typesFromLabels } from '../src/common/spatial/sb-feature-types';
import { decodeFeatureTile } from '../src/node/spatial/google-feature-tile-decoder';

describe('sb-feature/1 code list', () => {
    it('every code is prefixed, unique, described, has a known parent and an export mapping field', () => {
        const codes = SB_FEATURE_CODES.map(c => c.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const c of SB_FEATURE_CODES) {
            expect(c.code.startsWith(SB_FEATURE_PREFIX)).toBe(true);
            expect(c.code).toMatch(/^[A-Z0-9_]+$/);
            expect(c.description.length).toBeGreaterThan(5);
            expect(c.export).toBeTypeOf('object');
            if (c.code !== 'SB_FEATURE_TYPE_OBJECT') expect(featureCodeEntry(c.parent!), `${c.code} parent ${c.parent}`).toBeDefined();
            expect(featureCodeLineage(c.code)[0]).toBe('SB_FEATURE_TYPE_OBJECT');
        }
        expect(featureCodeIsA('SB_FEATURE_TYPE_ROOF_OBJECT_TANK', 'SB_FEATURE_TYPE_ROOF_OBJECT')).toBe(true);
        expect(featureCodeIsA('SB_FEATURE_TYPE_SCAN_ARTEFACT_SPIKE', 'SB_FEATURE_TYPE_ROOF_OBJECT')).toBe(false);
    });

    it('is open: an unknown code is kept on the feature and reported for review, never added to the list', () => {
        const before = SB_FEATURE_CODES.length;
        const logged: string[] = [];
        const types = typesFromLabels([{ code: 'SB_FEATURE_TYPE_ROOF_OBJECT_BIOLUMINESCENT_SPORE_STACK', confidence: 0.4 }, { code: 'FEATURE_TYPE_BUILDING', confidence: 1 }]);
        expect(types).toEqual(['SB_FEATURE_TYPE_ROOF_OBJECT_BIOLUMINESCENT_SPORE_STACK', 'FEATURE_TYPE_BUILDING']);
        expect(reviewUnknownCodes(types, c => logged.push(c))).toEqual(['SB_FEATURE_TYPE_ROOF_OBJECT_BIOLUMINESCENT_SPORE_STACK']);
        expect(logged).toHaveLength(1);
        expect(SB_FEATURE_CODES.length).toBe(before);
    });
});

describe("Google's decoded features carried unchanged", () => {
    it('keeps the types, geometry blocks, name and place id as received', () => {
        const raw = {
            types: ['FEATURE_TYPE_BUILDING', 'FEATURE_TYPE_ESTABLISHMENT'], placeId: 'ChIJxyz',
            geometry: { extrudedAreas: [{ area: { type: 'TRIANGLES', vertexOffsets: { xOffsets: [100, 50, -50], yOffsets: [100, 0, 50] }, loopBreaks: [0] }, minZ: 0, maxZ: 20 }], modeledVolumes: [] },
            labels: [{ textComponents: [{ texts: [{ text: 'A Building' }] }] }]
        };
        const f = sbFeatureFromGoogle(raw, '17/1/2/f0', { x: 1, y: 2, zoom: 17 });
        expect(f.types).toEqual(raw.types);
        expect(f.geometry.extrudedAreas).toEqual(raw.geometry.extrudedAreas);
        expect(f.displayName).toBe('A Building');
        expect(f.placeId).toBe('ChIJxyz');
        const tile = decodeFeatureTile({ x: 1, y: 2, zoom: 17, features: [raw] });
        expect(tile.features).toHaveLength(1);
        expect(tile.features[0].types).toEqual(raw.types);
        expect(tile.features[0].geometry.extrudedAreas).toEqual(raw.geometry.extrudedAreas);
    });
});

describe('no code selects a geometry path (ADA guardrail)', () => {
    it('no execution code compares, switches on or matches one of our type codes outside the model file', () => {
        const root = path.resolve(__dirname, '../src');
        const files: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|hpp|cpp)$/.test(e.name)) files.push(p); } };
        walk(root);
        walk(path.resolve(__dirname, '../../../scripts'));
        const branching = [
            /(===|!==|==|!=)\s*['"`]SB_FEATURE_TYPE_/, /['"`]SB_FEATURE_TYPE_[A-Z0-9_]*['"`]\s*(===|!==|==|!=)/, /case\s+['"`]SB_FEATURE_TYPE_/,
            /\.(includes|startsWith|endsWith|indexOf|match|test)\(\s*['"`/^]*SB_FEATURE_TYPE_/, /SB_FEATURE_TYPE_[A-Z0-9_]*\/[a-z]*\.test\(/,
            /featureCodeIsA\(/, /featureCodeLineage\([^)]*\)\s*\.\s*(includes|some|indexOf)/
        ];
        const offenders: string[] = [];
        for (const f of files) {
            if (f.endsWith(path.join('common', 'spatial', 'sb-feature-types.ts'))) continue;
            const text = fs.readFileSync(f, 'utf8');
            text.split('\n').forEach((line, i) => { if (branching.some(r => r.test(line))) offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`); });
        }
        expect(offenders).toEqual([]);
    });
});
