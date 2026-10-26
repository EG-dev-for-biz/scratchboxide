/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, the round-7 fixes (docs/processes/staged_location_pipeline_e.md section 10): modelled volumes turned to face
 * out (a corner tower's walls were inward and took one flat colour), the vegetation strip's untextured caps no longer baked
 * as "as-scanned" photo, walls the tile hardly sees drawn in enhanced mode (generated, labelled), and openings cut from an
 * accepted plate's own lattice where no window grammar passed (generated, labelled). Synthetic data, no model calls.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { massingSpecText, orientOutward, singleSided, type MassingMesh } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { readFaceOrtho, runMassing, type MassingFace, type MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { writeMassingTexturedGlb } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import { unseenGreyShare, type PlateRequest } from '../src/node/3d-engine/staged-location/pipeline-e/enhance';
import { buildFacadeTexture } from '../src/node/3d-engine/staged-location/facade-texture/facade-texture';
import { exposedShare, solidGrid } from '../src/node/3d-engine/staged-location/pipeline-e/exposure';
import { plateLatticeOpenings } from '../src/node/3d-engine/staged-location/pipeline-e/plate-lattice';
import { identityGate } from '../src/node/3d-engine/staged-location/pipeline-e/plate-identity';
import { massingProvenance } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';
import { buildTexturePlatePrompt } from '../src/browser/generative-canvas/services/location-beautify-service';
import type { FacadeGrammar } from '../src/node/3d-engine/staged-location/facade-grammar';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_e_fixes/tests');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-e-fixes-'));
const shot = (name: string, w: number, h: number, rgba: Uint8Array) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), encodePng(w, h, Buffer.from(rgba), 4)); };

/** A closed box [x0,x1] x [y0,y1] x [z0,z1], every triangle given twice (both windings), as Google's volumes are. */
function doubledBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, base: number): { v: Array<[number, number, number]>; i: number[] } {
    const v: Array<[number, number, number]> = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push([x, y, z]);
    const id = (a: number, b: number, c: number) => base + a * 4 + b * 2 + c;
    const quads = [
        [id(0, 0, 0), id(0, 0, 1), id(0, 1, 1), id(0, 1, 0)], [id(1, 0, 0), id(1, 1, 0), id(1, 1, 1), id(1, 0, 1)],
        [id(0, 0, 0), id(1, 0, 0), id(1, 0, 1), id(0, 0, 1)], [id(0, 1, 0), id(0, 1, 1), id(1, 1, 1), id(1, 1, 0)],
        [id(0, 0, 0), id(0, 1, 0), id(1, 1, 0), id(1, 0, 0)], [id(0, 0, 1), id(1, 0, 1), id(1, 1, 1), id(0, 1, 1)]
    ];
    const i: number[] = [];
    for (const [a, b, c, d] of quads) i.push(a, b, c, a, c, d, a, c, b, a, d, c);
    return { v, i };
}

