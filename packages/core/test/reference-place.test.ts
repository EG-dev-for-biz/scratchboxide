/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeReference, referenceFromOverlay } from '../src/node/3d-engine/reference-place';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import type { MapVectorOverlay, MapVec2 } from '../src/common/spatial/map-data-view';

// Formula check: an east-west street along z = 0, with a row of blocks 9 m north of its centreline (fronts at z = -9)
// and 12 m south (fronts at z = 12): every station measures 21 m front to front, 9 left and 12 right of the drawing direction.
const block = (x0: number, z0: number, w: number, d: number): MapVec2[] => [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]];
const overlay: MapVectorOverlay = {
    schema: 'scratchbox.map-vector/1' as never, origin: { lat: 40.75, lng: -73.99 }, radiusM: 100, zoom: 17, tiles: 4,
    roads: [{ points: [[-80, 0], [80, 0]], types: ['FEATURE_TYPE_ROAD'] }, { points: [[0, -80], [0, -40]], types: ['FEATURE_TYPE_ROAD'] }],
    carriageways: [],
    footprints: [
        ...[-80, -40, 0, 40].map((x, i) => ({ id: `n${i}`, loops: [block(x, -39, 36, 30)], heightM: 20 + 10 * i })),
        ...[-80, -40, 0, 40].map((x, i) => ({ id: `s${i}`, loops: [block(x, 12, 36, 25)] }))
    ],
    areas: [{ loops: [block(-90, 60, 30, 30)], types: ['FEATURE_TYPE_NATURAL'] }],
    rails: [], pois: [{ x: 5, z: 5, types: ['FEATURE_TYPE_POINT_OF_INTEREST'], name: 'a cafe' }],
    provenance: { vector: 'test overlay', widths: '', ground: '' }
};
const place = { query: 'test', resolvedAs: 'test street', lat: 40.75, lng: -73.99 };

describe('a real place as a reference', () => {
    afterEach(() => { delete process.env.SCRATCHBOX_REFERENCE_JSON; });

    it('measures streets front to front, and the heights, footprint areas, built share and grid bearing', () => {
        const r = referenceFromOverlay(overlay, place);
        const main = r.streets[0];
        expect(main.lengthM).toBe(160);
        expect(main.frontageWidthM).toBeCloseTo(21, 6);
        expect(main.frontageLeftM).toBeCloseTo(9, 6);   // left of an eastward street is north (-z)
        expect(main.frontageRightM).toBeCloseTo(12, 6);
        expect(main.frontageSamples).toBeGreaterThan(10);
        expect(r.stats.buildings).toBe(8);
        expect(r.stats.buildingsWithHeight).toBe(4);
        expect(r.stats.heightM).toMatchObject({ p10: 20, max: 50, count: 4 });
        expect(r.stats.footprintAreaM2!.max).toBe(1080);
        // the blocks inside the 100 m disk, on a 2 m grid: close to their clipped area over the disk's
        expect(r.stats.builtShare).toBeGreaterThan(0.2);
        expect(r.stats.builtShare).toBeLessThan((4 * 1080 + 4 * 900) / (Math.PI * 100 * 100));
        // east-west and north-south streets: a grid square to north
        const g = r.stats.gridBearingDeg!;
        expect(Math.min(g, 90 - g)).toBeLessThan(1);
        expect(r.buildings[0].centroid[0]).toBeCloseTo(-62, 6);
        expect(r.pois[0].name).toBe('a cafe');
        expect(describeReference(r)).toContain('street widths front to front');
    });

    it('counts overlapping parts of one building once in the built share', () => {
        const stacked = { ...overlay, footprints: [{ id: 'a', loops: [block(-20, -20, 40, 40)] }, { id: 'a2', loops: [block(-20, -20, 40, 40)], heightM: 60 }] };
        const r = referenceFromOverlay(stacked, place);
        expect(r.stats.builtShare).toBeCloseTo(1600 / (Math.PI * 100 * 100), 2);
    });

    it('a street with a building on one side only gets no width', () => {
        const oneSided = { ...overlay, footprints: overlay.footprints.filter(f => f.id.startsWith('n')) };
        const r = referenceFromOverlay(oneSided, place);
        expect(r.streets[0].frontageWidthM).toBeUndefined();
        expect(r.streets[0].frontageSamples).toBe(0);
    });

    it('reaches the script as sb.reference(), in snake case', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ref-test-')), 'reference.json');
        fs.writeFileSync(file, JSON.stringify(referenceFromOverlay(overlay, place)));
        process.env.SCRATCHBOX_REFERENCE_JSON = file;
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: [
                'import scratchbox as sb',
                'ref = sb.reference()',
                'w = ref["stats"]["street_frontage_width_m"]["p50"]',
                'assert abs(w - 21.0) < 1e-6, w',
                'assert ref["streets"][0]["frontage_left_m"] == 9.0',
                'assert ref["frame"].startswith("x east, z south")',
                'scene = sb.geometry.Mesh("Street")',
                'for b in ref["buildings"]:',
                '    h = b.get("height_m") or ref["stats"]["height_m"]["p50"]',
                '    box = sb.create_box(width=30, height=h, depth=20)',
                '    box.translate(b["centroid"][0], h / 2, b["centroid"][1])',
                '    scene.merge(box)',
                'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
            ].join('\n'),
            description: 'Reference probe'
        });
        expect(outcome.status).toBe('completed');
    }, 120_000);
});
