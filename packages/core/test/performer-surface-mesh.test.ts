/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { decodeGaussianPly } from '../src/common/gaussian-ply-codec';
import {
    PerformerSurfaceMeshService,
    SurfaceMesh,
    SurfaceSplat,
    decodeSurfaceGlb
} from '../src/node/spatial/PerformerSurfaceMeshService';
import { requireAsset, withReason } from './helpers/requirements';

const SURFACE_PRODUCER = 'scripts/build_performer_surfaces.ts (from the demo built by scripts/regenerate_5_demos.ts)';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEMOS_DIR = path.join(REPO_ROOT, 'models/performer_4dgs/demos');
const PUBLIC_MODELS = path.join(REPO_ROOT, 'public/models');

function triangleMesh(): SurfaceMesh {
    return {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        skinIndices: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
        skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    };
}

/** Unit octahedron subdivided and projected onto a sphere of the given radius. */
function sphereMesh(radius: number, levels: number): SurfaceMesh {
    const base: SurfaceMesh = {
        positions: new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
        indices: new Uint32Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]),
        skinIndices: new Uint8Array(24),
        skinWeights: new Float32Array(24).map((_, i) => (i % 4 === 0 ? 1 : 0))
    };
    const sub = PerformerSurfaceMeshService.subdivideMidpoint(base, levels);
    for (let i = 0; i < sub.positions.length; i += 3) {
        const l = Math.hypot(sub.positions[i], sub.positions[i + 1], sub.positions[i + 2]);
        for (let a = 0; a < 3; a++) sub.positions[i + a] *= radius / l;
    }
    return sub;
}

function fibonacciSphere(n: number, radius: number): Array<[number, number, number]> {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        const phi = i * Math.PI * (3 - Math.sqrt(5));
        pts.push([Math.cos(phi) * r * radius, y * radius, Math.sin(phi) * r * radius]);
    }
    return pts;
}

