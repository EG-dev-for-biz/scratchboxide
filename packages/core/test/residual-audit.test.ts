/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The residual audit on synthetic clusters around a clean box (no network, no model): a spike, a sheet of needle
 * triangles, a floating slab, a tank on legs, a box bulkhead and a chimney get their verdicts from the native measures
 * (real numbers checked, not just labels); the cleaned GLB drops exactly the artefacts; and a split wall no longer turns a
 * parapet sweep into a span across the roof. Screenshots under test-results/screenshots/residual_audit/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { auditResidual, cleanGlbBytes, judgeCluster, type AuditedCluster, type ResidualAuditResult } from '../src/node/3d-engine/staged-location/residual-audit';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { parapetProfile } from '../src/node/3d-engine/staged-location/pipeline-e/band-infer';
import { objectUnderBlock } from '../src/node/3d-engine/staged-location/pipeline-e/inference';
import { parseGlbNodes } from '../src/node/3d-engine/staged-location/glb-nodes';
import { contactSheet, renderSoups } from './helpers/soup-render';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/residual_audit');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'residual-audit-'));
const shot = (name: string, img: { width: number; height: number; rgba: Uint8Array }) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name), encodePng(img.width, img.height, Buffer.from(img.rgba), 4)); };

type P3 = [number, number, number];
const tri = (out: number[], a: P3, b: P3, c: P3) => out.push(...a, ...b, ...c);
const quad = (out: number[], a: P3, b: P3, c: P3, d: P3) => { tri(out, a, b, c); tri(out, a, c, d); };
/** A box from lo to hi, optionally without its bottom face, each face split into n x n quads. */
function box(lo: P3, hi: P3, opts: { bottom?: boolean; n?: number } = {}): number[] {
    const o: number[] = [], n = opts.n ?? 1;
    const L = (u: number, a: number, b: number) => a + ((b - a) * u) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x0 = L(i, lo[0], hi[0]), x1 = L(i + 1, lo[0], hi[0]), y0 = L(j, lo[1], hi[1]), y1 = L(j + 1, lo[1], hi[1]), z0 = L(j, lo[2], hi[2]), z1 = L(j + 1, lo[2], hi[2]), zi0 = L(i, lo[2], hi[2]), zi1 = L(i + 1, lo[2], hi[2]);
        quad(o, [x0, hi[1], z0], [x0, hi[1], z1], [x1, hi[1], z1], [x1, hi[1], z0]);  // top
        if (opts.bottom !== false) quad(o, [x0, lo[1], z0], [x1, lo[1], z0], [x1, lo[1], z1], [x0, lo[1], z1]);
        quad(o, [x0, y0, lo[2]], [x1, y0, lo[2]], [x1, y1, lo[2]], [x0, y1, lo[2]]);
        quad(o, [x0, y0, hi[2]], [x0, y1, hi[2]], [x1, y1, hi[2]], [x1, y0, hi[2]]);
        quad(o, [lo[0], y0, zi0], [lo[0], y1, zi0], [lo[0], y1, zi1], [lo[0], y0, zi1]);
        quad(o, [hi[0], y0, zi0], [hi[0], y0, zi1], [hi[0], y1, zi1], [hi[0], y1, zi0]);
    }
    return o;
}

/** The clean massing: a 30 x 20 x 30 m block (x -15..15, y 0..20, z -15..15). */
const SOLID = Float32Array.from(box([-15, 0, -15], [15, 20, 15], { n: 4 }));
const ROOF = 20;

/** A long thin shard rising diagonally off the roof's edge, touching it at one end. */
function spike(): number[] {
    const o: number[] = [], base: P3 = [12, ROOF, 12], tip: P3 = [17, ROOF + 4, 17];
    const w = 0.12;
    const ring = (p: P3): P3[] => [[p[0] - w, p[1], p[2] + w], [p[0] + w, p[1], p[2] - w], [p[0], p[1] + w, p[2]]];
    const a = ring(base), b = ring(tip);
    for (let k = 0; k < 3; k++) quad(o, a[k], a[(k + 1) % 3], b[(k + 1) % 3], b[k]);
    return o;
}