describe('modelled volumes face out', () => {
    it('turns a corner tower\'s walls that face the volume\'s centre outwards (overlapping shells, both windings given)', () => {
        // a long low hall and a tall slim tower at its far corner, overlapping it (Google's volumes overlap their parts)
        const hall = doubledBox(0, 40, 0, 10, 0, 20, 0), tower = doubledBox(34, 40, 0, 35, 14, 20, 8);
        const mesh: MassingMesh = { id: 'v', vertices: [...hall.v, ...tower.v], indices: [...hall.i, ...tower.i] };
        const out = singleSided(mesh);
        expect(out.indices.length).toBe(mesh.indices.length / 2);
        // every triangle's normal points away from the centre of its own box
        const boxes = [{ c: [20, 5, 10], from: 0, to: 8 }, { c: [37, 17.5, 17], from: 8, to: 16 }];
        let wrong = 0, towerWalls = 0;
        for (let t = 0; t < out.indices.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map(k => out.vertices[out.indices[t + k]]);
            const box = boxes.find(x => out.indices[t] >= x.from && out.indices[t] < x.to)!;
            const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
            const ctr = [0, 1, 2].map(k => (a[k] + b[k] + c[k]) / 3 - box.c[k]);
            if (n[0] * ctr[0] + n[1] * ctr[1] + n[2] * ctr[2] < 0) wrong++;
            if (box.from === 8 && Math.abs(n[1]) < 1e-9) towerWalls++;
        }
        // the tower's walls that stand free (above the hall) all face out; only the hall's top and the tower's bottom,
        // buried in each other, may go either way (no ray leaves from either side of the buried parts)
        expect(towerWalls).toBe(8);
        expect(wrong).toBeLessThanOrEqual(4);
        // the old rule (away from the whole volume's centre) turned the tower's west wall (x = 34, facing the centre) inwards
        const west = (m: MassingMesh) => {
            for (let t = 0; t < m.indices.length; t += 3) {
                const [a, b, c] = [0, 1, 2].map(k => m.vertices[m.indices[t + k]]);
                if (a[0] === 34 && b[0] === 34 && c[0] === 34 && Math.min(a[1], b[1], c[1]) >= 0 && Math.max(a[1], b[1], c[1]) === 35) {
                    return (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
                }
            }
            return 0;
        };
        expect(west(out)).toBeLessThan(0); // normal -x: outwards
        const flipped = orientOutward({ ...out, indices: out.indices.map((_, k, a) => a[k - (k % 3) + [0, 2, 1][k % 3]]) });
        expect(flipped.flipped).toBeGreaterThanOrEqual(out.indices.length / 3 - 4);
    });
});

describe('the ortho bake leaves surfaces without a photo uncovered (native)', () => {
    it('does not bake the vegetation strip\'s untextured cap into the facade as photo', async () => {
        const dir = tmp();
        const W = 64, H = 64, img = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.set([200, 60, 50, 255], (y * W + x) * 4);
        const quad = (p: number[][], uv: number[][]) => ({ p, uv });
        const z0 = 0, x1 = 12, h = 9, back = -9;
        const textured = [
            // the south facade's photo only on its right half: the left half's scan surface went with the tree
            quad([[6, 0, z0], [x1, 0, z0], [x1, h, z0], [6, h, z0]], [[0.5, 1], [1, 1], [1, 0], [0.5, 0]]),
            quad([[x1, 0, z0], [x1, 0, back], [x1, h, back], [x1, h, z0]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),
            quad([[x1, 0, back], [0, 0, back], [0, h, back], [x1, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),
            quad([[0, 0, back], [0, 0, z0], [0, h, z0], [0, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]]),
            quad([[0, h, z0], [x1, h, z0], [x1, h, back], [0, h, back]], [[0, 1], [0.4, 1], [0.4, 0], [0, 0]])
        ];
        // a cap the strip left where a tree stood: 0.3 m in front of the left half of the south facade, no photo
        const cap = [quad([[0, 0, 0.3], [6, 0, 0.3], [6, h, 0.3], [0, h, 0.3]], [[0, 0], [0, 0], [0, 0], [0, 0]])];
        const node = (qs: typeof textured, ref: number, name: string): MassingNode => {
            const pos: number[] = [], st: number[] = [], idx: number[] = [], rf: number[] = [], nrm: number[] = [];
            for (const f of qs) { const b = pos.length / 3; f.p.forEach((q, k) => { pos.push(...q); st.push(...f.uv[k]); rf.push(ref); nrm.push(0, 1, 0); }); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
            return { name, kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array(pos), normals: new Float32Array(nrm), ref: new Int32Array(rf), st: new Float32Array(st), indices: new Uint32Array(idx) };
        };
        // the cap references a tile image that does not exist: the writer gives it a flat material, as the strip's cap has
        const tileGlb = writeMassingTexturedGlb({
            nodes: [node(textured, -2, 'scan'), node(cap, -3, 'cap')], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }),
            textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(W, H, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0
        }).glb;
        const tile = path.join(dir, 'tile.glb');
        fs.writeFileSync(tile, tileGlb);
        const m = { parts: [{ id: 'p', baseY: 0, topY: 9, loops: [[[0, 0], [12, 0], [12, -9], [0, -9]] as Array<[number, number]>], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const r = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'out'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 0, sections: 0 } }), path.join(dir, 'out'));
        const south = r.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        const o = readFaceOrtho(r.dir, south)!;
        shot('cap_left_uncovered_south_face.png', o.width, o.height, o.rgba);
        // the right half shows the tile's photo; the left half, behind the cap, is uncovered (alpha 0), not flat clay
        const at = (x: number, y: number) => Array.from(o.rgba.subarray((y * o.width + x) * 4, (y * o.width + x) * 4 + 4));
        const yMid = Math.floor(o.height / 2);
        const sx = (wx: number) => Math.floor(((wx - south.origin[0]) * south.axisS[0] - south.orthoSMin) / south.pixel);
        expect(at(sx(9), yMid)[3]).toBe(255);
        expect(at(sx(9), yMid)[0]).toBeGreaterThan(150);
        expect(at(sx(3), yMid)[3]).toBe(0);
        expect(south.coverage).toBeGreaterThan(0.35);
        expect(south.coverage).toBeLessThan(0.6);
    });
});

describe('a wall off the scanned facade is baked about the photo surface (native)', () => {
    it('finds the tile\'s photo surface 3 m in front of an unsnapped wall and bakes through a slab there, reporting the offset', async () => {
        const dir = tmp();
        const W = 64, H = 64, img = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.set([60, 180, 70, 255], (y * W + x) * 4);
        // the scan's south facade stands at z = 3 while the massing's wall is at z = 0 (snapping off, as for a modelled volume)
        const p = [[0, 0, 3], [12, 0, 3], [12, 9, 3], [0, 9, 3]], uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
        const pos: number[] = [], st: number[] = [], rf: number[] = [], nrm: number[] = [];
        p.forEach((q, k) => { pos.push(...q); st.push(...uv[k]); rf.push(-2); nrm.push(0, 0, 1); });
        const node: MassingNode = { name: 'scan', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array(pos), normals: new Float32Array(nrm), ref: new Int32Array(rf), st: new Float32Array(st), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
        const tile = path.join(dir, 'tile.glb');
        fs.writeFileSync(tile, writeMassingTexturedGlb({ nodes: [node], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }), textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(W, H, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0 }).glb);
        const m = { parts: [{ id: 'p', baseY: 0, topY: 9, loops: [[[0, 0], [12, 0], [12, -9], [0, -9]] as Array<[number, number]>], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const r = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'out'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 0, sections: 0 } }), path.join(dir, 'out'));
        const south = r.report.faces.find(f => f.wall && f.normal[2] > 0.9)!;
        expect(south.coverage).toBeGreaterThan(0.85);
        expect(south.textureOffsetM).toBeGreaterThan(2.7);
        expect(south.textureOffsetM).toBeLessThan(3.3);
        const o = readFaceOrtho(r.dir, south)!;
        shot('reslab_offset_south_face.png', o.width, o.height, o.rgba);
        // off: the plane's own slab sees nothing
        const r0 = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'out0'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 0, sections: 0, reslabReach: 0 } }), path.join(dir, 'out0'));
        expect(r0.report.faces.find(f => f.wall && f.normal[2] > 0.9)!.coverage).toBeLessThan(0.05);
    });
});