describe('PerformerSurfaceMeshService', () => {
    it('midpoint-subdivides with shared edges and blended skin weights', () => {
        const one = PerformerSurfaceMeshService.subdivideMidpoint(triangleMesh(), 1);
        expect(one.positions.length / 3).toBe(6);
        expect(one.indices.length / 3).toBe(4);
        const two = PerformerSurfaceMeshService.subdivideMidpoint(triangleMesh(), 2);
        expect(two.positions.length / 3).toBe(15);
        expect(two.indices.length / 3).toBe(16);

        const quad: SurfaceMesh = {
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
            skinIndices: new Uint8Array(16),
            skinWeights: new Float32Array(16).map((_, i) => (i % 4 === 0 ? 1 : 0))
        };
        expect(PerformerSurfaceMeshService.subdivideMidpoint(quad, 1).positions.length / 3).toBe(9);

        // Midpoint of v0 (bone 0) and v1 (bone 1) sits at (0.5, 0, 0) with 50/50 weights.
        let mid = -1;
        for (let i = 0; i < 6; i++) {
            if (Math.abs(one.positions[i * 3] - 0.5) < 1e-6 && Math.abs(one.positions[i * 3 + 1]) < 1e-6) mid = i;
        }
        expect(mid).toBeGreaterThanOrEqual(0);
        const w: Record<number, number> = {};
        for (let k = 0; k < 4; k++) w[one.skinIndices[mid * 4 + k]] = (w[one.skinIndices[mid * 4 + k]] || 0) + one.skinWeights[mid * 4 + k];
        expect(w[0]).toBeCloseTo(0.5, 5);
        expect(w[1]).toBeCloseTo(0.5, 5);
        for (let i = 0; i < two.positions.length / 3; i++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += two.skinWeights[i * 4 + k];
            expect(s).toBeCloseTo(1, 5);
        }
    });

    it('moves the surface out to the opaque splat shell and colors it from that shell only', () => {
        const mesh = sphereMesh(0.1, 3);
        const splats: SurfaceSplat[] = [
            ...fibonacciSphere(6000, 0.13).map(p => ({ position: p, colorRgb: (p[0] >= 0 ? [1, 0, 0] : [0, 0, 1]) as [number, number, number], opacity: 0.9 })),
            ...fibonacciSphere(3000, 0.05).map(p => ({ position: p, colorRgb: [0, 1, 0] as [number, number, number], opacity: 0.9 })),
            ...fibonacciSphere(2000, 0.118).map(p => ({ position: p, colorRgb: [0, 1, 0] as [number, number, number], opacity: 0.5 })),
            ...fibonacciSphere(3000, 0.16).map(p => ({ position: p, colorRgb: [1, 1, 0] as [number, number, number], opacity: 0.01 }))
        ];
        const fitted = new PerformerSurfaceMeshService().fitToSplats(mesh, splats, { maxOffset: 0.06, linearizeColors: false });
        const n = fitted.positions.length / 3;
        let radial = 0;
        for (let i = 0; i < n; i++) {
            const [x, y, z] = [fitted.positions[i * 3], fitted.positions[i * 3 + 1], fitted.positions[i * 3 + 2]];
            radial += Math.hypot(x, y, z) / n;
            const [r, g, b] = [fitted.colors![i * 3], fitted.colors![i * 3 + 1], fitted.colors![i * 3 + 2]];
            expect(g).toBeLessThan(0.05);
            if (x > 0.03) { expect(r).toBeGreaterThan(0.9); expect(b).toBeLessThan(0.1); }
            if (x < -0.03) { expect(b).toBeGreaterThan(0.9); expect(r).toBeLessThan(0.1); }
        }
        expect(radial).toBeGreaterThan(0.125);
        expect(radial).toBeLessThan(0.135);
        expect(fitted.normals!.length).toBe(fitted.positions.length);
    });

    it('ignores splats bound to unrelated bones (a hand never inflates onto the thigh beside it)', () => {
        const mesh = sphereMesh(0.1, 3);
        mesh.skinIndices.fill(0);
        for (let i = 0; i < mesh.skinIndices.length; i += 4) mesh.skinIndices[i] = 20;
        const splats: SurfaceSplat[] = [
            ...fibonacciSphere(6000, 0.12).map(p => ({ position: p, colorRgb: [1, 0, 0] as [number, number, number], opacity: 0.9, bone: 20 })),
            ...fibonacciSphere(6000, 0.15).map(p => ({ position: p, colorRgb: [1, 1, 0] as [number, number, number], opacity: 0.9, bone: 1 }))
        ];
        const fitted = new PerformerSurfaceMeshService().fitToSplats(mesh, splats, { maxOffset: 0.06, linearizeColors: false });
        const n = fitted.positions.length / 3;
        let radial = 0;
        for (let i = 0; i < n; i++) {
            radial += Math.hypot(fitted.positions[i * 3], fitted.positions[i * 3 + 1], fitted.positions[i * 3 + 2]) / n;
            expect(fitted.colors![i * 3 + 1]).toBeLessThan(0.05);
        }
        expect(radial).toBeLessThan(0.125);
    });

    it('keeps adjacent thin parts separate (a finger never inflates onto its neighbour)', () => {
        // Two 2 cm-thick disks 1.5 cm apart, like neighbouring fingers; splats sit exactly on each surface.
        const disk = (dy: number): SurfaceMesh => {
            const m = sphereMesh(0.05, 3);
            for (let i = 1; i < m.positions.length; i += 3) m.positions[i] = m.positions[i] * 0.2 + dy;
            return m;
        };
        const a = disk(0), b = disk(0.035);
        const na = a.positions.length / 3;
        const mesh: SurfaceMesh = {
            positions: new Float32Array([...a.positions, ...b.positions]),
            indices: new Uint32Array([...a.indices, ...Array.from(b.indices).map(i => i + na)]),
            skinIndices: new Uint8Array([...a.skinIndices, ...b.skinIndices]),
            skinWeights: new Float32Array([...a.skinWeights, ...b.skinWeights])
        };
        const shell = (dy: number) => fibonacciSphere(8000, 0.05)
            .map(p => ({ position: [p[0], p[1] * 0.2 + dy, p[2]] as [number, number, number], colorRgb: [0.6, 0.4, 0.3] as [number, number, number], opacity: 0.9 }));
        const fitted = new PerformerSurfaceMeshService().fitToSplats(mesh, [...shell(0), ...shell(0.035)], { maxOffset: 0.08 });
        let maxY = 0;
        for (let i = 0; i < na; i++) maxY = Math.max(maxY, fitted.positions[i * 3 + 1]);
        expect(maxY).toBeLessThan(0.014);
    });

    it('rejects chromatic floaters and rogue color outliers without poisoning the surface albedo', () => {
        const mesh = sphereMesh(0.1, 3);
        const blackSplats: SurfaceSplat[] = fibonacciSphere(5000, 0.11).map(p => ({
            position: p,
            colorRgb: [0.03, 0.03, 0.03] as [number, number, number],
            opacity: 0.9
        }));
        // Inject 10% rogue bright cyan and red floaters close to the surface
        const rogueSplats: SurfaceSplat[] = fibonacciSphere(500, 0.108).map((p, idx) => ({
            position: p,
            colorRgb: (idx % 2 === 0 ? [0.75, 0.95, 0.85] : [0.99, 0.05, 0.02]) as [number, number, number],
            opacity: 0.95
        }));
        const fitted = new PerformerSurfaceMeshService().fitToSplats(mesh, [...blackSplats, ...rogueSplats], {
            maxOffset: 0.05,
            linearizeColors: false
        });
        const n = fitted.positions.length / 3;
        for (let i = 0; i < n; i++) {
            const r = fitted.colors![i * 3], g = fitted.colors![i * 3 + 1], b = fitted.colors![i * 3 + 2];
            // Must stay authentic clean black (< 0.06), never poisoned by cyan or red floaters
            expect(r).toBeLessThan(0.06);
            expect(g).toBeLessThan(0.06);
            expect(b).toBeLessThan(0.06);
        }
    });

    it('encodes a binary glTF 2.0 with position, normal, color and skin attributes', () => {
        const mesh = new PerformerSurfaceMeshService().fitToSplats(sphereMesh(0.1, 1), fibonacciSphere(500, 0.1)
            .map(p => ({ position: p, colorRgb: [0.5, 0.5, 0.5] as [number, number, number], opacity: 1 })), { maxOffset: 0.02 });
        const glb = PerformerSurfaceMeshService.encodeGlb(mesh);
        expect(glb.readUInt32LE(0)).toBe(0x46546c67);
        expect(glb.readUInt32LE(4)).toBe(2);
        expect(glb.readUInt32LE(8)).toBe(glb.length);
        const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf-8'));
        const attrs = json.meshes[0].primitives[0].attributes;
        for (const a of ['POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0']) expect(attrs[a]).toBeDefined();
        expect(json.accessors[attrs.POSITION].min).toHaveLength(3);
        expect(json.skins).toBeDefined();
        expect(json.skins[0].joints).toHaveLength(22);
        expect(json.nodes).toHaveLength(23); // node 0 (mesh) + 22 bone nodes
        expect(json.nodes[0].skin).toBe(0);
        expect(json.nodes[1].name).toBe('pelvis');
        const back = decodeSurfaceGlb(glb);
        expect(back.positions.length).toBe(mesh.positions.length);
        expect(back.indices.length).toBe(mesh.indices.length);
        expect(Array.from(back.skinIndices.slice(0, 8))).toEqual(Array.from(mesh.skinIndices.slice(0, 8)));
    });
});

