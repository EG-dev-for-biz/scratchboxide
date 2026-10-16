/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * A trees GLB that follows the tree LOD contract at realistic triangle counts per tree: about 90k drawn at level 0
 * (grown wood + instanced leaf clusters of 8-12 cm blades), about 11k at level 1 (the same cluster positions, 8 larger
 * leaves per cluster), about 1.4k at level 2 (trunk, limbs and blob masses). Trees are placed from a handful of grown
 * shapes (glTF nodes may share a mesh), scattered over a square of the park with seeded jitter and scale.
 * Test fixture only: the shapes are stand-ins for the native generator's, the structure is the contract's.
 */

import type { TreeLodExtras, TreesGlbRootExtras } from '../../src/common/spatial/staged-location-contracts';

export interface ScaledTreesOptions {
    trees?: number;
    variants?: number;
    /** Side of the square the trees are scattered over (m). */
    areaM?: number;
    seed?: number;
    /** Blade length of a leaf at level 0 (m). */
    bladeM?: number;
    psiSeason?: number;
}

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

interface Geo { pos: number[]; nrm: number[]; idx: number[] }
const newGeo = (): Geo => ({ pos: [], nrm: [], idx: [] });

/** A tapered tube along a polyline of (point, radius) with `sides` sides. */
function tube(g: Geo, pts: Array<{ p: V3; r: number }>, sides: number): void {
    let prevRing = -1;
    for (let i = 0; i < pts.length; i++) {
        const t = norm(sub(pts[Math.min(i + 1, pts.length - 1)].p, pts[Math.max(i - 1, 0)].p));
        const a = norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0]));
        const b = cross(t, a);
        const ring = g.pos.length / 3;
        for (let s = 0; s < sides; s++) {
            const ang = (2 * Math.PI * s) / sides;
            const n = add(mul(a, Math.cos(ang)), mul(b, Math.sin(ang)));
            const q = add(pts[i].p, mul(n, pts[i].r));
            g.pos.push(...q); g.nrm.push(...n);
        }
        if (prevRing >= 0) for (let s = 0; s < sides; s++) {
            const s1 = (s + 1) % sides;
            g.idx.push(prevRing + s, ring + s, ring + s1, prevRing + s, ring + s1, prevRing + s1);
        }
        prevRing = ring;
    }
}

/** An ovate blade of `rows` rows (2 triangles each side of the midrib per row pair), pointing along `dir`, lying in the plane spanned by dir and `side`. */
function blade(g: Geo, origin: V3, dir: V3, side: V3, len: number, rows: number): void {
    const n = norm(cross(dir, side));
    const first = g.pos.length / 3;
    for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const w = len * 0.5 * 0.62 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9);   // ovate outline: widest below the middle
        const c = add(origin, mul(dir, len * t));
        for (const sgn of [-1, 1]) { g.pos.push(...add(c, mul(side, sgn * w))); g.nrm.push(...n); }
    }
    for (let r = 0; r < rows; r++) {
        const a = first + 2 * r;
        g.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
}

function blob(g: Geo, c: V3, rx: number, ry: number, rz: number, rnd: () => number): void {
    // a lumpy icosphere-free blob: a latitude/longitude sphere of 12 x 8 with seeded radial noise
    const seg = 12, rings = 8, first = g.pos.length / 3;
    for (let i = 0; i <= rings; i++) for (let j = 0; j < seg; j++) {
        const th = (Math.PI * i) / rings, ph = (2 * Math.PI * j) / seg;
        const n: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        const k = 1 + 0.18 * (rnd() - 0.5);
        g.pos.push(c[0] + n[0] * rx * k, c[1] + n[1] * ry * k, c[2] + n[2] * rz * k); g.nrm.push(...n);
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
        const a = first + i * seg + j, b = first + i * seg + ((j + 1) % seg), c2 = a + seg, d = b + seg;
        g.idx.push(a, d, c2, a, b, d);
    }
}

interface TreeShape { wood0: Geo; wood1: Geo; far: Geo; leafSpots: Array<{ p: V3; d: V3 }>; height: number }

