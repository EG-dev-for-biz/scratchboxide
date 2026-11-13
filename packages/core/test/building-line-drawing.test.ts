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
import { renderBuildingLineDrawings, renderPlaneLines, CARDINAL_VIEWS, LINE_DRAWING_PARAMS } from '../src/node/3d-engine/staged-location/building-line-drawing';
import { runBuildingLineDrawing } from '../src/node/gemini/tools/location-evidence/building-line-drawing';
import { renderBlueprints } from '../src/node/3d-engine/staged-location/building-blueprint';

/** A closed axis-aligned box as a triangle soup, its faces wound outward. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    const out: number[] = [];
    for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
    return out;
}

describe('building blueprint: windows on their facades, mirrored about its axis', () => {
    it('draws a facade\'s windows on the elevation that faces it and mirrors an unpaired one about the facade\'s axis', () => {
        // a 20 m wide, 10 m deep, 12 m tall box; its +z face as a facade ortho at 0.1 m (s along +x, t up), two windows
        // paired about the face's middle and one on the left with no partner
        const soup = Float32Array.from(box(0, 0, 0, 20, 12, 10));
        const frame = { centroid: [10, 6, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], axisS: [1, 0, 0] as [number, number, number], axisT: [0, 1, 0] as [number, number, number], orthoSMin: -10, orthoTMax: 6, pixel: 0.1, width: 200, height: 120 };
        const rects: Array<[number, number, number, number]> = [[30, 20, 50, 50], [150, 20, 170, 50], [30, 70, 50, 100]];
        const symmetry = { schema: 'scratchbox.symmetry/1', frame: '', plan: { cellM: 1, grid: [1, 1], origin: [0, 0], massing: { mass: 0, centroid: [10, 5], best: { angleDeg: 0, point: [10, 5], dir: [0, 1], score: 0.95, share: 1 }, mirrors: [], detectedMirrors: 1, rotation: { order: 1, score: 0, scores: [] } }, tiers: [] },
            facades: [{ facadeId: 1, read: true, detected: true, periodic: false, axisS: 0, ncc: 0.9 }], transforms: [], twins: [], ms: { plan: 0, facades: 0, twins: 0 } } as never;
        const { report } = renderBlueprints(soup, { facades: [{ facadeId: 1, frame, rects }], symmetry, title: 'Test box' });
        // the views turn to the box's walls (0 degrees): the elevation looking at the +z face is the one looking along -z
        const front = report.views.find(v => v.forward[2] < -0.99)!;
        expect(front.windows).toBe(3);
        // the unpaired window's mirror (at s = +6..+8 m) is drawn dashed; the paired ones need none
        expect(front.mirroredWindows).toBe(1);
        expect(front.facadeAxes).toBe(1);
        // the plan mirror along z is seen edge on from the front: a centre line
        expect(front.planAxes).toBe(1);
        // the other elevations do not face the facade: no windows on them
        for (const v of report.views.filter(x => x !== front)) expect(v.windows).toBe(0);
        // the top edge runs the full width: a level at 12 m
        expect(front.levels.some(l => Math.abs(l - 12) < 0.6)).toBe(true);
    });
});

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

    it('draws a plane\'s own lines in its ortho frame: its outline and the setback above it', () => {
        // a 20 m podium 5 m tall with a 10 m tower on it set back 5 m; the podium's south face (z = 20, facing +z) as an
        // ortho at 0.1 m: s along +x from x = 0, t up from the ground, its top at 30 m so the tower's foot shows behind it
        const soup = Float32Array.from([...box(0, 0, 0, 20, 5, 20), ...box(5, 5, 5, 15, 30, 15)]);
        const f = { centroid: [10, 15, 20] as [number, number, number], normal: [0, 0, 1] as [number, number, number], axisS: [1, 0, 0] as [number, number, number], axisT: [0, 1, 0] as [number, number, number], orthoSMin: -10, orthoTMax: 15, pixel: 0.1, width: 200, height: 300 };
        const dr = renderPlaneLines(soup, f, 1)!;
        expect([dr.width, dr.height]).toEqual([200, 300]);
        const at = (x: number, y: number) => dr.rgb[(y * dr.width + x) * 3];
        // the podium face's top edge at t = 5 m: row (30 - 5) / 0.1 = 250, drawn across it
        let topRow = 0; for (let x = 10; x < 190; x++) if (at(x, 250) < 200 || at(x, 249) < 200) topRow++;
        expect(topRow).toBeGreaterThan(150);
        // the tower stands 15 m behind the face, past the band: it is not drawn on the podium face's sheet
        let tower = 0; for (let y = 10; y < 240; y++) if (at(50, y) < 200 || at(51, y) < 200) tower++;
        expect(tower).toBe(0);
        // the face's sides (x = 0 and 20 m, columns 0 and 199) run up to its top
        let side = 0; for (let y = 252; y < 298; y++) if (at(0, y) < 200 || at(1, y) < 200) side++;
        expect(side).toBeGreaterThan(40);
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
        const r = await runBuildingLineDrawing({ glbPath: ESB_CLAY, outputDir: path.join(work, 'out'), style: 'lines' }, work, work);
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

    it('draws the ESB as blueprint sheets: K\'s windows on its facades, its levels and its centre lines', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-'));
        const r = await runBuildingLineDrawing({ glbPath: ESB_CLAY, outputDir: path.join(work, 'out') }, work, work);
        const rep = r.payload.report as { views: Array<{ label: string; windows: number; mirroredWindows: number; levels: number[]; planAxes: number; extentM: [number, number] }> };
        expect(rep.views.map(v => v.label)).toEqual(['ELEVATION A', 'ELEVATION B', 'ELEVATION C', 'ELEVATION D', 'ROOF PLAN']);
        // pipeline K's windows beside the cut-out, on the elevations that face them
        expect(r.payload.windowsFrom).toMatch(/relief_orthos_k_/);
        const a = rep.views[0], c = rep.views[2], plan = rep.views[4];
        expect(a.windows).toBeGreaterThan(1000);
        expect(c.windows).toBeGreaterThan(1000);
        // the setback over the podium (about 107 m) and the top of the shaft's crown (about 334 m) are among its levels
        expect(c.levels.some(l => Math.abs(l - 107) < 3)).toBe(true);
        expect(c.levels.some(l => Math.abs(l - 334) < 3)).toBe(true);
        // the building's plan mirror is drawn on every elevation and both its axes across the plan
        for (const v of rep.views.slice(0, 4)) expect(v.planAxes).toBeGreaterThanOrEqual(1);
        expect(plan.planAxes).toBe(2);
        expect(Math.round(a.extentM[1])).toBe(441);
        const files = r.payload.files as Array<{ path: string }>;
        for (const f of files) expect([...fs.readFileSync(f.path).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }, 300_000);
});
