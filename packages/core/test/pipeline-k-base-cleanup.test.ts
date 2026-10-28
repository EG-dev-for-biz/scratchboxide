/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's base cleanup (pipeline-k/base-cleanup.ts): a 10 m x 10 m x 20 m tower on a 10 x 10 m footprint, its walls
 * starting 1 m above the ground (a scan gap), with a sidewalk apron welded to its foot running 4 m out, a detached kerb
 * 6 m away, a detached lamp post 7 m tall nearby, and a canopy 4 m up reaching 1 m out. The kerb, the lamp post and the
 * apron go; the tower and the canopy stay; the 1 m gap along the footprint is closed by a generated skirt.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BASE_CLEANUP_PARAMS, cleanBase, outsideFootprint } from '../src/node/3d-engine/staged-location/pipeline-k/base-cleanup';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbTriangles } from './helpers/clay-glb-render';

type V = [number, number, number];
const quad = (a: V, b: V, c: V, d: V): number[] => [...a, ...b, ...c, ...a, ...c, ...d];
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] => [
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), ...quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]),
    ...quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]), ...quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]),
    ...quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1])
];

function scene(): { file: string; soup: Float32Array } {
    const tower = box(0, 10, 1, 20, 0, 10);
    // the apron welded to the tower's foot: a strip from the wall (z = 0, y = 1) down and out to z = -4 at the ground
    const apron = quad([0, 1, 0], [10, 1, 0], [10, 0, -4], [0, 0, -4]);
    const kerb = box(0, 10, 0, 0.2, -10, -9.6);
    const lamp = box(14, 14.2, 0, 7, 3, 3.2);
    // a canopy over the door, welded to the wall at y = 4, reaching 1 m out
    const canopy = quad([3, 4, 0], [6, 4, 0], [6, 4, -1], [3, 4, -1]);
    const soup = Float32Array.from([...tower, ...apron, ...kerb, ...lamp, ...canopy]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
    const file = path.join(dir, 'clay.glb');
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
    return { file, soup };
}

const footprint: Array<Array<[number, number]>> = [[[0, 0], [10, 0], [10, 10], [0, 10]]];

describe('pipeline K base cleanup', () => {
    it('measures how far a point stands outside the footprint', () => {
        expect(outsideFootprint(5, 5, footprint)).toBe(0);
        expect(outsideFootprint(5, -3, footprint)).toBeCloseTo(3, 6);
    });

    it('removes the kerb, the lamp post and the apron, keeps the tower and the canopy, and closes the base gap', () => {
        const { file, soup } = scene();
        const r = cleanBase(fs.readFileSync(file), [], footprint, 0);
        expect(r.report.strayPieces).toBe(2);
        expect(r.report.apronTriangles).toBeGreaterThan(0);
        expect(r.report.apronSkipped).toBeUndefined();
        const t = readGlbTriangles(r.clay);
        const live = (i: number) => !(t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2]);
        const centre = (i: number): V => [0, 1, 2].map(k => (soup[i * 3 + k] + soup[i * 3 + 3 + k] + soup[i * 3 + 6 + k]) / 3) as V;
        let kerb = 0, lamp = 0, apron = 0, tower = 0, canopy = 0;
        for (let i = 0; i < soup.length / 3; i += 3) {
            const c = centre(i), on = live(i);
            if (c[2] < -9) kerb += on ? 1 : 0;
            else if (c[0] > 13) lamp += on ? 1 : 0;
            else if (c[1] < 1 && c[2] < 0) apron += on ? 1 : 0;
            else if (Math.abs(c[1] - 4) < 1e-6 && c[2] < 0) canopy += on ? 1 : 0;
            else tower += on ? 1 : 0;
        }
        expect([kerb, lamp, apron]).toEqual([0, 0, 0]);
        expect(canopy).toBe(2);
        expect(tower).toBe(10);
        // the skirt: appended, labelled generated, from the ground to the 1 m gap along the footprint edges
        const json = parseGlbBytes(r.clay).json;
        expect(json.nodes.at(-1).extras.sbBaseSkirt.provenance.label).toBe('generated');
        expect(r.report.skirt.edgesClosed).toBeGreaterThanOrEqual(3);
        expect(r.report.skirt.areaM2).toBeGreaterThan(25);
    });

    it('trims the sidewalk between a footprint drawn wider than the walls and the walls, and closes the base on the wall line', () => {
        // the tower's walls on x, z in 0..10; the footprint 2 m wider all round; a flat sidewalk at the ground filling it, welded to nothing
        const tower = box(0, 10, 1, 20, 0, 10);
        const sidewalk = [...quad([-2, 0, -2], [12, 0, -2], [12, 0, 0], [-2, 0, 0]), ...quad([-2, 0, 10], [12, 0, 10], [12, 0, 12], [-2, 0, 12]), ...quad([-2, 0, 0], [0, 0, 0], [0, 0, 10], [-2, 0, 10]), ...quad([10, 0, 0], [12, 0, 0], [12, 0, 10], [10, 0, 10])];
        const soup = Float32Array.from([...tower, ...sidewalk]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const r = cleanBase(fs.readFileSync(file), [], [[[-2, -2], [12, -2], [12, 12], [-2, 12]]], 0);
        // every edge's wall line measured about 2 m in
        expect(r.report.insetsM.every(d => d > 1.6 && d < 2.4)).toBe(true);
        // the sidewalk is flat at the ground: it goes as ground at grade (the street), before the wall-line rule needs it
        expect(r.report.groundTriangles + r.report.gradeTriangles).toBe(8);
        const t = readGlbTriangles(r.clay);
        let towerLive = 0;
        for (let i = 0; i < tower.length / 3; i += 3) if (!(t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2])) towerLive++;
        expect(towerLive).toBe(10);
        // the skirt stands on the wall line (x or z near 0 or 10), not on the footprint edge
        const json = parseGlbBytes(r.clay).json;
        const g = parseGlbBytes(r.clay);
        const P = readAccessor(g, json.meshes.at(-1).primitives[0].attributes.POSITION).data;
        // distance in plan from the tower's wall square (x, z in 0..10)
        const toWall = (x: number, z: number) => { const dx = Math.max(0 - x, 0, x - 10), dz = Math.max(0 - z, 0, z - 10); return dx || dz ? Math.hypot(dx, dz) : Math.min(x, 10 - x, z, 10 - z); };
        let worst = 0;
        for (let v = 0; v < P.length; v += 3) worst = Math.max(worst, toWall(P[v], P[v + 2]));
        expect(r.report.skirt.segments).toBeGreaterThan(0);
        expect(worst).toBeLessThan(0.7);
    });

    it('with the party wall on (off by default), closes a side the scan has no wall on with a generated wall facing out, and leaves the scanned sides', () => {
        // the tower from the ground up, its x = 10 side missing: from that side the inside of the other walls shows
        const walls = box(0, 10, 0, 20, 0, 10);
        const missing = (i: number) => { const xs = [walls[i * 9], walls[i * 9 + 3], walls[i * 9 + 6]]; return xs.every(x => x === 10); };
        const kept: number[] = [];
        // box() winds its faces inward; a scan's face out, so each kept triangle is turned over
        for (let i = 0; i < walls.length / 9; i++) if (!missing(i)) kept.push(...walls.slice(i * 9, i * 9 + 3), ...walls.slice(i * 9 + 6, i * 9 + 9), ...walls.slice(i * 9 + 3, i * 9 + 6));
        const soup = Float32Array.from(kept);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const r = cleanBase(fs.readFileSync(file), [], footprint, 0, { ...BASE_CLEANUP_PARAMS, partyWall: true });
        expect(r.report.partyWall.edges).toBe(1);
        expect(r.report.partyWall.areaM2).toBeGreaterThan(180);
        expect(r.report.partyWall.areaM2).toBeLessThanOrEqual(200);
        const g = parseGlbBytes(r.clay);
        const node = g.json.nodes.find((n: any) => n.name === 'PartyWall');
        expect(node.extras.sbBaseSkirt.provenance.label).toBe('generated');
        const pr = g.json.meshes[node.mesh].primitives[0];
        const P = readAccessor(g, pr.attributes.POSITION).data, I = readAccessor(g, pr.indices).data;
        for (let v = 0; v < P.length; v += 3) expect(P[v]).toBeCloseTo(10, 6);
        // every quad faces out of the building (+x)
        for (let t = 0; t < I.length; t += 3) {
            const a = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
            const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
            expect(nx).toBeGreaterThan(0);
        }
    });

    it('cleans nothing when the footprint does not fit the building', () => {
        const { file } = scene();
        // a footprint 30 m away
        const r = cleanBase(fs.readFileSync(file), [], [[[30, 30], [40, 30], [40, 40], [30, 40]]], 0);
        expect(r.report.apronSkipped).toMatch(/does not fit/);
        expect([r.report.strayPieces, r.report.apronTriangles, r.report.skirt.segments]).toEqual([0, 0, 0]);
    });
});