describe('openings in a modelled volume\'s facets (native)', () => {
    it('cuts a window into a facet of a modelled volume, which only extruded walls took before', async () => {
        const dir = tmp();
        const W = 32, H = 32, img = new Uint8Array(W * H * 4).fill(200);
        const tile = path.join(dir, 'tile.glb');
        const scan: MassingNode = { name: 'scan', kind: 'residual', provenance: 'as-scanned', confidence: null, positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1]), normals: new Float32Array(9), ref: new Int32Array([-2, -2, -2]), st: new Float32Array(6), indices: new Uint32Array([0, 1, 2]) };
        fs.writeFileSync(tile, writeMassingTexturedGlb({ nodes: [scan], faces: [], stage: 'test', stageKey: 'k', provenanceOf: () => ({ label: 'as-scanned', measuredGeometry: true, method: 'synthetic', sources: [] }), textures: new Map(), legend: [], tileImages: new Map([[0, { bytes: new Uint8Array(encodePng(W, H, Buffer.from(img), 4)), mimeType: 'image/png' }]]), tileLegendIndex: 0 }).glb);
        // a 12 x 9 x 8 m volume, its south facet (normal +z) at z = 0, given as Google gives volumes (both windings)
        const box = doubledBox(0, 12, 0, 9, -8, 0, 0);
        const vol = singleSided({ id: 'v', vertices: box.v, indices: box.i });
        const m = { parts: [], meshes: [vol] };
        const run0 = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'a'), tile, isolate: tile, params: { pixel: 0.1, snapMaxM: 0, sections: 0, topdown: 0 } }), path.join(dir, 'a'));
        const south = run0.report.faces.find(f => f.kind === 'wall' && f.normal[2] > 0.9)!;
        expect(south.wall).toBe(false); // a facet, not an extruded wall
        const area = (r: typeof run0, key: string) => {
            const n = r.nodes.find(x => x.name === key)!;
            let a = 0;
            for (let i = 0; i < n.indices.length; i += 3) {
                const [p, q, w] = [0, 1, 2].map(k => [0, 1, 2].map(c => n.positions[n.indices[i + k] * 3 + c]));
                const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
                a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
            }
            return a;
        };
        expect(area(run0, south.key)).toBeCloseTo(108, 3);
        // a 2 x 1.5 m window in the middle of the facet, and one that does not fit (beyond its top)
        const sMid = 0.5 * (south.sMin + south.sMax), tMid = 0.5 * (south.tMin + south.tMax);
        const openings = [
            { id: 'w0', face: south.key, s0: sMid - 1, s1: sMid + 1, t0: tMid - 0.75, t1: tMid + 0.75, depth: 0.2, scanned: false, confidence: 0.6, provenance: 'generated' },
            { id: 'w1', face: south.key, s0: sMid - 1, s1: sMid + 1, t0: south.tMax - 0.5, t1: south.tMax + 1, depth: 0.2, scanned: false, confidence: 0.6, provenance: 'generated' }
        ];
        const run1 = await runMassing(massingSpecText(m, { outDir: path.join(dir, 'b'), tile, isolate: tile, openings, params: { pixel: 0.1, snapMaxM: 0, sections: 0, topdown: 0 } }), path.join(dir, 'b'));
        expect(run1.report.rejectedOpenings).toEqual(['w1']);
        expect(area(run1, south.key)).toBeCloseTo(108 - 3, 3);
        const rec = run1.nodes.find(n => n.name === 'opening:w0')!;
        expect(rec.kind).toBe('opening');
        expect(rec.provenance).toBe('generated');
        expect(rec.indices.length).toBe(30); // back, sill, head and two jambs
        // the solid stays closed: the recess replaces the hole
        const f1 = run1.report.faces.find(f => f.key === south.key)!;
        const o = readFaceOrtho(run1.dir, f1)!;
        shot('facet_window_cut.png', o.width, o.height, o.rgba);
    });
});