/** A sheet of needle triangles standing off the roof (long thin fans, as a melted scan draws them). */
function sliverSheet(): number[] {
    const o: number[] = [];
    for (let i = 0; i < 24; i++) {
        const x0 = -12 + i * 0.25, x1 = x0 + 0.25;
        tri(o, [x0, ROOF + 1.2, -12], [x1, ROOF + 1.2, -12], [x1 - 0.05, ROOF + 2.4, -8]);
        tri(o, [x0, ROOF + 1.2, -12], [x1 - 0.05, ROOF + 2.4, -8], [x0 - 0.05, ROOF + 2.4, -8]);
    }
    return o;
}

/** A closed slab 4 x 4 x 0.3 m hanging 4 m above the roof, touching nothing. */
const slab = () => box([-2, ROOF + 4, 4], [2, ROOF + 4.3, 8]);

/** A round tank (r 1.5, 3 m tall, closed) on four legs 3.5 m above the roof; the legs meet the tank's rim. */
function tankOnLegs(cx: number, cz: number): number[] {
    const o: number[] = [], N = 24, r = 1.5, y0 = ROOF + 3.5, y1 = y0 + 3;
    const P = (k: number, y: number): P3 => [cx + r * Math.cos((2 * Math.PI * k) / N), y, cz + r * Math.sin((2 * Math.PI * k) / N)];
    for (let k = 0; k < N; k++) {
        quad(o, P(k, y0), P(k + 1, y0), P(k + 1, y1), P(k, y1));
        tri(o, [cx, y1, cz], P(k + 1, y1), P(k, y1));
        tri(o, [cx, y0, cz], P(k, y0), P(k + 1, y0));
    }
    for (const k of [0, 6, 12, 18]) {
        const top = P(k, y0), foot: P3 = [cx + 1.2 * Math.cos((2 * Math.PI * k) / N), ROOF, cz + 1.2 * Math.sin((2 * Math.PI * k) / N)];
        const f = [[foot[0] - 0.1, foot[1], foot[2] - 0.1], [foot[0] + 0.1, foot[1], foot[2] - 0.1], [foot[0], foot[1], foot[2] + 0.12]] as P3[];
        for (let j = 0; j < 3; j++) tri(o, f[j], f[(j + 1) % 3], top);
    }
    return o;
}

const bulkhead = () => box([-10, ROOF, 6], [-6, ROOF + 2.6, 9], { bottom: false, n: 2 });
const chimney = () => box([6, ROOF, -12], [6.8, ROOF + 3.2, -11.2], { bottom: false, n: 2 });

const SHAPES: Array<{ id: string; tris: number[]; expect: string }> = [
    { id: 'spike', tris: spike(), expect: 'scan-artefact' },
    { id: 'sliver-sheet', tris: sliverSheet(), expect: 'scan-artefact' },
    { id: 'floating-slab', tris: slab(), expect: 'scan-artefact' },
    { id: 'tank-on-legs', tris: tankOnLegs(9, 2), expect: 'real-object' },
    { id: 'bulkhead', tris: bulkhead(), expect: 'real-object' },
    { id: 'chimney', tris: chimney(), expect: 'real-object' }
];

const clusterOf = (r: ResidualAuditResult, source: string): AuditedCluster[] => {
    const s = r.sources.find(x => x.node === source)!;
    return r.clusters.filter(c => c.triangleIds.some(t => t >= s.firstTriangle && t < s.firstTriangle + s.triangles));
};