function growShape(rnd: () => number, heightM: number): TreeShape {
    const wood0 = newGeo(), wood1 = newGeo(), far = newGeo();
    const spots: Array<{ p: V3; d: V3 }> = [];
    const trunkTop = heightM * (0.28 + 0.2 * rnd());
    const grow = (start: V3, dir: V3, len: number, r0: number, depth: number): void => {
        const segs = Math.max(2, Math.round(len / (depth <= 1 ? 0.9 : 0.5)));
        const pts: Array<{ p: V3; r: number }> = [];
        let p = start, d = dir;
        for (let i = 0; i <= segs; i++) {
            pts.push({ p, r: r0 * (1 - 0.8 * (i / segs)) + 0.004 });
            d = norm(add(d, [(rnd() - 0.5) * 0.18, 0.02 + (depth > 1 ? -0.02 : 0.05), (rnd() - 0.5) * 0.18]));
            p = add(p, mul(d, len / segs));
        }
        tube(wood0, pts, depth <= 1 ? 10 : 8);
        if (depth <= 2) tube(wood1, pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1), depth <= 1 ? 6 : 4);
        if (depth <= 1) tube(far, pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1), 5);
        const tip = pts[pts.length - 1].p;
        if (depth >= 4 || len < 0.9) { spots.push({ p: tip, d }); return; }
        const kids = depth <= 1 ? 3 : 2 + (rnd() < 0.5 ? 1 : 0);
        for (let k = 0; k < kids; k++) {
            const at = pts[Math.max(1, Math.floor(pts.length * (0.45 + 0.5 * rnd())))];
            const ang = (2 * Math.PI * (k + rnd())) / kids;
            const spread = 0.5 + 0.5 * rnd();
            const nd = norm(add(mul(d, 0.8), [Math.cos(ang) * spread, 0.25 + 0.2 * rnd(), Math.sin(ang) * spread]));
            grow(at.p, nd, len * (0.62 + 0.15 * rnd()), at.r * 0.7, depth + 1);
        }
        if (depth >= 2 && len < 3) spots.push({ p: tip, d });
    };
    // trunk then a fork (the height of the fork and its angle are drawn per tree)
    const trunk: Array<{ p: V3; r: number }> = [];
    for (let i = 0; i <= 10; i++) trunk.push({ p: [0.03 * Math.sin(i), (trunkTop * i) / 10, 0.03 * Math.cos(i)], r: 0.34 * (1 - 0.35 * (i / 10)) });
    tube(wood0, trunk, 12); tube(wood1, trunk, 8); tube(far, trunk, 6);
    const top = trunk[trunk.length - 1];
    const lead = 4 + Math.floor(rnd() * 3);
    for (let k = 0; k < lead; k++) {
        const ang = (2 * Math.PI * (k + rnd() * 0.6)) / lead;
        grow(top.p, norm([Math.cos(ang) * (0.7 + 0.4 * rnd()), 1.1, Math.sin(ang) * (0.7 + 0.4 * rnd())]), (heightM - trunkTop) * (0.7 + 0.3 * rnd()), 0.2, 1);
    }
    // blob masses of the far level: lumps over the leaf spots
    const lumps = 6;
    for (let k = 0; k < lumps; k++) {
        const s = spots[Math.floor(rnd() * spots.length)] ?? { p: [0, heightM * 0.7, 0] as V3 };
        blob(far, [s.p[0] * 0.6, Math.max(trunkTop + 1, s.p[1] * 0.9), s.p[2] * 0.6], heightM * 0.17, heightM * 0.13, heightM * 0.17, rnd);
    }
    return { wood0, wood1, far, leafSpots: spots, height: heightM };
}