describe('Rebuilt Photoreal Surface meshes', () => {
    const demos = fs.existsSync(DEMOS_DIR)
        ? fs.readdirSync(DEMOS_DIR).filter(id => fs.existsSync(path.join(PUBLIC_MODELS, `humanoid_${id}.glb`))
            && fs.existsSync(path.join(DEMOS_DIR, id, 'gvhmr_body.json')))
        : [];

    // The per-demo cases below are generated from whatever is installed; say so when nothing is.
    if (demos.length === 0) {
        it.skip(withReason('per-demo rebuilt surface checks', {
            ok: false,
            reason: `no demo has both public/models/humanoid_<id>.glb and models/performer_4dgs/demos/<id>/gvhmr_body.json (gitignored; regenerate with ${SURFACE_PRODUCER})`
        }), () => {});
    }

    for (const id of demos) {
        it(`${id}: surface lies on its trained splats in the canonical pose`, () => {
            const mesh = decodeSurfaceGlb(fs.readFileSync(path.join(PUBLIC_MODELS, `humanoid_${id}.glb`)));
            expect(mesh.positions.length / 3).toBeGreaterThan(100000);
            const { gaussians } = decodeGaussianPly(fs.readFileSync(path.join(DEMOS_DIR, id, 'human_4dgs.ply'), 'utf-8'));
            const cell = 0.05;
            const grid = new Map<string, number[]>();
            gaussians.forEach((g, i) => {
                const k = g.position.map(v => Math.floor(v / cell)).join(',');
                (grid.get(k) || grid.set(k, []).get(k)!).push(i);
            });
            const dists: number[] = [];
            const n = mesh.positions.length / 3;
            for (let s = 0; s < 400; s++) {
                const i = Math.floor((s * 7919) % n);
                const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
                const c = p.map(v => Math.floor(v / cell));
                let best = Infinity;
                for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                    for (const j of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) || []) {
                        const q = gaussians[j].position;
                        best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
                    }
                }
                dists.push(best);
            }
            dists.sort((a, b) => a - b);
            expect(dists[Math.floor(dists.length / 2)]).toBeLessThan(0.02);
            expect(dists[Math.floor(dists.length * 0.95)]).toBeLessThan(0.05);
        });

        it(`${id}: hands and head stay within 25% of the fitted body's size`, () => {
            const mesh = decodeSurfaceGlb(fs.readFileSync(path.join(PUBLIC_MODELS, `humanoid_${id}.glb`)));
            const body = JSON.parse(fs.readFileSync(path.join(DEMOS_DIR, id, 'gvhmr_body.json'), 'utf-8'));
            const extent = (count: number, pos: (i: number) => number[], bone: (i: number) => number, b: number) => {
                const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
                for (let i = 0; i < count; i++) {
                    if (bone(i) !== b) continue;
                    const p = pos(i);
                    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
                }
                return hi.map((h, a) => h - lo[a]);
            };
            const meshBone = (i: number) => {
                let best = 0;
                for (let k = 1; k < 4; k++) if (mesh.skinWeights[i * 4 + k] > mesh.skinWeights[i * 4 + best]) best = k;
                return mesh.skinIndices[i * 4 + best];
            };
            const bodyBone = (i: number) => body.skin_indices[i][body.skin_weights[i].indexOf(Math.max(...body.skin_weights[i]))];
            for (const b of [15, 20, 21]) {
                const fitted = extent(mesh.positions.length / 3, i => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], meshBone, b);
                const rest = extent(body.rest_vertices.length, i => body.rest_vertices[i], bodyBone, b);
                const allowance = b === 15 ? 0.06 : 0.03;
                for (let a = 0; a < 3; a++) expect(fitted[a]).toBeLessThan(rest[a] * 1.25 + allowance);
            }
        });

        it(`${id}: head and hands have zero displacement from anatomical rest surface`, () => {
            const mesh = decodeSurfaceGlb(fs.readFileSync(path.join(PUBLIC_MODELS, `humanoid_${id}.glb`)));
            const body = JSON.parse(fs.readFileSync(path.join(DEMOS_DIR, id, 'gvhmr_body.json'), 'utf-8'));
            const rest = body.rest_vertices;
            let maxHeadDisp = 0;
            let maxHandDisp = 0;
            for (let i = 0; i < rest.length; i++) {
                const b = body.skin_indices[i][body.skin_weights[i].indexOf(Math.max(...body.skin_weights[i]))];
                const d = Math.hypot(mesh.positions[i * 3] - rest[i][0], mesh.positions[i * 3 + 1] - rest[i][1], mesh.positions[i * 3 + 2] - rest[i][2]);
                if (b === 15) maxHeadDisp = Math.max(maxHeadDisp, d);
                if (b === 20 || b === 21) maxHandDisp = Math.max(maxHandDisp, d);
            }
            expect(maxHeadDisp).toBeLessThan(0.06);
            expect(maxHandDisp).toBeLessThan(0.03);
        });
    }

    const manInBlack = requireAsset('public/models/humanoid_man-in-black.glb',
        'scripts/build_performer_surfaces.ts man-in-black (source clip from scripts/generate_man_in_black_performer.ts)');
    it.skipIf(!manInBlack.ok)(withReason('man-in-black: front face has authentic smooth skin tone without black/white static', manInBlack), () => {
        const mesh = decodeSurfaceGlb(fs.readFileSync(path.join(PUBLIC_MODELS, 'humanoid_man-in-black.glb')));
        const nv = mesh.positions.length / 3;
        const col = mesh.colors!;
        let faceVertCount = 0;
        let blackCount = 0;
        let whiteCount = 0;
        for (let i = 0; i < nv; i++) {
            const b = mesh.skinIndices[i * 4];
            if (b !== 15) continue;
            const y = mesh.positions[i * 3 + 1];
            const z = mesh.positions[i * 3 + 2];
            // Front face zone
            if (z > 0.03 && y > 1.55 && y < 1.72) {
                faceVertCount++;
                const r = col[i * 3], g = col[i * 3 + 1], bCol = col[i * 3 + 2];
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bCol;
                if (lum < 0.10) blackCount++;
                if (lum > 0.85) whiteCount++;
            }
        }
        expect(faceVertCount).toBeGreaterThan(1000);
        // Under 70% black static on the front face (for bearded/dark features)
        expect(blackCount / faceVertCount).toBeLessThan(0.70);
        expect(whiteCount / faceVertCount).toBeLessThan(0.03);
    });
});