/** A face record for a W x H ortho at PX metres per pixel, facing +z at z = 0, s along +x, t up. */
function faceOf(index: number, W: number, H: number, PX: number, extra: Partial<MassingFace> = {}): MassingFace {
    return {
        index, key: `w${index}`, kind: 'wall', part: 'p', loop: 0, edge: index, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: [], ...extra
    } as MassingFace;
}

describe('walls that face open air', () => {
    it('tells an outside wall from a partition inside the solid', () => {
        // two boxes side by side (0..10 and 10..20 along x, 10 m tall, 0..-8 along z), with the partition at x = 10
        const box = (x0: number, x1: number): MassingNode => {
            const p: number[] = [], idx: number[] = [];
            const v = (x: number, y: number, z: number) => { p.push(x, y, z); return p.length / 3 - 1; };
            const q = (a: number[], b: number[], c: number[], d: number[]) => { const i = [a, b, c, d].map(([x, y, z]) => v(x, y, z)); idx.push(i[0], i[1], i[2], i[0], i[2], i[3]); };
            q([x0, 0, 0], [x1, 0, 0], [x1, 10, 0], [x0, 10, 0]); q([x1, 0, -8], [x0, 0, -8], [x0, 10, -8], [x1, 10, -8]);
            q([x0, 0, -8], [x0, 0, 0], [x0, 10, 0], [x0, 10, -8]); q([x1, 0, 0], [x1, 0, -8], [x1, 10, -8], [x1, 10, 0]);
            q([x0, 10, 0], [x1, 10, 0], [x1, 10, -8], [x0, 10, -8]); q([x0, 0, -8], [x1, 0, -8], [x1, 0, 0], [x0, 0, 0]);
            return { name: `b${x0}`, kind: 'wall', provenance: 'vector', confidence: null, positions: new Float32Array(p), normals: new Float32Array(p.length), ref: new Int32Array(p.length / 3), st: new Float32Array((p.length / 3) * 2), indices: new Uint32Array(idx) };
        };
        const g = solidGrid([box(0, 10), box(10, 20)]);
        const outside = faceOf(1, 400, 200, 0.05, { origin: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], sMax: 20, tMax: 10 });
        const partition = faceOf(2, 160, 200, 0.05, { origin: [10, 0, 0], normal: [1, 0, 0], axisS: [0, 0, -1], sMax: 8, tMax: 10 });
        expect(exposedShare(outside, g)).toBe(1);
        expect(exposedShare(partition, g)).toBe(0);
    });
});