/** Builds the glTF JSON and binary. */
export function buildScaledTreesGltf(opts: ScaledTreesOptions = {}): { json: any; bin: Buffer } {
    const nTrees = opts.trees ?? 1000, nVar = opts.variants ?? 6, area = opts.areaM ?? 700, seed = opts.seed ?? 1234;
    const rnd = rng(seed);
    const parts: Buffer[] = [];
    const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], nodes: any[] = [];
    let offset = 0;
    const push = (b: Buffer): number => {
        const pad = (4 - (offset % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
        parts.push(b); bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length }); offset += b.length; return bufferViews.length - 1;
    };
    const acc = (data: ArrayBufferView, componentType: number, type: string, count: number, bounds = false): number => {
        const a: any = { bufferView: push(Buffer.from(data.buffer, data.byteOffset, data.byteLength)), componentType, count, type };
        if (bounds) { const f = data as Float32Array; a.min = [Infinity, Infinity, Infinity]; a.max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { a.min[k] = Math.min(a.min[k], f[i + k]); a.max[k] = Math.max(a.max[k], f[i + k]); } }
        accessors.push(a); return accessors.length - 1;
    };
    const addMesh = (g: Geo, name: string): number => {
        const p = acc(new Float32Array(g.pos), 5126, 'VEC3', g.pos.length / 3, true);
        const n = acc(new Float32Array(g.nrm), 5126, 'VEC3', g.nrm.length / 3);
        const i = acc(new Uint32Array(g.idx), 5125, 'SCALAR', g.idx.length);
        meshes.push({ name, primitives: [{ attributes: { POSITION: p, NORMAL: n }, indices: i, mode: 4 }] });
        return meshes.length - 1;
    };
    // leaf cluster meshes: level 0 = 52 blades of `blade` m, level 1 = 8 blades of about 2.6 x the area (same footprint)
    const bladeM = opts.bladeM ?? 0.1;
    const clusterGeo = (count: number, len: number, rows: number): Geo => {
        const g = newGeo(); const r = rng(77);
        for (let i = 0; i < count; i++) {
            const ang = r() * 2 * Math.PI, el = (r() - 0.35) * 1.6;
            const dir = norm([Math.cos(ang) * Math.cos(el), Math.sin(el), Math.sin(ang) * Math.cos(el)]);
            const side = norm(cross(dir, [r() - 0.5, r() - 0.5, r() - 0.5]));
            blade(g, mul(norm([r() - 0.5, r() - 0.5, r() - 0.5]), 0.5 * Math.cbrt(r())), dir, side, len, rows);
        }
        return g;
    };
    const cl0 = addMesh(clusterGeo(52, bladeM, 5), 'leaf_cluster_a');
    const cl1 = addMesh(clusterGeo(8, bladeM * 2.6, 5), 'leaf_cluster_a_l1');
    const bands: Array<[number, number, number]> = [[0, 60, 10], [50, 200, 30], [170, 1e6, 60]];
    const shapes: Array<{ w0: number; w1: number; far: number; spots: Array<{ p: V3; d: V3 }> }> = [];
    for (let v = 0; v < nVar; v++) {
        const s = growShape(rnd, 16 + 10 * rnd());
        shapes.push({ w0: addMesh(s.wood0, `wood0_${v}`), w1: addMesh(s.wood1, `wood1_${v}`), far: addMesh(s.far, `far_${v}`), spots: s.leafSpots });
    }
    // cluster positions per variant: every branch tip plus samples over the crown shell, about 130
    const INST = 130;
    const instanceAcc: Array<number> = [];
    for (let v = 0; v < nVar; v++) {
        const sp = shapes[v].spots, m = new Float32Array(INST * 3); const r = rng(500 + v);
        for (let i = 0; i < INST; i++) {
            const s = sp[i % sp.length] ?? { p: [0, 12, 0] as V3 };
            const j = i < sp.length ? 1.2 : 3.0;
            m[3 * i] = s.p[0] + (r() - 0.5) * j; m[3 * i + 1] = s.p[1] + (r() - 0.5) * j; m[3 * i + 2] = s.p[2] + (r() - 0.5) * j;
        }
        instanceAcc.push(acc(m, 5126, 'VEC3', INST));
    }
    const sceneNodes: number[] = [];
    const levelTri = (m: number): number => {
        const idxAcc = accessors[meshes[m].primitives[0].indices]; return idxAcc.count / 3;
    };
    for (let t = 0; t < nTrees; t++) {
        const v = Math.floor(rnd() * nVar), sh = shapes[v];
        const levelNodes: number[] = [];
        const meshByLevel = [sh.w0, sh.w1, sh.far];
        for (let level = 0; level < 3; level++) {
            const kids: number[] = [];
            if (level < 2) for (let c = 0; c < 1; c++) {
                nodes.push({
                    name: `tree${t}_lod${level}_clusters`, mesh: level === 0 ? cl0 : cl1,
                    extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: instanceAcc[v] } } },
                    extras: { sbCluster: { clusterMesh: 'leaf_cluster_a', hashSeed: 1000 * t + 10 * level + c } }
                });
                kids.push(nodes.length - 1);
            }
            const lod: TreeLodExtras = { level: level as 0 | 1 | 2, minDistM: bands[level][0], maxDistM: bands[level][1], fadeM: bands[level][2], triangles: levelTri(meshByLevel[level]), instanced: level < 2 };
            nodes.push({ name: `tree${t}_lod${level}`, mesh: meshByLevel[level], ...(kids.length ? { children: kids } : {}), extras: { sbLod: lod } });
            levelNodes.push(nodes.length - 1);
        }
        const yaw = rnd() * Math.PI * 2, sc = 0.7 + 0.7 * rnd();
        nodes.push({
            name: `tree${t}`, translation: [(rnd() - 0.5) * area, 0, (rnd() - 0.5) * area], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [sc, sc, sc],
            children: levelNodes, extras: { sbTree: { id: t, hashSeed: 7919 * (t + 1), label: 'grown to the measured crown' } }
        });
        sceneNodes.push(nodes.length - 1);
    }
    const root: TreesGlbRootExtras = {
        schema: 'scratchbox.trees-lod/1', psiSeason: opts.psiSeason ?? 1,
        clusterLibrary: { variants: [{ mesh: 'leaf_cluster_a', leavesLevel0: 52, leavesLevel1: 8 }], leafSizeModel: { sizeRatioToCrownHeight: 0.005, minM: 0.08, maxM: 0.12 } }
    };
    const bin = Buffer.concat(parts);
    const json = {
        asset: { version: '2.0' }, extensionsUsed: ['EXT_mesh_gpu_instancing'], extras: { sbTrees: root },
        buffers: [{ byteLength: bin.length }], bufferViews, accessors, meshes, nodes, scenes: [{ nodes: sceneNodes }], scene: 0
    };
    return { json, bin };
}

/** Triangles a tree draws per level as built: wood plus instances x cluster triangles. */
export function treeTrianglesPerLevel(gltf: { json: any }, treeIndex = 0): [number, number, number] {
    const j = gltf.json;
    const tris = (meshIdx: number) => j.accessors[j.meshes[meshIdx].primitives[0].indices].count / 3;
    const tree = j.nodes.filter((n: any) => n.extras?.sbTree)[treeIndex];
    return tree.children.map((c: number) => {
        const lvl = j.nodes[c];
        let sum = tris(lvl.mesh);
        for (const k of lvl.children ?? []) sum += tris(j.nodes[k].mesh) * j.accessors[j.nodes[k].extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION].count;
        return sum;
    }) as [number, number, number];
}
