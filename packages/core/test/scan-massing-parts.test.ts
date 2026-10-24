/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan-led massing as the parts pipeline H builds its facades on (scan-massing.ts asMassingParts), built by the
 * native tool: a block with objects on its roof, one of them hard against a wall and one crossing it, keeps its walls
 * whole (an object on the roof cannot cover a wall, so it does not cut it: the Haughwout block came out as 64 slivers),
 * every raised outline stays inside the walls, a revolved object is a solid, and a lofted winner is refused with its
 * reason.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { asMassingParts, clampInto, ROOF_WALL_CLEARANCE_M, type ScanMassingResult } from '../src/node/3d-engine/staged-location/scan-massing';

const BLOCK: Array<[number, number]> = [[0, 0], [20, 0], [20, 12], [0, 12]];
const box = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

function result(chosen: string): ScanMassingResult {
    return {
        chosen, forced: false, explains: true, why: 'test', candidates: [], groundY: 0, roofY: 15, top: 20, samples: 0, block: BLOCK, tiers: [], glbPath: '',
        roof: {
            photo: true, objects: [
                // hard against the +x wall
                { chosen: 'outline raised', why: 'bulkhead', outlineSource: 'photo', heightSource: 'scan', outline: box(17, 3, 19.98, 6), baseY: 15, topY: 17.5, areaM2: 9 },
                // crossing the -z wall
                { chosen: 'outline raised', why: 'plant', outlineSource: 'photo', heightSource: 'estimated', outline: box(4, -0.4, 8, 2), baseY: 15, topY: 15.3, areaM2: 9.6 },
                // a tank: a fitted solid (a tetrahedron stands in for its mesh)
                { chosen: 'solid of revolution', why: 'round', outlineSource: 'photo', heightSource: 'scan', outline: box(9, 5, 11, 7), baseY: 15, topY: 20, areaM2: 3.1, mesh: { v: [[9, 15, 5], [11, 15, 5], [10, 15, 7], [10, 20, 6]], i: [0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3] } }
            ]
        }
    };
}

describe('scan massing as parts', () => {
    it('keeps every raised outline inside the walls', () => {
        const built = asMassingParts(result('block + roof objects'));
        if ('reason' in built) throw new Error(built.reason);
        expect(built.parts.map(p => p.id)).toEqual(['scan-block', 'scan-roof-0', 'scan-roof-1']);
        expect(built.meshes.map(m => m.id)).toEqual(['scan-roof-2']);
        for (const p of built.parts.slice(1)) for (const [x, z] of p.loops[0]) {
            expect(x).toBeGreaterThanOrEqual(ROOF_WALL_CLEARANCE_M - 1e-9);
            expect(x).toBeLessThanOrEqual(20 - ROOF_WALL_CLEARANCE_M + 1e-9);
            expect(z).toBeGreaterThanOrEqual(ROOF_WALL_CLEARANCE_M - 1e-9);
        }
        expect(built.notes.some(n => /brought 0.15 m inside the walls/.test(n))).toBe(true);
        expect(clampInto([[5, 5], [30, 5]], BLOCK)).toEqual({ outline: [[5, 5], [20, 5]], moved: 1 });
    });

    it('is built by the native tool with the block\'s walls whole', async () => {
        const built = asMassingParts(result('block + roof objects'));
        if ('reason' in built) throw new Error(built.reason);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-massing-'));
        const run = await runMassing(massingSpecText({ parts: built.parts, meshes: built.meshes }, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 } }), dir);
        const walls = run.report.faces.filter(f => f.kind === 'wall' && f.part === 'scan-block');
        expect(walls.map(f => +(f.sMax - f.sMin).toFixed(2)).sort((a, b) => a - b)).toEqual([12, 12, 20, 20]);
        let top = -Infinity;
        for (const n of run.nodes) for (let i = 1; i < n.positions.length; i += 3) top = Math.max(top, n.positions[i]);
        expect(top).toBeCloseTo(20, 1);
    });

    it('refuses a lofted winner with its reason, and builds tiers as parts', () => {
        const loft = asMassingParts(result('lofted sections'));
        expect('reason' in loft && loft.reason).toMatch(/no flat walls/);
        const tiers = asMassingParts({ ...result('tiers'), tiers: [{ outline: BLOCK, y0: 0, y1: 10, area: 240 }, { outline: box(5, 3, 15, 9), y0: 10, y1: 18, area: 60 }] });
        if ('reason' in tiers) throw new Error(tiers.reason);
        expect(tiers.parts.map(p => [p.baseY, p.topY])).toEqual([[0, 10], [10, 18]]);
    });
});