const PX = 0.05, W = 360, H = 240; // 18 x 12 m: 6 bays of 3 m, 4 storeys of 3 m
/** A crisp plate: brick with dark glass at bay k, storey r: x in [3k + 0.9, 3k + 2.1], y in [3r + 0.75, 3r + 2.25] metres. */
function plate(o: { glass?: boolean } = {}): Uint8Array {
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX;
        const inWin = (o.glass ?? true) && (xm % 3) >= 0.9 && (xm % 3) < 2.1 && (ym % 3) >= 0.75 && (ym % 3) < 2.25;
        out.set(inWin ? [36, 44, 58, 255] : [176, 94, 72, 255], (y * W + x) * 4);
    }
    return out;
}
function readGrammarOff(dx: number, dy: number): FacadeGrammar {
    const tiers = [0, 1, 2, 3].map(r => ({ t0: 3 * r + 0.75 + dy, t1: 3 * r + 2.25 + dy, cols: [0, 1, 2, 3, 4, 5].map(k => [3 * k + 0.9 + dx, 3 * k + 2.1 + dx] as [number, number]) }));
    return { schema: 'scratchbox.facade-grammar/1', facadeId: 7, normal: [0, 0, 1], centroid: [9, 6, 0], tiers, storeyHeightsM: [3, 3, 3], openings: tiers.map(() => ({ widthM: 1.2, heightM: 1.5, sillM: 0, bayPitchM: 3, count: 6 })), confidence: 0.6, source: 'enhanced-plate' };
}

describe('openings from the plate\'s own lattice', () => {
    it('cuts the openings the plate shows, fitted to its edges, and refuses a lattice the plate does not show', () => {
        const f = faceOf(7, W, H, PX);
        const r = plateLatticeOpenings(readGrammarOff(0.2, -0.15), f, plate());
        expect(r.read).toBe(24);
        expect(r.kept).toBe(24);
        expect(r.grammar).toBeDefined();
        expect(r.refit.moved).toBeGreaterThan(0);
        // every kept opening within one pixel of the true window
        for (const t of r.grammar!.tiers) for (const [s0, s1] of t.cols) {
            const k = Math.floor(s0 / 3), row = Math.floor(t.t0 / 3);
            expect(Math.abs(s0 - (3 * k + 0.9))).toBeLessThanOrEqual(PX + 1e-6);
            expect(Math.abs(s1 - (3 * k + 2.1))).toBeLessThanOrEqual(PX + 1e-6);
            expect(Math.abs(t.t0 - (3 * row + 0.75))).toBeLessThanOrEqual(PX + 1e-6);
        }
        const rgba = plate();
        for (const c of r.openings) for (const [x, y] of [[c.s0, c.t0], [c.s1, c.t1]]) { const px = Math.min(W - 1, Math.round(x / PX)), py = Math.min(H - 1, Math.round(H - y / PX)); rgba.set([0, 255, 0, 255], (py * W + px) * 4); }
        shot('plate_openings_kept.png', W, H, rgba);
        // a plain wall (no glass): nothing is cut
        const blank = plateLatticeOpenings(readGrammarOff(0, 0), f, plate({ glass: false }));
        expect(blank.kept).toBe(0);
        expect(blank.grammar).toBeUndefined();
        expect(blank.why).toMatch(/the wall is not cut/);
    });

    it('labels a node built from an enhanced plate generated, never measured or photo-inferred', () => {
        const rec = massingProvenance({ kind: 'opening', provenance: 'generated', confidence: 0.6 }, { check: { iou: 0.8, heightErrMedianM: 1, heightErrP90M: 2, massingCells: 1, scanCells: 1, ok: true } });
        expect(rec.label).toBe('generated');
        expect(rec.measuredGeometry).toBe(false);
        expect(rec.method).toMatch(/AI-enhanced wall plate/);
    });
});