describe('residual audit (native measures, numeric verdicts)', () => {
    let result: ResidualAuditResult;
    it('gives each synthetic cluster the right verdict from its numbers', async () => {
        const dir = tmp();
        result = await auditResidual({ solid: SOLID, sources: SHAPES.map(s => ({ node: s.id, triangles: Float32Array.from(s.tris) })), groundY: 0, dir });
        const lines: string[] = [];
        for (const s of SHAPES) {
            const cs = clusterOf(result, s.id);
            expect(cs.length, `${s.id}: one cluster`).toBe(1);
            const c = cs[0];
            lines.push(`${s.id}: ${c.verdict} (${c.confidence}) [${c.feature.types.join(', ')}] ${c.reason}`);
            expect(c.verdict, `${s.id}: ${c.reason}`).toBe(s.expect);
            expect(c.triangleIds.length).toBe(s.tris.length / 9);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'synthetic_verdicts.txt'), lines.join('\n'));
        // the numbers behind the verdicts
        const get = (id: string) => clusterOf(result, id)[0];
        const sp = get('spike');
        expect(sp.principal.extentsM[0]).toBeGreaterThan(6);
        expect(sp.shape.elongation).toBeLessThan(0.08);
        expect(sp.attachment.contactAlongShare).toBeLessThan(0.3);
        expect(sp.scores.spike).toBeGreaterThan(0.6);
        const sl = get('sliver-sheet');
        expect(sl.surface.sliverShare).toBeGreaterThan(0.7);
        expect(sl.shape.thinness).toBeLessThan(0.06);
        const fl = get('floating-slab');
        expect(fl.attachment.minGapToSolidM).toBeGreaterThan(3.9);
        expect(fl.attachment.groundedShare).toBe(0);
        expect(fl.scores.floating).toBeGreaterThan(0.9);
        const tk = get('tank-on-legs');
        expect(tk.symmetry.radialSymmetry).toBeGreaterThan(0.5);  // the leg slices are four small sections, the tank's are full circles
        expect(tk.symmetry.radiusMedianM).toBeGreaterThan(1.3);
        expect(tk.symmetry.radiusMedianM).toBeLessThan(1.6);
        expect(tk.attachment.openBelowShare).toBeGreaterThan(0.6);
        expect(tk.attachment.topAboveSupportM).toBeCloseTo(6.5, 1);
        expect(tk.typeLabels.map(l => l.code)).toContain('SB_FEATURE_TYPE_ROOF_OBJECT_TANK');
        const bh = get('bulkhead');
        expect(bh.attachment.groundedShare).toBeGreaterThan(0.8);
        expect(bh.attachment.enclosedShare).toBeGreaterThan(0.5);
        expect(bh.surface.normalCoherence).toBeLessThan(0.4);
        expect(bh.volume.envelopeM3).toBeGreaterThan(0.9 * 4 * 3 * 2.6);
        const ch = get('chimney');
        expect(ch.symmetry.crossSectionConstancy).toBeGreaterThan(0.9);
        expect(ch.attachment.topAboveSupportM).toBeCloseTo(3.2, 1);
        expect(result.counts.artefacts).toBe(3);
        expect(result.candidates.length).toBe(3);
        // every cluster carries a local frame and an sb-feature record whose types came after the verdict
        for (const c of result.clusters) { expect(c.feature.schema).toBe('sb-feature/1'); expect(c.frame.yAxis).toEqual([0, 1, 0]); }

        // screenshot: massing grey, artefacts red, real objects green, unsure amber
        const col = (v: string): [number, number, number] => v === 'scan-artefact' ? [235, 60, 50] : v === 'real-object' ? [40, 190, 80] : [245, 170, 30];
        const layers = [{ tris: SOLID, rgb: [175, 178, 184] as [number, number, number] }, ...SHAPES.map(s => ({ tris: Float32Array.from(s.tris), rgb: col(clusterOf(result, s.id)[0].verdict) }))];
        shot('synthetic_verdicts.png', contactSheet([renderSoups(layers, { azimuthDeg: 35, elevationDeg: 30 }), renderSoups(layers, { azimuthDeg: 215, elevationDeg: 25 })], 2));
    }, 120_000);

    it('a verdict never reads a feature-type code: the same numbers give the same verdict whatever the labels', () => {
        const c = clusterOf(result, 'tank-on-legs')[0];
        const relabelled = { ...c, typeLabels: [{ code: 'SB_FEATURE_TYPE_SCAN_ARTEFACT_SPIKE', confidence: 1 }], feature: { ...c.feature, types: ['SB_FEATURE_TYPE_SCAN_ARTEFACT_SPIKE'] } };
        expect(judgeCluster(relabelled, c.skyShare).verdict).toBe(c.verdict);
    });

    it('keeps a raised-block box off a real object a prism misrepresents (the tank), not off a box-like one (the bulkhead)', () => {
        const run = { audit: result };
        // the box a roof reading would draw over the tank, and over the bulkhead
        expect(objectUnderBlock(run, [[7.3, 0.3], [10.7, 0.3], [10.7, 3.7], [7.3, 3.7]])?.id).toBe(clusterOf(result, 'tank-on-legs')[0].id);
        expect(objectUnderBlock(run, [[-10, 6], [-6, 6], [-6, 9], [-10, 9]])).toBeUndefined();
        expect(objectUnderBlock({ audit: { error: 'x' } }, [[7.3, 0.3], [10.7, 0.3], [10.7, 3.7], [7.3, 3.7]])).toBeUndefined();
    });

    it('writes a cleaned GLB without exactly the artefact triangles, other nodes untouched', async () => {
        const dir = tmp();
        const glbIn = path.join(dir, 'layer.glb');
        // a layer GLB: the massing and one residual node holding all six shapes
        const all = SHAPES.flatMap(s => s.tris);
        const mesh = (name: string, p: number[]) => ({ name, positions: Float32Array.from(p), indices: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) });
        const bytes = buildGlb([mesh('wall:block', Array.from(SOLID)), mesh('residual:0', all)]);
        fs.writeFileSync(glbIn, bytes);
        const r = await auditResidual({ solid: SOLID, sources: [{ node: 'residual:0', triangles: Float32Array.from(all) }], groundY: 0, dir });
        const out = cleanGlbBytes(fs.readFileSync(glbIn), r);
        const removed = r.clusters.filter(c => c.verdict === 'scan-artefact').reduce((s, c) => s + c.triangles, 0);
        expect(out.removedTriangles).toBe(removed);
        const nodes = parseGlbNodes(out.glb);
        expect(nodes.find(n => n.name === 'wall:block')!.indices!.length).toBe(SOLID.length / 3);
        expect(nodes.find(n => n.name === 'residual:0')!.indices!.length / 3).toBe(all.length / 9 - removed);
        expect(out.glb.readUInt32LE(0)).toBe(0x46546c67);
    }, 120_000);
});

