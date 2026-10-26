/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline H's decisions (pipeline-h/pipeline-h.ts on pipeline-g's steps): the reading gate, the continued-opening
 * dedupe, the native tool's rejection reasons (through the real native tool, on a synthetic wall), the structure seed
 * on the vector building nearest the place, the ledger read off the massing's notes, and which pipeline a request runs.
 * Pipeline G's own policy is checked unchanged: no gate, no dedupe, rejections by id.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { massingSpecText } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing, type MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { writeMassingTexturedGlb } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import { dedupeContinuedOpenings, G_POLICY, readingGated, rejectionsByReason } from '../src/node/3d-engine/staged-location/pipeline-g/pipeline-g';
import type { ProgramItems } from '../src/node/3d-engine/staged-location/pipeline-g/read';
import { GATE_EXPLAINED, GATE_LIFT, H_POLICY, PIPELINE_H_VERSION, stagedProcedural } from '../src/node/3d-engine/staged-location/pipeline-h/pipeline-h';
import { ledgerFromMassingNote } from '../src/node/3d-engine/staged-location/pipeline-h/ledger';
import { vectorSeed, type FootprintLookup } from '../src/node/3d-engine/staged-location/extraction-sizing';
import type { GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-h-'));

const opening = (id: string, s0: number, s1: number, t0: number, t1: number, provenance: 'photo-inferred' | 'generated') =>
    ({ id, face: 'w', s0, s1, t0, t1, depth: 0.2, scanned: false, confidence: 0.6, provenance });

function items(openings: ReturnType<typeof opening>[]): ProgramItems {
    return {
        openings, faceSweeps: openings.flatMap(o => [{ id: `${o.id}:sill`, confidence: 0.5, provenance: o.provenance, face: 'w', axis: 0 as const, profile: [[0, 0], [0.1, 0.1]] as Array<[number, number]>, placements: [[o.s0, o.s1, 0]] as Array<[number, number, number]> }]),
        wallColour: [120, 110, 100], colours: new Map(),
        counts: { openings: openings.length, filledOpenings: openings.filter(o => o.provenance === 'generated').length, horizontal: 0, vertical: 0, filledVertical: 0, paned: 0, sills: openings.length, surrounds: 0 }
    };
}

describe('pipeline H', () => {
    it('is pipeline G with every rule set; G stays the defaults', () => {
        expect(H_POLICY).toMatchObject({ name: 'h', gateExplained: GATE_EXPLAINED, gateLift: GATE_LIFT, dedupeContinued: true, rejectionReasons: true, ledger: true });
        expect(G_POLICY).toEqual({ name: 'g' });
        expect(PIPELINE_H_VERSION).toMatch(/^pipeline-h\/v2\+pipeline-g\//);
    });

    it('is the default; G only when the request or the environment asks for it', () => {
        expect(stagedProcedural({ procedural: true }, {})).toBe('h');
        expect(stagedProcedural({ procedural: true, pipeline: 'h' }, {})).toBe('h');
        expect(stagedProcedural({ procedural: true }, { SCRATCHBOX_STAGED_PROCEDURAL: 'G' })).toBe('g');
        expect(stagedProcedural({ procedural: true, pipeline: 'g' }, {})).toBe('g');
        expect(stagedProcedural({ procedural: true, pipeline: 'h' }, { SCRATCHBOX_STAGED_PROCEDURAL: 'g' })).toBe('h');
    });

    it('gates a reading that explains almost none of its plate after its re-read; G gates nothing', () => {
        const blank = { explained: 0.01, lift: 0.7 };
        const read = { explained: 0.23, lift: 4.2 };
        const lifted = { explained: 0.03, lift: 2.1 };   // little explained but well above its displaced copies: kept
        expect(readingGated(blank, H_POLICY)).toBe(true);
        expect(readingGated(read, H_POLICY)).toBe(false);
        expect(readingGated(lifted, H_POLICY)).toBe(false);
        expect(readingGated(blank, G_POLICY)).toBe(false);
    });

    it('drops continued openings past the wall\'s ends or over another opening, with their sills; read openings stay', () => {
        const it_ = items([
            opening('r0', 1, 2, 1, 2.5, 'photo-inferred'),
            opening('r1', 3, 4, 1, 2.5, 'photo-inferred'),
            opening('c0', 1.5, 2.5, 1, 2.5, 'generated'),    // over r0
            opening('c1', 5, 6, 1, 2.5, 'generated'),        // fine
            opening('c2', 11.5, 12.5, 1, 2.5, 'generated'),  // past the end of a 12 m wall
            opening('c3', 5.2, 5.8, 4, 5, 'generated'),      // fine (another storey)
            opening('c4', 5.5, 6.5, 4.5, 5.5, 'generated')   // over c3
        ]);
        const d = dedupeContinuedOpenings(it_, { sMin: 0, sMax: 12 });
        expect(d.dropped).toEqual(['c0: overlaps r0', 'c2: past the wall\'s ends', 'c4: overlaps c3']);
        expect(it_.openings.map(o => o.id)).toEqual(['r0', 'r1', 'c1', 'c3']);
        expect(it_.faceSweeps.map(s => s.id)).toEqual(['r0:sill', 'r1:sill', 'c1:sill', 'c3:sill']);
        // a read opening over another read opening is left to the native tool, which says why
        const both = items([opening('r0', 1, 2, 1, 2.5, 'photo-inferred'), opening('r1', 1.5, 2.5, 1, 2.5, 'photo-inferred')]);
        expect(dedupeContinuedOpenings(both, { sMin: 0, sMax: 12 }).dropped).toEqual([]);
        expect(both.openings).toHaveLength(2);
    });

    it('counts the native tool\'s rejections by reason, folding the overlapped opening\'s id', () => {
        const by = rejectionsByReason({ rejectedOpenings: ['a', 'b', 'c', 'd'], rejectedOpeningReasons: { a: "outside the wall's ends", b: 'overlaps opening r0', c: 'overlaps opening r7', d: "outside the wall's ends" } });
        expect([...by.entries()]).toEqual([["outside the wall's ends", 2], ['overlaps another opening', 2]]);
        expect([...rejectionsByReason({ rejectedOpenings: ['x'] }).entries()]).toEqual([['no reason given', 1]]);
    });

    it('the native tool says why it rejects each opening (synthetic 12 m wall, 9 m high)', async () => {
        const dir = tmp();
        const W = 32, H = 32, img = new Uint8Array(W * H * 4).fill(200);
        const tile = path.join(dir, 'tile.glb');
        const scan: MassingNode = { name: 'scan', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1]), normals: new Float32Array(9), ref: new Int32Array([-2, -2, -2]), st: new Float32Array(6), indices: new Uint32Array([0, 1, 2]) };
        fs.writeFileSync(tile, writeMassingTexturedGlb({ nodes: [scan], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }), textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(W, H, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0 }).glb);
        const m = { parts: [{ id: 'p', baseY: 0, topY: 9, loops: [[[0, 0], [12, 0], [12, -8], [0, -8]] as Array<[number, number]>], planes: [], heightSource: 'scan' as const, heights: { scanY: 9 } }], meshes: [] };
        const run0 = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'a'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 0, sections: 0, topdown: 0 } }), path.join(dir, 'a'));
        const south = run0.report.faces.find(f => f.kind === 'wall' && f.normal[2] > 0.9)!;
        expect(south).toBeDefined();
        const o = (id: string, s0: number, s1: number, t0: number, t1: number) => ({ id, face: south.key, s0, s1, t0, t1, depth: 0.2, scanned: false, confidence: 0.6, provenance: 'photo-inferred' });
        const sMid = 0.5 * (south.sMin + south.sMax);
        const openings = [
            o('fine', sMid - 1, sMid + 1, 2, 3.5),
            o('ends', south.sMax - 0.5, south.sMax + 1, 2, 3.5),
            o('top', sMid - 1, sMid + 1, south.tMax - 0.5, south.tMax + 1),
            o('over', sMid - 0.5, sMid + 0.5, 2.5, 4),
            o('tiny', sMid + 3, sMid + 3.02, 2, 2.01),
            { ...o('nohost', 0, 1, 2, 3), face: 'no-such-face' }
        ];
        const run1 = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'b'), tile, isolate: tile, openings, params: { pixel: 0.1, snapMaxM: 0, sections: 0, topdown: 0 } }), path.join(dir, 'b'));
        // 'fine' and 'over' overlap: whichever the tool attaches second is rejected for overlapping the first
        const reasons = run1.report.rejectedOpeningReasons!;
        const overlapped = ['fine', 'over'].filter(id => id in reasons);
        expect(overlapped).toHaveLength(1);
        const other = overlapped[0] === 'fine' ? 'over' : 'fine';
        expect(run1.report.rejectedOpenings.sort()).toEqual(['ends', 'nohost', overlapped[0], 'tiny', 'top'].sort());
        expect(reasons).toEqual({
            ends: "outside the wall's ends", top: "above the wall's top", [overlapped[0]]: `overlaps opening ${other}`, tiny: 'smaller than 0.05 m', nohost: 'no wall of the massing hosts its face'
        });
        expect([...rejectionsByReason(run1.report).keys()]).toEqual(expect.arrayContaining(["outside the wall's ends", "above the wall's top", 'overlaps another opening', 'smaller than 0.05 m', 'no wall of the massing hosts its face']));
    }, 120_000);

    it('seeds the structure on the vector building nearest the place that is raised, not the nearest raised cell', () => {
        // a 60 x 60 m grid; the place at (0, 0); trees (raised) at 5-8 m east; the house's footprint 20-30 m east, raised
        const nx = 60, nz = 60, cell = 1;
        const g = { nx, nz, cellMeters: cell, x0: -30, z0: -30 } as unknown as GroundModel;
        const raised = new Uint8Array(nx * nz);
        const at = (x: number, z: number) => (Math.floor(z + 30)) * nx + Math.floor(x + 30);
        for (let x = 5; x < 8; x++) for (let z = -1; z < 2; z++) raised[at(x, z)] = 1;        // trees
        for (let x = 20; x < 30; x++) for (let z = -5; z < 5; z++) raised[at(x, z)] = 1;      // the house
        for (let x = -25; x < -20; x++) for (let z = 10; z < 14; z++) raised[at(x, z)] = 1;   // another building, further
        const fp: FootprintLookup = {
            buildings: [{ id: 'house' }, { id: 'shed' }, { id: 'flat-lot' }],
            buildingAt: (x, z) => (x >= 20 && x < 30 && z >= -5 && z < 5) ? 1 : (x >= -25 && x < -20 && z >= 10 && z < 14) ? 2 : (x >= 2 && x < 4 && z >= -1 && z < 1) ? 3 : 0
        };
        const s = vectorSeed(fp, g, raised, { x: 0, z: 0 }, 45);
        expect(s.building).toBe('house');   // the flat lot at 2 m has no raised cell; the house at 20 m does
        expect(s.seed).toBe(at(20, 0));
        expect(s.distanceM).toBeCloseTo(20, 1);   // cell to cell, from the place's own cell
        expect(vectorSeed(fp, g, raised, { x: 0, z: 0 }, 10).seed).toBe(-1);   // nothing raised in a 10 m window
    });

    it('reads the massing\'s height notes into ledger entries', () => {
        const e = ledgerFromMassingNote('part p/e0: height from the scan (88.7 m); Solar 91.6 m disagreed by more than 2.5 m')!;
        expect(e).toMatchObject({ decision: 'height:p/e0', chosen: '88.7 m from scan' });
        expect(e.sources).toEqual([{ source: 'scan', value: '88.7 m', used: true }, { source: 'solar', value: '91.6 m', used: false }]);
        const s = ledgerFromMassingNote('part p/e0: height from solar (16.0 m), 4.0 m off the scan\'s roof')!;
        expect(s.sources[0]).toEqual({ source: 'solar', value: '16.0 m', used: true });
        expect(ledgerFromMassingNote('17/38597: no vector footprint, so the footprint is the scan\'s plan')).toBeUndefined();
    });
});
