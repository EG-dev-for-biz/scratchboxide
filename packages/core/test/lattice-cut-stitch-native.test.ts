/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native cut, stitch, clip and fill texturing (scratchbox_lattice_cut.hpp, scratchbox_lattice_stitch.hpp and
 * scratchbox_fill_texture.hpp, SCRATCHBOX_K_NATIVE's `cut`, `stitch`, `clip` and `fill-texture`) against
 * pipeline-k/lattice-stitch.ts on a small synthetic building: a scan box of two meshes whose triangles carry normals, UVs
 * (with a seam: two triangles sharing an edge's positions but not its UVs) and a flag attribute, and two rebuilt facades
 * meeting at its corner. The cut (plain, keeping the pieces inside, same-facing only), a whole stitch round (each facade
 * made watertight, the scan cut, the walls appended, the strips and corner zips), the clip to a footprint that crosses
 * the box, and the fill of what is left open textured in a twin whose rebuilt walls carry their photos, give the same
 * GLBs byte for byte, the same reports and the same cells left unjoined. The binary is compiled with the
 * real clang++; nothing here reaches a network or a credential.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFacadeLattices, facadeSamples, latticeFacade, type FacadeLatticeResult, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { clipToFootprint, cutScanToLattice, fillOpenLoops, LATTICE_STITCH_PARAMS, stitchLattice, watertightLatticeMesh } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { writeStagedGlbFile, type StagedGlbNode } from '../src/node/3d-engine/staged-location/staged-glb-writer';

const PX = 0.1;
type V3 = [number, number, number];
function facadeOf(id: number, centroid: V3, normal: V3, axisS: V3, half: number): ReliefFacade {
    return { facadeId: id, image: `facade_${id}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: -half, sMax: half, tMin: -7.5, tMax: 7.5, pixel: PX, width: Math.round((2 * half) / PX), height: Math.round(15 / PX), orthoSMin: -half, orthoTMax: 7.5, coverage: 1 };
}
// the front (z = 12) and the right side (x = 16) of a 16 x 12 x 15 m box, meeting at its corner
const FRONT = facadeOf(0, [8, 7.5, 12], [0, 0, 1], [1, 0, 0], 8), RIGHT = facadeOf(1, [16, 7.5, 6], [1, 0, 0], [0, 0, -1], 6);
const BACK = facadeOf(2, [8, 7.5, 0], [0, 0, -1], [-1, 0, 0], 8), LEFT = facadeOf(3, [0, 7.5, 6], [-1, 0, 0], [0, 0, 1], 6);
const inWindow = (u: number, v: number) => { const a = u % 3, b = v % 3; return a > 0.9 && a < 2.1 && b > 0.7 && b < 2.3; };

let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** One face of the scan on a 0.5 m grid, recessed in its windows, as two vertex sets meeting at u = half the width (a UV seam). */
function faceNode(f: ReliefFacade, name: string, flag: number): StagedGlbNode {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], flags: number[] = [], idx: number[] = [];
    const width = f.sMax - f.sMin, mid = Math.round(width / 2);
    for (const [u0, u1, shift] of [[0, mid, 0], [mid, width, 0.37]] as const) {
        const nu = Math.round((u1 - u0) / 0.5), nv = 30, base = pos.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
            const u = u0 + i * 0.5, v = j * 0.5, d = (inWindow(u, v) ? -0.25 : 0) + (rnd() - 0.5) * 0.06;
            for (let k = 0; k < 3; k++) pos.push(f.centroid[k] + (f.sMin + u) * f.axisS[k] + (f.tMin + v) * f.axisT[k] + d * f.normal[k]);
            nrm.push(...f.normal);
            uv.push(u / width + shift, 1 - v / 15);
            flags.push(flag + (i % 2));
        }
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
            const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 2, d = a + nu + 1;
            idx.push(a, b, c, a, c, d);
        }
    }
    return { name, positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uv: Float32Array.from(uv), attributes: { _FLAG: Float32Array.from(flags) }, indices: Uint32Array.from(idx) };
}

/** A facade's photo: windows darker than the wall. */
function photo(f: ReliefFacade): { rgba: Uint8Array; width: number; height: number } {
    const { width: W, height: H } = f, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = inWindow((x + 0.5) * PX, 15 - (y + 0.5) * PX) ? 45 : 200; rgba.set([v, v, v + 10, 255], (y * W + x) * 4); }
    return { rgba, width: W, height: H };
}

function withNative<T>(mode: '0' | '1', fn: () => T): { out: T; ms: number } {
    const was = process.env.SCRATCHBOX_K_NATIVE;
    process.env.SCRATCHBOX_K_NATIVE = mode;
    try { const t0 = performance.now(); const out = fn(); return { out, ms: performance.now() - t0 }; }
    finally { if (was === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = was; }
}

describe('lattice cut and stitch: native against TypeScript', () => {
    let scan: Buffer, facades: Array<{ f: ReliefFacade; r: FacadeLatticeResult }>;
    beforeAll(async () => {
        await ensureRemeshPolishBinary();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-cut-native-'));
        const file = path.join(dir, 'scan.glb');
        // two meshes: the front and right faces, then the back and left
        const a = faceNode(FRONT, 'scan_a', 0), b = faceNode(RIGHT, 'scan_a2', 2), c = faceNode(BACK, 'scan_b', 4), d = faceNode(LEFT, 'scan_b2', 6);
        const join = (x: StagedGlbNode, y: StagedGlbNode, name: string): StagedGlbNode => {
            const n = x.positions.length / 3;
            return { name, positions: Float32Array.from([...x.positions, ...y.positions]), normals: Float32Array.from([...x.normals!, ...y.normals!]), uv: Float32Array.from([...x.uv!, ...y.uv!]), attributes: { _FLAG: Float32Array.from([...x.attributes!._FLAG, ...y.attributes!._FLAG]) }, indices: Uint32Array.from([...x.indices!, ...Array.from(y.indices!, i => i + n)]) };
        };
        // textured, so the stitch's textured append reads the scan's photo at the strips' corners
        const texture = encodePng(8, 8, Uint8Array.from({ length: 256 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256)), 4);
        writeStagedGlbFile(file, [join(a, b, 'scan_front_right'), join(c, d, 'scan_back_left')], { texture: { bytes: texture, mimeType: 'image/png' } });
        scan = fs.readFileSync(file);
        fs.rmSync(dir, { recursive: true, force: true });
        const soup: number[] = [];
        for (const n of [a, b, c, d]) for (const i of n.indices!) soup.push(n.positions[i * 3], n.positions[i * 3 + 1], n.positions[i * 3 + 2]);
        facades = [FRONT, RIGHT].map(f => ({ f, r: latticeFacade(f, photo(f), facadeSamples(Float32Array.from(soup), f))! }));
    }, 900_000);

    it('cuts the scan the same: plain, keeping the pieces inside, and same-facing only', () => {
        for (const P of [LATTICE_STITCH_PARAMS, { ...LATTICE_STITCH_PARAMS, cutKeepInside: true, cutSameFacing: true }]) {
            const ts = withNative('0', () => cutScanToLattice(Uint8Array.from(scan), facades, P));
            const nat = withNative('1', () => cutScanToLattice(Uint8Array.from(scan), facades, P));
            expect(ts.out.report.cutTriangles).toBeGreaterThan(100);
            expect(ts.out.report.removedPieces).toBeGreaterThan(100);
            expect(nat.out.report).toEqual(ts.out.report);
            expect(Buffer.compare(nat.out.glb, ts.out.glb)).toBe(0);
            console.log(`lattice cut, ${ts.out.report.cutTriangles} triangles cut into ${ts.out.report.keptPieces + ts.out.report.removedPieces} pieces: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
        }
    }, 300_000);

    it('stitches a round the same: strips, corner zips, the report and the cells left unjoined', () => {
        const round = () => {
            const sealed = facades.map(d => ({ ...d, r: { ...d.r, ...watertightLatticeMesh(d.f, d.r) } }));
            const cut = cutScanToLattice(Uint8Array.from(scan), sealed);
            const clay = applyFacadeLattices(cut.glb, sealed, false, undefined, { removeScan: false });
            return stitchLattice(clay.glb, [clay.glb], sealed);
        };
        const ts = withNative('0', round), nat = withNative('1', round);
        expect(ts.out.report.stitched).toBeGreaterThan(0);
        expect(Object.keys(ts.out.report.why).length).toBeGreaterThan(0);
        expect(nat.out.report).toEqual(ts.out.report);
        expect([...nat.out.unjoinedCells]).toEqual([...ts.out.unjoinedCells]);
        expect(Buffer.compare(nat.out.clay, ts.out.clay)).toBe(0);
        expect(Buffer.compare(nat.out.others[0], ts.out.others[0])).toBe(0);
        console.log(`lattice stitch round, ${ts.out.report.segments} segments (${ts.out.report.stitched} stitched, ${ts.out.report.cornersZipped} corners zipped): TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
    }, 300_000);

    // a footprint that crosses the box: its left 2 m and a corner of its front outside, a notch in the back
    const FOOTPRINT: Array<[number, number]> = [[2, -0.5], [9, -0.5], [9, 1.5], [11, 1.5], [11, -0.5], [16.5, -0.5], [16.5, 9], [13, 12.5], [2, 12.5]];

    it('clips the scan to the footprint the same, at every margin', () => {
        for (const margin of [0, 0.3]) {
            const ts = withNative('0', () => clipToFootprint(Uint8Array.from(scan), [FOOTPRINT], margin));
            const nat = withNative('1', () => clipToFootprint(Uint8Array.from(scan), [FOOTPRINT], margin));
            expect(ts.out.report.cutTriangles).toBeGreaterThan(10);
            expect(ts.out.report.removedTriangles).toBeGreaterThan(10);
            expect(nat.out.report).toEqual(ts.out.report);
            expect(Buffer.compare(nat.out.glb, ts.out.glb)).toBe(0);
            console.log(`footprint clip (${margin} m), ${ts.out.report.cutTriangles} triangles cut, ${ts.out.report.removedTriangles} removed: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
        }
    }, 300_000);

    it('leaves the rebuilt facades whole when asked (a scan-outline footprint), still clipping the scan, natively and here alike', () => {
        const withWalls = applyFacadeLattices(Uint8Array.from(scan), facades, false, undefined, { removeScan: false }).glb;
        // the rebuilt facades' live triangles (the clip makes a removed one degenerate in place)
        const wallTriangles = (glb: Buffer) => {
            const g = parseGlbBytes(glb);
            let n = 0;
            for (const node of g.json.nodes) {
                if (!(node.name ?? '').startsWith('FacadeLattice_')) continue;
                for (const p of g.json.meshes[node.mesh].primitives) {
                    const I = readAccessor(g, p.indices).data;
                    for (let t = 0; t + 2 < I.length; t += 3) if (I[t] !== I[t + 1] && I[t + 1] !== I[t + 2] && I[t] !== I[t + 2]) n++;
                }
            }
            return n;
        };
        const keepNodes = { keep: (name: string) => name.startsWith('FacadeLattice_'), why: 'test' };
        const before = wallTriangles(withWalls);
        const plain = withNative('0', () => clipToFootprint(Uint8Array.from(withWalls), [FOOTPRINT], 0.3));
        const ts = withNative('0', () => clipToFootprint(Uint8Array.from(withWalls), [FOOTPRINT], 0.3, { keepNodes }));
        const nat = withNative('1', () => clipToFootprint(Uint8Array.from(withWalls), [FOOTPRINT], 0.3, { keepNodes }));
        // the footprint crosses the box's left 2 m: a plain clip cuts the front wall there, the kept clip leaves it whole
        expect(wallTriangles(plain.out.glb)).toBeLessThan(before);
        expect(wallTriangles(ts.out.glb)).toBe(before);
        expect(ts.out.report.keptNodes).toBe(facades.length);
        expect(ts.out.report.removedTriangles).toBeGreaterThan(10);
        expect(nat.out.report).toEqual(ts.out.report);
        expect(Buffer.compare(nat.out.glb, ts.out.glb)).toBe(0);
    }, 300_000);

    it('textures the fill the same: on a rebuilt wall, at its corners, continued from a wall, or clay', () => {
        // the walls rebuilt over the cut scan, the twin's with their photos; the clip opens the base and the left
        const sealed = facades.map(d => ({ ...d, r: { ...d.r, ...watertightLatticeMesh(d.f, d.r) } }));
        const textured = sealed.map(d => ({ ...d, png: encodePng(d.f.width, d.f.height, photo(d.f).rgba, 4) }));
        const cut = cutScanToLattice(Uint8Array.from(scan), sealed).glb;
        const clay = clipToFootprint(applyFacadeLattices(cut, sealed, false, undefined, { removeScan: false }).glb, [FOOTPRINT], 0.3).glb;
        const twin = clipToFootprint(applyFacadeLattices(cut, textured, true, undefined, { removeScan: false }).glb, [FOOTPRINT], 0.3).glb;
        const fill = () => fillOpenLoops(Uint8Array.from(clay), [Uint8Array.from(twin)], { footprint: [FOOTPRINT] });
        const ts = withNative('0', fill), nat = withNative('1', fill);
        const seal = (glb: Buffer) => parseGlbBytes(glb).json.nodes.find((n: any) => n.extras?.sbSeal)?.extras.sbSeal;
        const routes = seal(ts.out.others[0]);
        expect(routes.wallInfill + routes.cornerTextured + routes.continued).toBeGreaterThan(0);
        expect(nat.out.report).toEqual(ts.out.report);
        expect(seal(nat.out.others[0])).toEqual(routes);
        expect(Buffer.compare(nat.out.clay, ts.out.clay)).toBe(0);
        expect(Buffer.compare(nat.out.others[0], ts.out.others[0])).toBe(0);
        console.log(`fill textured, ${routes.wallInfill} pieces on a wall, ${routes.cornerTextured} at their corners, ${routes.continued} continued, ${routes.clay} clay: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
    }, 300_000);
});