/** A minimal GLB of named meshes (positions and indices). */
function buildGlb(meshes: Array<{ name: string; positions: Float32Array; indices: Uint32Array }>): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((_, i) => i) }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    const parts: Buffer[] = [];
    let off = 0;
    const view = (b: Buffer, target: number) => { json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length, target }); parts.push(b); off += b.length; return json.bufferViews.length - 1; };
    meshes.forEach((m, i) => {
        const pv = view(Buffer.from(m.positions.buffer.slice(0)), 34962);
        const mins = [0, 1, 2].map(k => Math.min(...Array.from(m.positions).filter((_, j) => j % 3 === k))), maxs = [0, 1, 2].map(k => Math.max(...Array.from(m.positions).filter((_, j) => j % 3 === k)));
        json.accessors.push({ bufferView: pv, componentType: 5126, count: m.positions.length / 3, type: 'VEC3', min: mins, max: maxs });
        const iv = view(Buffer.from(m.indices.buffer.slice(0)), 34963);
        json.accessors.push({ bufferView: iv, componentType: 5125, count: m.indices.length, type: 'SCALAR' });
        json.meshes.push({ name: m.name, primitives: [{ attributes: { POSITION: json.accessors.length - 2 }, indices: json.accessors.length - 1 }] });
        json.nodes.push({ name: m.name, mesh: i });
    });
    const bin = Buffer.concat(parts);
    json.buffers[0].byteLength = bin.length;
    const pad = (b: Buffer, f: number) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), f)]) : b);
    const jb = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([h, jh, jb, bh, bb]);
}

