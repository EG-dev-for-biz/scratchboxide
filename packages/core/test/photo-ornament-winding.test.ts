/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every closed shell the native ornament builder writes winds outward: counter-clockwise seen from outside, so its signed
 * volume is positive, and its vertex normals agree with its triangles. Built with the real builder (scratchbox_ornament.hpp
 * behind `scan_fit ornament`, compiled with clang++) on fits of synthetic structures from the real fitter: a facade whose
 * wall chart is right-handed, and a segmental arch (its opening in 80 facets, so the fitted soffit's chord sag lets a flat
 * panel stand on it) whose soffit is a cylinder chart facing its own axis (normalSign -1, a left-handed chart, so a shell built
 * in it comes out mirrored unless the builder orients it).
 *
 * On each face slot: a lattice of proud panels (one shell an instance, all in one primitive), a closed ring swept round a
 * loop in the chart (no caps: the loop closes it), an open run with caps, the same run without caps (open, so its winding is
 * judged against the capped run's), a lobed revolve and a replicated half revolve. On each crease: a capped sweep. The layer
 * is split into connected components by welded position; each component every edge of which two triangles share is a closed
 * shell, and each must cross every edge once each way (consistently wound: a cap wound against its sides fails here) and have
 * a positive signed volume about its own centroid.
 *
 * Before the fix (origin/main 7b7f1461): every replicated half revolve had its cut faces wound against its sides, and the ring
 * on the soffit (a closed carrier, so no caps and no volume check) was inside out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import type { OperatorSpec, OrnamentElement, StructureFit, Vec2 } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import * as FX from './helpers/staged-location-fixtures';
import { readStagedGlb, type StagedPrimitiveRead } from './helpers/staged-glb-read';
import { saveClayShot } from './helpers/staged-shots';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };
const SV = 'sv:CAoSLEFGMVFpcE:12:8:42';
let work: string;
let svc: ScanFitService;

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const element = (id: string, slotId: string, spec: OperatorSpec, order: number): OrnamentElement => ({
    id, slotId, confidence: 0.7, depthBasis: 'a test', buildOrder: order, spec,
    evidence: [{ imageId: SV, box1000: [100, 100, 300, 300] }],
    checks: { slotOverlap: 1, minFeatureM: 0.1, nativeSampleM: 0.02 }, provenance: FX.photoInferred(0.7, SV)
});
const rect = (u0: number, v0: number, u1: number, v1: number): Vec2[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
/** A polyline with points at most `step` apart (so a path drawn in a cylinder's chart follows the cylinder, not its chords). */
const densify = (pts: Vec2[], closed: boolean, step = 0.1): Vec2[] => {
    const out: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    if (!closed) out.push(pts[n - 1]);
    return out;
};

/** One connected component of a primitive (welded at 0.1 mm): its triangles, whether it is closed, its signed volume about its centroid. */
interface Shell { triangles: number; closed: boolean; volume: number; area: number; sameWay: number }

function shells(p: StagedPrimitiveRead): Shell[] {
    const P = p.positions, I = p.indices;
    const weld = new Map<string, number>();
    const id: number[] = [];
    for (let v = 0; v < P.length / 3; v++) {
        const k = `${Math.round(P[3 * v] * 1e4)},${Math.round(P[3 * v + 1] * 1e4)},${Math.round(P[3 * v + 2] * 1e4)}`;
        if (!weld.has(k)) weld.set(k, weld.size);
        id.push(weld.get(k)!);
    }
    const parent = Array.from({ length: weld.size }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < I.length; t += 3) { const a = find(id[I[t]]); parent[find(id[I[t + 1]])] = a; parent[find(id[I[t + 2]])] = a; }
    const groups = new Map<number, number[]>();
    for (let t = 0; t < I.length; t += 3) { const r = find(id[I[t]]); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(t); }
    const out: Shell[] = [];
    for (const tris of groups.values()) {
        const edges = new Map<string, number>();
        const directed = new Map<string, number>();
        const c = [0, 0, 0];
        let n = 0;
        for (const t of tris) for (let j = 0; j < 3; j++) { const v = I[t + j]; c[0] += P[3 * v]; c[1] += P[3 * v + 1]; c[2] += P[3 * v + 2]; n++; }
        c[0] /= n; c[1] /= n; c[2] /= n;
        let volume = 0, area = 0;
        for (const t of tris) {
            const ids = [id[I[t]], id[I[t + 1]], id[I[t + 2]]];
            if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
            for (const [x, y] of [[0, 1], [1, 2], [2, 0]]) {
                const a = ids[x], b = ids[y]; const k = a < b ? `${a},${b}` : `${b},${a}`; edges.set(k, (edges.get(k) ?? 0) + 1);
                directed.set(`${a},${b}`, (directed.get(`${a},${b}`) ?? 0) + 1);
            }
            const q = [0, 1, 2].map(j => [P[3 * I[t + j]] - c[0], P[3 * I[t + j] + 1] - c[1], P[3 * I[t + j] + 2] - c[2]]);
            const [A, B, D] = q;
            volume += (A[0] * (B[1] * D[2] - B[2] * D[1]) - A[1] * (B[0] * D[2] - B[2] * D[0]) + A[2] * (B[0] * D[1] - B[1] * D[0])) / 6;
            const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
            area += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
        }
        // a consistently wound shell crosses each of its edges once each way: an edge two triangles cross the same way is a fold in the winding
        let sameWay = 0;
        for (const n of directed.values()) if (n > 1) sameWay++;
        out.push({ triangles: tris.length, closed: edges.size > 0 && [...edges.values()].every(k => k === 2), volume, area, sameWay });
    }
    return out;
}

/** Triangles whose vertex normals disagree with their winding (the normals summed over the corners point against the face). */
function normalsAgainstWinding(p: StagedPrimitiveRead): { against: number; judged: number } {
    const P = p.positions, I = p.indices, N = p.normals!;
    let against = 0, judged = 0;
    for (let t = 0; t < I.length; t += 3) {
        const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
        const e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
        const e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
        const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(f[0], f[1], f[2]);
        if (len < 1e-8) continue;
        judged++;
        let s = 0;
        for (const v of [a, b, c]) s += (f[0] * N[3 * v] + f[1] * N[3 * v + 1] + f[2] * N[3 * v + 2]) / len;
        if (s <= 0) against++;
    }
    return { against, judged };
}

/** The oriented triangles of a primitive by position (each rotated to start at its smallest key), to compare two builds' winding. */
function orientedTriangles(p: StagedPrimitiveRead): Set<string> {
    const P = p.positions, I = p.indices;
    const key = (v: number) => `${Math.round(P[3 * v] * 1e4)},${Math.round(P[3 * v + 1] * 1e4)},${Math.round(P[3 * v + 2] * 1e4)}`;
    const out = new Set<string>();
    for (let t = 0; t < I.length; t += 3) {
        const k = [key(I[t]), key(I[t + 1]), key(I[t + 2])];
        const m = k.indexOf([...k].sort()[0]);
        out.add([k[m], k[(m + 1) % 3], k[(m + 2) % 3]].join('|'));
    }
    return out;
}

/** The elements a face slot carries, sized to its region (u, v), and the crease sweeps. */
function elementsFor(fit: StructureFit, facetColumns: (surfaceId: string) => number[]): { elements: OrnamentElement[]; openPairs: Array<[string, string]>; cylinderSlots: string[] } {
    const elements: OrnamentElement[] = [];
    const openPairs: Array<[string, string]> = [];
    const cylinderSlots: string[] = [];
    let k = 0;
    for (const s of fit.slots) {
        if ('edge' in s.host) {
            elements.push(element(`${s.id}_crease`, s.id, { operator: 'sweep', sweep: { carrier: { slot: { slotId: s.id, t0: 0.2, t1: 0.8, offset: [0, 0] } }, profile: { outer: [[0, 0], [0.06, 0], [0.06, 0.04], [0, 0.04]] }, miterLimit: 4, caps: true } }, k++));
            continue;
        }
        const surf = fit.surfaces.find(x => x.id === (s.host as any).surface.surfaceId)!;
        if (surf.visibleFraction < 0.5) continue;
        const reg = (s.host as any).surface.regionUv as Vec2[];
        const us = reg.map(p => p[0]), vs = reg.map(p => p[1]);
        const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
        const W = u1 - u0, H = v1 - v0;
        if (W < 1.6 || H < 1.6) continue;
        if ('cylinder' in surf.chart) cylinderSlots.push(s.id);
        const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
        // a 2 x 2 lattice of proud panels in the slot's middle; on a cylinder, centred on the fitted mesh's facet edges (a flat panel's foot
        // mid-facet would sit the chord's sag inside the faceted solid and be refused as a sink)
        let pw = Math.min(0.3, W / 8), ph = Math.min(0.3, H / 8), lu = cu - pw * 1.5, pu = pw * 2;
        if ('cylinder' in surf.chart) {
            const cols = facetColumns(surf.id).filter(u => u > u0 + W * 0.2 && u < u1 - W * 0.2);
            const i = Math.floor(cols.length / 2);
            if (i + 1 < cols.length) { pu = cols[i + 1] - cols[i]; pw = Math.min(0.1, pu / 4); lu = cols[i] - pw / 2; }
        }
        elements.push(element(`${s.id}_lattice`, s.id, {
            operator: 'replicate', replicate: {
                seed: { operator: 'relief', relief: { surfaceId: surf.id, region: { outer: rect(0, 0, pw, ph) }, height: { panel: { depthM: 0.03, edgeWidthM: 0.02, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.04 } },
                domain: { lattice: { originUv: [lu, cv - ph * 1.5], pitchUv: [pu, ph * 2], counts: [2, 2], rowOffsetU: 0 } }, alignToSurface: true
            }
        }, k++));
        // a ring round a loop in the chart (closed carrier: no caps), near the region's edge
        const m = Math.min(W, H) * 0.12;
        elements.push(element(`${s.id}_ring`, s.id, { operator: 'sweep', sweep: { carrier: { chart: { pointsUv: densify(rect(u0 + m, v0 + m, u1 - m, v1 - m), true), closed: true } }, profile: { outer: [[-0.03, 0], [0.03, 0], [0.03, 0.04], [-0.03, 0.04]] }, miterLimit: 4, caps: true } }, k++));
        // an open run along u, with caps and (a separate element) without
        const run = (caps: boolean): OperatorSpec => ({ operator: 'sweep', sweep: { carrier: { chart: { pointsUv: densify([[u0 + 2 * m, cv + ph * 3], [u1 - 2 * m, cv + ph * 3]], false), closed: false } }, profile: { outer: [[-0.02, 0], [0.02, 0], [0.02, 0.03], [-0.02, 0.03]] }, miterLimit: 4, caps } });
        elements.push(element(`${s.id}_run`, s.id, run(true), k++));
        elements.push(element(`${s.id}_runOpen`, s.id, run(false), k++));
        openPairs.push([`${s.id}_runOpen`, `${s.id}_run`]);
        // a lobed revolve, and a half revolve replicated along a line in the chart
        elements.push(element(`${s.id}_rosette`, s.id, { operator: 'revolve', revolve: { axisOrigin: [cu, cv - ph * 3, 0], axisDir: [0, 0, 1], profile: [[0, 0], [0.12, 0], [0.12, 0.02], [0.06, 0.04], [0, 0.05]], lobes: 8, lobeAmplitude: 0.1, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 48 } }, k++));
        elements.push(element(`${s.id}_studs`, s.id, {
            operator: 'replicate', replicate: {
                seed: { operator: 'revolve', revolve: { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], profile: [[0, 0], [0.05, 0], [0.05, 0.03], [0, 0.03]], lobes: 0, lobeAmplitude: 0, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 180, segments: 12 } },
                domain: { along: { carrier: { chart: { pointsUv: [[u0 + 2 * m, cv + ph * 4.5], [u1 - 2 * m, cv + ph * 4.5]], closed: false } }, pitchM: 0.3, count: 3, startOffsetM: 0.2 } }, alignToSurface: false
            }
        }, k++));
    }
    return { elements, openPairs, cylinderSlots };
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ornament-winding-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);
afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

describe('every closed shell of the detail layer winds outward, its normals with its triangles', () => {
    const cases: Array<[string, (d: string) => { glb: string; textured?: string; anchor: [number, number] }]> = [
        ['textured facade', (d: string) => S.texturedFacade(d, false)],
        ['segmental arch', (d: string) => S.segmentalArch(d, 33, 80)]
    ];
    for (const [name, make] of cases) {
        it(name, async () => {
            const dir = path.join(work, name.replace(/[^a-z]+/gi, '_'));
            fs.mkdirSync(dir);
            const scan = make(dir);
            const rel = (f: string) => path.relative(work, f);
            const textured = scan.textured ?? scan.glb;
            const r = await svc.fit({ scanGlb: rel(scan.glb), texturedGlb: rel(textured), anchor: { x: scan.anchor[0], z: scan.anchor[1] }, sourceLimits: LIMITS });
            const fit: StructureFit = r.value;
            // the fitted mesh's vertex columns of each cylinder chart, as chart u (r theta)
            const fitted = readStagedGlb(fit.outputs.fittedGlb);
            const facetColumns = (surfaceId: string): number[] => {
                const c = (fit.surfaces.find(x => x.id === surfaceId)!.chart as any).cylinder;
                const e2 = [c.axisDir[1] * c.thetaZeroDir[2] - c.axisDir[2] * c.thetaZeroDir[1], c.axisDir[2] * c.thetaZeroDir[0] - c.axisDir[0] * c.thetaZeroDir[2], c.axisDir[0] * c.thetaZeroDir[1] - c.axisDir[1] * c.thetaZeroDir[0]];
                const us = new Set<number>();
                for (const p of fitted.byName(surfaceId).primitives) for (let i = 0; i < p.positions.length; i += 3) {
                    const d = [p.positions[i] - c.axisOrigin[0], p.positions[i + 1] - c.axisOrigin[1], p.positions[i + 2] - c.axisOrigin[2]];
                    const x = d[0] * c.thetaZeroDir[0] + d[1] * c.thetaZeroDir[1] + d[2] * c.thetaZeroDir[2], y = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
                    us.add(Math.round(c.radiusM * Math.atan2(y, x) * 1e3) / 1e3);
                }
                return [...us].sort((a, b) => a - b);
            };
            const { elements, openPairs, cylinderSlots } = elementsFor(fit, facetColumns);
            if (name === 'segmental arch') expect(cylinderSlots.length, 'the arch has a soffit slot on a cylinder chart').toBeGreaterThan(0);
            const spec = {
                ...FX.ornamentSpec(), buildingId: fit.buildingId, structureFitSha256: sha(r.path), elements,
                evidence: [{ id: SV, index: 0, kind: 'streetview-grounding' as const, widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021, slotsShown: [] }],
                corrections: [], emptySlots: [], dropped: []
            };
            const built = await svc.ornament({ fitPath: rel(r.path), texturedGlb: rel(textured), spec });
            const ids = built.value.built.map(b => b.elementId);
            // the shells this is about were built (a check may drop the odd element, but never the kinds as a whole)
            for (const kind of ['_lattice', '_ring', '_run', '_runOpen', '_rosette', '_studs']) expect(ids.some(id => id.endsWith(kind)), `${kind} built: ${JSON.stringify(built.value.dropped.map(d => [d.elementId, d.checks.map(c => c.check)]))}`).toBe(true);
            if (cylinderSlots.length) expect(ids.some(id => cylinderSlots.some(s => id === `${s}_lattice`)) && ids.some(id => cylinderSlots.some(s => id === `${s}_ring`)), `the soffit's lattice and ring built: ${JSON.stringify(built.value.dropped.filter(d => cylinderSlots.some(s => d.elementId.startsWith(s + '_'))).map(d => [d.elementId, d.checks]))}`).toBe(true);
            const glb = readStagedGlb(built.detailGlb);
            const inward: string[] = [];
            let closedShells = 0;
            for (const id of ids) {
                const p = glb.byName(id).primitives[0];
                const nw = normalsAgainstWinding(p);
                expect(nw.judged, id).toBeGreaterThan(0);
                expect(nw.against, `${id}: normals against the winding`).toBe(0);
                for (const sh of shells(p)) {
                    if (!sh.closed) continue;
                    closedShells++;
                    // a positive volume, and not a sliver of one: at least a tenth of a mm times the shell's area
                    if (!(sh.volume > 1e-4 * sh.area * 0.1) || sh.sameWay > 0) inward.push(`${id} (${sh.triangles} triangles, volume ${sh.volume.toExponential(3)} m3, ${sh.sameWay} edges crossed the same way twice)`);
                }
            }
            expect(inward, 'closed shells wound inside out').toEqual([]);
            expect(closedShells).toBeGreaterThan(ids.length / 2);
            // an open run winds as the capped run it is the sides of
            for (const [open, capped] of openPairs) {
                if (!ids.includes(open) || !ids.includes(capped)) continue;
                const o = orientedTriangles(glb.byName(open).primitives[0]), c = orientedTriangles(glb.byName(capped).primitives[0]);
                let missing = 0;
                for (const t of o) if (!c.has(t)) missing++;
                expect(missing, `${open}: triangles wound unlike ${capped}'s`).toBe(0);
            }
            const shot = saveClayShot(`ornament_winding_${name.replace(/[^a-z]+/gi, '_')}`, [{ file: fit.outputs.fittedGlb, color: [0.62, 0.64, 0.68] }, { file: built.detailGlb, color: [0.3, 0.6, 0.9] }], { bearingDeg: 200, elevationDeg: 15 });
            expect(shot.covered).toBeGreaterThan(0.03);
        }, 600_000);
    }
});
