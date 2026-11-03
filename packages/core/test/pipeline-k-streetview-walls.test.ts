/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View on K's facade planes (pipeline-k/streetview-walls.ts), the free dry run of its preregistration
 * (docs/processes/2026-11-03-k-streetview-walls-prereg.md): a 20 x 16 m wall facing +z, windows every 2 m along it and
 * 3.2 m up it, an entrance and a sign band that do not repeat; its tile ortho drawn from the plane; a photo ray-cast from
 * an oblique street camera with a panel standing in front. The rectified photo must land back on the ortho (pier lines
 * under 0.5 px), the masks cut at the panel and the frame, the resolution be fx / z x cos, the gate pass the true pose and
 * refuse a nominal one, and the decoy (the eye moved one repeat along the wall) be refused.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    gateWall, movedCamera, pierLineOffsets, qualifyingMask, rectifyOntoFacade, streetViewWalls, streetViewWallsByDefault, tileCovered, STREETVIEW_WALLS_PARAMS, type WallView
} from '../src/node/3d-engine/staged-location/pipeline-k/streetview-walls';
import type { ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { frameCamera, renderFrameDepth, ZERO_CORRECTION } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const PIXEL = 0.1, W = 200, H = 160;
const facade: ReliefFacade = {
    facadeId: 3, image: 'facade_3.png', centroid: [0, 10, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0],
    sMin: -10, sMax: 10, tMin: -8, tMax: 8, pixel: PIXEL, width: W, height: H, orthoSMin: -10, orthoTMax: 8, coverage: 1
};
const hash = (a: number, b: number) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };
const mod = (a: number, m: number) => ((a % m) + m) % m;
/** The wall's colour at (s, t): stone with a little grain, windows on a 2 x 3.2 m lattice, an entrance and a sign band that do not repeat. */
function wallColour(s: number, t: number): [number, number, number] {
    if (s > -9.5 && s < -7 && t < -5.5) return [60, 40, 30];
    if (t > -5 && t < -4.4 && s > 2 && s < 9) return [200, 60, 50];
    if (mod(s + 10, 2) > 0.5 && mod(s + 10, 2) < 1.3 && mod(t + 8, 3.2) > 0.9 && mod(t + 8, 3.2) < 2.3) return [50, 55, 70];
    const g = 6 * (hash(Math.floor(s / 0.1), Math.floor(t / 0.1)) - 0.5);
    return [180 + g, 172 + g, 160 + g];
}
function tileOrtho(): { width: number; height: number; rgba: Uint8Array } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = wallColour(facade.orthoSMin + (x + 0.5) * PIXEL, facade.orthoTMax - (y + 0.5) * PIXEL);
        rgba.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], (y * W + x) * 4);
    }
    return { width: W, height: H, rgba };
}
/** The wall and a 2 x 14 m panel standing 6 m in front of it, x 0.5..2.5 (the tile mesh). */
const quad = (a: number[], b: number[], c: number[], d: number[]) => ({ v: [...a, ...b, ...c, ...d], i: [0, 1, 2, 0, 2, 3] });
function mesh(withPanel: boolean): RenderMesh3D {
    const parts = [quad([-10, 2, 0], [10, 2, 0], [10, 18, 0], [-10, 18, 0]), ...(withPanel ? [quad([0.5, 0, 6], [2.5, 0, 6], [2.5, 14, 6], [0.5, 14, 6])] : [])];
    const vertices: number[] = [], indices: number[] = [];
    for (const p of parts) { const o = vertices.length / 3; vertices.push(...p.v); indices.push(...p.i.map(k => k + o)); }
    return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}
const EYE: [number, number, number] = [6, 2.5, 15];
function camera(eye = EYE): PinholeCamera {
    const d = [0 - eye[0], 10 - eye[1], 0 - eye[2]];
    const heading = (Math.atan2(d[0], -d[2]) * 180) / Math.PI, pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
    return frameCamera(eye, heading, pitch, 70, 1600, 1200, ZERO_CORRECTION, heading);
}
/** The photo ray-cast from the camera: the wall, the panel (green) in front, sky elsewhere; the owner mask where the wall is first. */
function photograph(cam: PinholeCamera): { rgba: Uint8Array; owner: Uint8Array } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), owner = new Uint8Array(cam.width * cam.height);
    for (let j = 0; j < cam.height; j++) for (let i = 0; i < cam.width; i++) {
        const a = (i - cam.cx) / cam.fx, b = -(j - cam.cy) / cam.fy;
        const dir = [0, 1, 2].map(k => cam.fwd[k] + a * cam.right[k] + b * cam.up[k]);
        let col: number[] = [150, 180, 220], own = 0;
        const hit = (z: number) => { if (!(dir[2] < 0)) return undefined; const t = (z - cam.eye[2]) / dir[2]; return t > 0 ? [cam.eye[0] + t * dir[0], cam.eye[1] + t * dir[1], t] : undefined; };
        const p = hit(6), w = hit(0);
        if (p && p[0] > 0.5 && p[0] < 2.5 && p[1] > 0 && p[1] < 14) col = [40, 160, 60];
        else if (w && w[0] > -10 && w[0] < 10 && w[1] > 2 && w[1] < 18) { col = wallColour(w[0], w[1] - 10); own = 1; }
        rgba.set([Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255], (j * cam.width + i) * 4);
        owner[j * cam.width + i] = own;
    }
    return { rgba, owner };
}
const tileMesh = mesh(true);
function view(method = 'edges'): WallView {
    const cam = camera(), ph = photograph(cam);
    return { id: 'synthetic_h338_p25', panoId: 'synthetic', camera: cam, image: { width: cam.width, height: cam.height, rgba: ph.rgba }, depth: renderFrameDepth(tileMesh, cam), ownerMask: ph.owner, registration: { method, residualM: method === 'nominal' ? null : 0.3 } };
}

