/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderBuildingLineDrawings, CARDINAL_VIEWS, LINE_DRAWING_PARAMS } from '../src/node/3d-engine/staged-location/building-line-drawing';
import { runBuildingLineDrawing } from '../src/node/gemini/tools/location-evidence/building-line-drawing';

/** A closed axis-aligned box as a triangle soup, its faces wound outward. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    const out: number[] = [];
    for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
    return out;
}

describe('building line drawing: silhouette and crease, hidden lines removed', () => {
    it('draws a box\'s outline seen face on and hides a box standing behind it', () => {
        // a big box in front (nearer the north view's camera, which looks toward -z from +z) and a small one behind it
        const soup = Float32Array.from([...box(0, 0, 0, 10, 10, 10), ...box(3, 3, -20, 7, 7, -16)]);
        const north = CARDINAL_VIEWS.find(v => v.name === 'north')!;
        const { report, pngs } = renderBuildingLineDrawings(soup, [north], { ...LINE_DRAWING_PARAMS, pixelM: 0.1 });
        const v = report.views[0];
        // each box's front face is a silhouette of four edges (its sides are edge-on); the face's diagonal is no crease
        expect(v.silhouette.candidates).toBe(8);
        expect(v.crease.candidates).toBe(0);
        // only the big box's four are drawn: the small box lies wholly behind it
        expect(v.silhouette.drawn).toBe(4);
        // the drawing: a black outline at the big box's border, white inside it where the hidden box would be
        const p = pngs[0], at = (x: number, y: number) => p.rgb[(y * p.width + x) * 3];
        const col = (u: number) => Math.round((u - v.originU) / v.pixelM), row = (vv: number) => Math.round((v.originV - vv) / v.pixelM);
        expect(at(col(0), row(5))).toBeLessThan(80);    // the big box's left edge
        expect(at(col(5), row(5))).toBe(255);          // inside: no line of the box behind
        expect(at(col(3), row(5))).toBe(255);          // where the hidden box's left edge would be drawn
    });

    it('turns the views to face a building standing off the axes', () => {
        // a 20 x 10 x 30 m box turned 30 degrees about the vertical
        const r = (30 * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
        const raw = box(-10, 0, -5, 10, 30, 5), soup = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i += 3) { soup[i] = raw[i] * c - raw[i + 2] * sn; soup[i + 1] = raw[i + 1]; soup[i + 2] = raw[i] * sn + raw[i + 2] * c; }
        const { report } = renderBuildingLineDrawings(soup, undefined, { ...LINE_DRAWING_PARAMS, pixelM: 0.1 });
        expect(report.wallAzimuthDeg).toBeCloseTo(30, 0);
        // each elevation sees one face square on: only its four outline edges, and its width the face's own (20 or 10 m),
        // not a foreshortened corner view
        for (const v of report.views.filter(x => x.name !== 'plan')) {
            expect(v.silhouette.drawn).toBe(4);
            const w = v.width * v.pixelM;
            expect(Math.min(Math.abs(w - 20), Math.abs(w - 10))).toBeLessThan(0.5);
        }
    });

    it('draws a setback as a crease in elevation and as a ring in plan', () => {
        // a podium with a narrower tower on it: one mesh, the podium's roof cut around the tower's foot
        const soup = Float32Array.from([...box(0, 0, 0, 20, 5, 20), ...box(5, 5, 5, 15, 30, 15)]);
        const { report } = renderBuildingLineDrawings(soup, CARDINAL_VIEWS, { ...LINE_DRAWING_PARAMS, pixelM: 0.1 });
        const plan = report.views.find(v => v.name === 'plan')!, south = report.views.find(v => v.name === 'south')!;
        // from above both roofs face the camera: the tower's roof and the podium's roof each draw their outline
        expect(plan.silhouette.drawn).toBeGreaterThanOrEqual(8);
        // the south elevation is taller than wide (the tower), and both front faces' outlines are drawn but one edge: the
        // tower's foot projects onto the podium's top edge and lies 5 m behind it, so it is hidden
        expect(south.height).toBeGreaterThan(south.width);
        expect(south.silhouette.candidates).toBe(8);
        expect(south.silhouette.drawn).toBe(7);
    });
});

const ESB_CLAY = path.resolve(__dirname, '../../../.scratchbox/cache/tile_refine/9bffd2e1691dfa66d54156dd434a83498d7ad6a2024d033557e0d91daa05eaa1/clay.glb');

describe.skipIf(!fs.existsSync(ESB_CLAY))('building line drawing of a real scan (ESB)', () => {
    it('draws the Empire State Building\'s scan from four sides and above, every line measured', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'line-drawing-'));
        const r = await runBuildingLineDrawing({ glbPath: ESB_CLAY, outputDir: path.join(work, 'out') }, work, work);
        const rep = r.payload.report as { triangles: number; views: Array<{ name: string; width: number; height: number; silhouette: { drawn: number }; crease: { drawn: number } }> };
        expect(rep.triangles).toBeGreaterThan(40_000);
        // Manhattan's grid: the ESB's walls stand about 29 degrees off the scene's axes (or 61, the same grid a quarter on)
        const az = (r.payload.report as { wallAzimuthDeg: number }).wallAzimuthDeg;
        expect(Math.min(Math.abs(az - 29), Math.abs(az - 61))).toBeLessThan(3);
        expect(rep.views.map(v => v.name)).toEqual(['north', 'east', 'south', 'west', 'plan']);
        const files = r.payload.files as Array<{ view: string; path: string; workspacePath: string }>;
        for (const f of files) {
            const head = fs.readFileSync(f.path).subarray(0, 8);
            expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
            expect(fs.existsSync(f.workspacePath)).toBe(true);
        }
        const south = rep.views.find(v => v.name === 'south')!, plan = rep.views.find(v => v.name === 'plan')!;
        // a 443 m tower: its elevation is far taller than wide; thousands of its edges drawn
        expect(south.height).toBeGreaterThan(2 * south.width);
        expect(south.silhouette.drawn).toBeGreaterThan(1000);
        // the plan draws the setbacks and roofs: creases where the terraces meet the walls above them
        expect(plan.crease.drawn).toBeGreaterThan(500);
        // the facade detail the flat mesh cannot hold comes from the photo beside the cut-out (textured.glb): thousands of
        // edge pixels on the elevation, a minority of what the textured scan covers (the quantile keeps the strongest)
        const sp = (south as unknown as { photo?: { covered: number; edgePixels: number } }).photo!;
        expect(r.payload.photoSource).toBe(ESB_CLAY.replace(/clay\.glb$/, 'textured.glb'));
        expect(sp.edgePixels).toBeGreaterThan(10_000);
        expect(sp.edgePixels).toBeLessThan(sp.covered * 0.15);
        expect(fs.existsSync(path.join(work, 'out', 'line_drawing.json'))).toBe(true);
    }, 300_000);
});