describe('walls the tile hardly sees, drawn in enhanced mode', () => {
    const answer = (img: Uint8Array, r: PlateRequest) => {
        const out = new Uint8Array(r.width * r.height * 4).fill(128);
        const ox = Math.floor((r.width - W) / 2), oy = Math.floor((r.height - H) / 2);
        for (let y = 0; y < H; y++) out.set(img.subarray(y * W * 4, (y + 1) * W * 4), ((y + oy) * r.width + ox) * 4);
        return new Uint8Array(encodePng(r.width, r.height, Buffer.from(out), 4));
    };
    // the tile sees a 1.5 m strip at the top right of the wall (3%); the rest is the building's flat median colour
    const input = () => {
        const truth = plate(), rgba = new Uint8Array(W * H * 4), use = new Uint8Array(W * H), source = new Uint8Array(W * H).fill(2);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (y < 30 && x >= 270) { rgba.set(truth.subarray(i * 4, i * 4 + 4), i * 4); use[i] = 1; source[i] = 0; } else rgba.set([170, 98, 80, 255], i * 4);
        }
        return { t: { width: W, height: H, rgba, source }, use };
    };
    const familyLab: [number, number, number] = [48, 25, 22];

    it('sends the unseen part grey with the unseen prompt and labels what the model drew there generated', async () => {
        const { t, use } = input();
        let sent: PlateRequest | undefined;
        const client = async (r: PlateRequest) => { sent = r; return { bytes: answer(plate(), r), modelUsed: 'fake-lite' }; };
        const f = faceOf(9, W, H, PX, { coverage: 0.03 });
        const r = await buildFacadeTexture(f, t, use, { client, models: ['fake-lite'], locationName: 'X', source: 3, unseen: { source: 11, familyLab } });
        expect(sent!.prompt).toMatch(/parts of this same wall that the scan could not see/);
        expect(sent!.prompt).not.toMatch(/stay flat mid-grey/);
        expect(r.accepted).toBe(true);
        expect(r.why).toMatch(/alignment not measured/);
        expect(r.why).toMatch(/building's median facade colour/);
        let unseen = 0, enh = 0;
        for (let i = 0; i < W * H; i++) { if (t.source[i] === 11) unseen++; if (t.source[i] === 3) enh++; }
        expect(unseen).toBe(W * H - use.reduce((a, b) => a + b, 0));
        expect(enh).toBeGreaterThan(0);
        // the drawn wall now has its windows where the unseen part was flat
        expect(t.rgba[(200 * W + 30) * 4]).toBe(36);
        shot('unseen_wall_drawn.png', W, H, t.rgba);
        // the plain prompt is unchanged (cached plates keep their keys)
        const o = { locationName: 'X', widthM: 18, heightM: 12, widthPx: 360, heightPx: 240, preserveClause: 'Keep every edge.' };
        expect(buildTexturePlatePrompt(o)).toMatch(/flat mid-grey areas are outside the scan and stay flat mid-grey/);
    });

    it('refuses a drawing that leaves the unseen part grey', async () => {
        const { t, use } = input();
        const grey = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) grey.set(use[i] ? t.rgba.subarray(i * 4, i * 4 + 4) : [128, 128, 128, 255], i * 4);
        expect(unseenGreyShare(grey, use, W * H)).toBeGreaterThan(0.99);
        // texels outside the wall's polygon (a gable's corners) are not counted
        const inside = new Uint8Array(W * H).fill(1);
        for (let i = 0; i < W * H; i++) if (!use[i] && (i % W) < 300) inside[i] = 0;
        const half = grey.slice();
        for (let i = 0; i < W * H; i++) if (inside[i] && !use[i]) half.set([150, 90, 70, 255], i * 4);
        expect(unseenGreyShare(half, use, W * H)).toBeGreaterThan(0.7);
        expect(unseenGreyShare(half, use, W * H, inside)).toBe(0);
        const before = t.source.slice();
        const r = await buildFacadeTexture(faceOf(9, W, H, PX, { coverage: 0.03 }), t, use, { client: async q => ({ bytes: answer(grey, q), modelUsed: 'fake-lite' }), models: ['fake-lite'], locationName: 'X', source: 3, unseen: { source: 11, familyLab } });
        expect(r.accepted).toBe(false);
        expect(r.why).toMatch(/left flat mid-grey/);
        expect(Array.from(t.source)).toEqual(Array.from(before));
    });

    it('checks the colour family against the building when the tile covers too little, and says so', () => {
        const a = plate(), use = new Uint8Array(W * H);
        const g = identityGate(a, a, W, H, use, { askedAspect: 1.5, answeredAspect: 1.5, chamferPx: 0, lostShare: 0, grossNotMeasured: 'test', colourAgainst: [10, 0, 0] });
        expect(g.colour.passed).toBe(false);
        expect(g.why).toMatch(/building's median facade colour/);
        expect(g.gross.passed).toBe(true);
    });
});