describe('parapet sweep over a wall another part split (the 488 Broadway spike)', () => {
    it('resolves the split wall to its pieces, joins only walls that meet, and sits on the wall top, not at the part\'s top cap', async () => {
        const dir = tmp();
        // a 20 x 12 m block whose roof plane (y 12) sits far under its top cap (y 30), and a low annex against wall 0 whose
        // corners lie on it: wall 0 is split into "w:a:0:0:0", ":1" (above the annex) and ":2", so the key read before
        // ("w:a:0:0") is gone. (At 488 Broadway a block on the roof split the wall; since c60b5458 a part standing higher no
        // longer cuts the walls below it, so the split here comes from a part standing on the same ground.)
        const m: Pick<Massing, 'parts' | 'meshes'> = {
            parts: [
                { id: 'a', baseY: 0, topY: 30, loops: [[[0, 0], [20, 0], [20, -12], [0, -12]]], planes: [{ a: 12, b: 0, c: 0, tag: 'flat' }], heightSource: 'vector', heights: {} },
                { id: 'b', baseY: 0, topY: 5, loops: [[[8, 4], [12, 4], [12, 0], [8, 0]]], planes: [], heightSource: 'vector', heights: {} }
            ],
            meshes: []
        };
        const sweeps = [{ id: 'parapet_a_0', confidence: 0.7, provenance: 'photo-inferred', profile: parapetProfile(0.5, 0.3), relativeToTop: true, faces: ['w:a:0:0', 'w:a:0:1', 'w:a:0:2', 'w:a:0:3'] }];
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0 }, sweeps }), dir);
        expect(r.report.faces.some(f => f.key === 'w:a:0:0')).toBe(false);
        expect(r.report.faces.filter(f => f.key.startsWith('w:a:0:0:')).length).toBeGreaterThan(1);
        const node = r.nodes.find(n => n.name === 'sweep:parapet_a_0')!;
        expect(node).toBeDefined();
        let yMin = Infinity, yMax = -Infinity, longest = 0;
        const P = node.positions, I = node.indices;
        for (let i = 0; i < P.length; i += 3) { yMin = Math.min(yMin, P[i + 1]); yMax = Math.max(yMax, P[i + 1]); }
        // no edge longer than the longest wall plus the mitre: never a span across the plan
        for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
            const a = I[t + k] * 3, b = I[t + (k + 1) % 3] * 3;
            longest = Math.max(longest, Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]));
        }
        expect(yMin).toBeCloseTo(12, 3);
        expect(yMax).toBeCloseTo(12.5, 3);
        expect(longest).toBeLessThan(20.7);
        // it goes all round: the pieces of wall 0 included, closed (no caps), every wall covered
        const xs = Array.from(P).filter((_, i) => i % 3 === 0);
        expect(Math.min(...xs)).toBeLessThan(0.01);
        expect(Math.max(...xs)).toBeGreaterThan(19.99);
        const sweepTris = [{ tris: (() => { const o = new Float32Array(I.length * 3); for (let i = 0; i < I.length; i++) o.set(P.subarray(I[i] * 3, I[i] * 3 + 3), i * 3); return o; })(), rgb: [80, 120, 230] as [number, number, number] }];
        const solid = r.nodes.filter(n => n.kind !== 'sweep').map(n => { const o = new Float32Array(n.indices.length * 3); for (let i = 0; i < n.indices.length; i++) o.set(n.positions.subarray(n.indices[i] * 3, n.indices[i] * 3 + 3), i * 3); return { tris: o, rgb: [175, 178, 184] as [number, number, number] }; });
        shot('parapet_split_wall.png', renderSoups([...solid, ...sweepTris], { azimuthDeg: 30, elevationDeg: 35 }));
    }, 120_000);
});