describe('Street View on the facade planes', () => {
    const tile = tileOrtho(), use = tileCovered(tile), v = view();
    const r = rectifyOntoFacade(facade, v);
    const q = qualifyingMask(facade, r);

    it('puts the photo back on the ortho, with masks cut at the panel and resolution fx / z x cos', () => {
        expect(r.counts.covered).toBeGreaterThan(0.8 * W * H);
        // behind the panel (from the eye through its middle to the wall): covered, not visible, not owned
        const i = 79 * W + 84;
        expect([r.covered[i], r.visible[i], r.owned[i]]).toEqual([1, 0, 0]);
        // a clear point: its resolution is fx / z x cos
        const k = 30 * W + 150, s = facade.orthoSMin + 150.5 * PIXEL, t = facade.orthoTMax - 30.5 * PIXEL, p = [s, 10 + t, 0], cam = v.camera;
        const d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]], z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
        expect(r.pxPerM[k]).toBeCloseTo((cam.fx / z) * (-d[2] / Math.hypot(d[0], d[1], d[2])), 3);
        // the qualifying colours match the tile's
        const diffs: number[] = [];
        for (let j = 0; j < W * H; j++) if (q.mask[j]) diffs.push(Math.abs(r.rgba[j * 4] - tile.rgba[j * 4]));
        diffs.sort((a, b) => a - b);
        expect(diffs.length).toBeGreaterThan(0.5 * W * H);
        expect(diffs[diffs.length >> 1]).toBeLessThan(4);
        expect(q.rejected.depth).toBeGreaterThan(0);
    });

    it('passes the true pose, its pier lines on the tile ortho\'s, and refuses a nominal one', () => {
        const g = gateWall(facade, tile, use, r, q.mask, true);
        expect(g.pass).toBe(true);
        expect(g.ePass).toBe(true);
        expect(Math.abs(g.agreement!.dx) + Math.abs(g.agreement!.dy)).toBeLessThanOrEqual(1);
        const keep = new Uint8Array(r.rgba);
        for (let j = 0; j < W * H; j++) if (!q.mask[j]) keep[j * 4 + 3] = 0;
        const pl = pierLineOffsets(tile, { width: W, height: H, rgba: keep }, PIXEL);
        expect(pl.matched).toBeGreaterThanOrEqual(5);
        expect(pl.medianPx!).toBeLessThan(0.5);
        const nominal = gateWall(facade, tile, use, r, q.mask, false);
        expect(nominal.pass).toBe(false);
        expect(nominal.reason).toMatch(/nominal/);
    });

    it('refuses the decoy: the eye moved one repeat (2 m) along the wall', () => {
        for (const m of [-2, 2]) {
            const cam = movedCamera(v.camera, facade.axisS, m);
            const dr = rectifyOntoFacade(facade, { camera: cam, image: v.image, depth: renderFrameDepth(tileMesh, cam), ownerMask: v.ownerMask });
            const dg = gateWall(facade, tile, use, dr, qualifyingMask(facade, dr).mask, true);
            expect(dg.pass).toBe(false);
            // pipeline E's rules alone pass it (the repeat agrees at zero shift); the phase check is what refuses it
            expect(dg.ePass).toBe(true);
            // the farther search finds the true alignment, a repeat away
            expect(dg.phase?.bestFar && Math.abs(Math.abs(dg.phase.bestFar.dx) * PIXEL - 2)).toBeLessThan(0.3);
        }
    });

    it('writes the images and the record for the walls the gate judges, decoys included, and is off by default', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sv-walls-'));
        try {
            const orthos = path.join(dir, 'relief_orthos'), out = path.join(dir, 'k', 'streetview');
            fs.mkdirSync(orthos, { recursive: true });
            fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ schema: 'test', facades: [facade] }));
            fs.writeFileSync(path.join(orthos, facade.image), encodePng(W, H, tile.rgba, 4));
            const res = await streetViewWalls({ tileOrthosDir: orthos, outDir: out, views: [v, { ...view('nominal'), id: 'nominal_h338_p25', panoId: 'nominal' }], tileMesh, structure: mesh(false) });
            expect(res.summary).toMatchObject({ facades: 1, pairs: 2, passing: 1, decoys: 2, decoysPassing: 0 });
            expect(res.summary.refusedBy).toMatchObject({ passed: 1, 'nominal pose': 1 });
            expect(res.summary.pierLines.medianPx!).toBeLessThan(0.5);
            const pass = res.walls.find(w => w.gate.pass)!;
            for (const f of Object.values(pass.files!)) expect(fs.readFileSync(path.join(out, f)).subarray(1, 4).toString()).toBe('PNG');
            expect(pass.resolutionM!.median).toBeGreaterThan(0.005);
            expect(pass.resolutionM!.median).toBeLessThan(PIXEL / STREETVIEW_WALLS_PARAMS.minSharper);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        expect(streetViewWallsByDefault({})).toBe(false);
        expect(streetViewWallsByDefault({ SCRATCHBOX_K_STREETVIEW_WALLS: '1' })).toBe(true);
    });
});
