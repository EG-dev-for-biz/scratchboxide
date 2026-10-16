/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged GLB writer (scratchbox_staged_glb.hpp), read the way the viewport's loader reads it. It has no binary of its own: the
 * files it writes are the fitter's (fitted.glb, outlines.glb) and the ornament builder's (detail.glb), so these are those files:
 *
 * - the container is valid glTF 2.0: the header's length is the file's, both chunks are 4-byte aligned, the JSON is padded with
 *   spaces, every accessor's count and bounds are the data's, and nothing in a buffer is NaN or infinite;
 * - the root extras are the document's and the scene's, validate as StagedGlbRootExtras, and every node with extras.sb validates as
 *   StagedNodeExtras with counts that are the geometry's;
 * - `_REVEAL` is VEC2 unsigned short normalised in [0, 1], `_DISP` VEC3 float, LINES have COLOR_0, and the order a layer of one item
 *   writes is 0 (not NaN) while a layer of two writes 0 and 1: the primitives of a fit of one and of two items;
 * - three's GLTFLoader keeps the extras as userData and lowercases the attribute names (`_reveal`, `_disp`);
 * - extras are run-independent: the same inputs in another cache write the same bytes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { validateContract, type OperatorSpec, type StructureFit, type Vec2 } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import * as FX from './helpers/staged-location-fixtures';
import { parseGlb } from './helpers/clay-glb-render';
import { readStagedGlb } from './helpers/staged-glb-read';
import { saveClayShot } from './helpers/staged-shots';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };

let work: string;
let svc: ScanFitService;
const fits: Record<string, { fit: StructureFit; path: string; anchor: [number, number]; scan: string }> = {};
let detail: string;

const rel = (f: string) => path.relative(work, f);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'staged-glb-writer-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
    const dir = path.join(work, 'scenes');
    fs.mkdirSync(dir);
    const face = S.texturedFacade(dir, false);
    for (const [name, scan] of Object.entries({ facade: { glb: face.glb, textured: face.textured, anchor: face.anchor }, arcade: S.arcade(dir), lplan: S.lPlan(dir) }) as Array<[string, { glb: string; textured?: string; anchor: [number, number] }]>) {
        const r = await svc.fit({ scanGlb: rel(scan.glb), ...(scan.textured ? { texturedGlb: rel(scan.textured) } : {}), anchor: { x: scan.anchor[0], z: scan.anchor[1] }, sourceLimits: LIMITS });
        fits[name] = { fit: r.value, path: r.path, anchor: scan.anchor, scan: scan.glb };
    }
    // a detail layer with a sweep, a recut recess, a proud lattice and a slot that gets nothing
    const f = fits.facade;
    const wall = f.fit.slots.find(s => 'surface' in s.host && s.sizeM[0] > 19)!;
    // the wall faces +z: its top edge is the long edge at z = +1; the long edge at z = -1 is the other wall's
    const longEdge = (sign: number) => f.fit.slots.find(s => 'edge' in s.host && (s.host as any).edge.carrier.lengthM > 19 && sign * (s.host as any).edge.carrier.points[0][2] > 0.5)!;
    const edge = longEdge(1), edgeBehind = longEdge(-1);
    const panel = (depthM: number, region: Vec2[]): OperatorSpec => ({ operator: 'relief', relief: { surfaceId: (wall.host as any).surface.surfaceId, region: { outer: region }, height: { panel: { depthM, edgeWidthM: 0.05, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } });
    const el = (id: string, slotId: string, spec: OperatorSpec, order: number) => ({
        id, slotId, confidence: 0.7, depthBasis: 'a test', buildOrder: order, spec,
        evidence: [{ imageId: 'sv:CAoSLEFGMVFpcE:12:8:42', box1000: [100, 100, 300, 300] as [number, number, number, number] }],
        checks: { slotOverlap: 1, minFeatureM: 0.1, nativeSampleM: 0.02 }, provenance: FX.photoInferred(0.7)
    });
    const spec = {
        ...FX.ornamentSpec(), buildingId: f.fit.buildingId, structureFitSha256: sha(f.path),
        evidence: [{ id: 'sv:CAoSLEFGMVFpcE:12:8:42', index: 0, kind: 'streetview-grounding', widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021, slotsShown: [] }],
        elements: [
            el('e0', edge.id, { operator: 'sweep', sweep: { carrier: { slot: { slotId: edge.id, t0: 0.1, t1: 0.9, offset: [0, 0] } }, profile: { outer: [[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]] }, miterLimit: 4, caps: true } }, 0),
            el('e1', wall.id, panel(-0.1, [[6, 3], [9, 3], [9, 6], [6, 6]]), 1),
            el('e2', wall.id, { operator: 'replicate', replicate: { seed: panel(0.05, [[0, 0], [0.6, 0], [0.6, 0.6], [0, 0.6]]), domain: { lattice: { originUv: [12, 3], pitchUv: [1, 1], counts: [3, 3], rowOffsetU: 0 } }, alignToSurface: true } }, 2),
            // a profile 0.9 m up an edge whose section allows 0.3 m: refused, so its slot is outlined instead
            el('e3', edgeBehind.id, { operator: 'sweep', sweep: { carrier: { slot: { slotId: edgeBehind.id, t0: 0.1, t1: 0.9, offset: [0, 0] } }, profile: { outer: [[0, 0], [0.2, 0], [0.2, 0.9], [0, 0.9]] }, miterLimit: 4, caps: true } }, 3)
        ],
        corrections: [], emptySlots: [], dropped: []
    };
    const out = await svc.ornament({ fitPath: rel(f.path), texturedGlb: rel(face.textured), spec });
    detail = out.detailGlb;
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

function layerFiles(): Array<[string, string]> {
    return [
        ['facade fitted', fits.facade.fit.outputs.fittedGlb], ['facade outlines', fits.facade.fit.outputs.outlinesGlb],
        ['arcade fitted', fits.arcade.fit.outputs.fittedGlb], ['arcade outlines', fits.arcade.fit.outputs.outlinesGlb],
        ['l plan fitted', fits.lplan.fit.outputs.fittedGlb], ['l plan outlines', fits.lplan.fit.outputs.outlinesGlb],
        ['detail', detail]
    ];
}

const LAYERS = ['facade fitted', 'facade outlines', 'arcade fitted', 'arcade outlines', 'l plan fitted', 'l plan outlines', 'detail'];

describe('the container', () => {
    it.each(LAYERS)('%s: header length, chunk alignment, space padding, accessor counts and bounds, no NaN', (name) => {
        const file = layerFiles().find(([n]) => n === name)![1];
        const bytes = fs.readFileSync(file);
        expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
        expect(bytes.readUInt32LE(4)).toBe(2);
        expect(bytes.readUInt32LE(8)).toBe(bytes.length);
        const jsonLen = bytes.readUInt32LE(12);
        expect(bytes.toString('ascii', 16, 20)).toBe('JSON');
        expect(jsonLen % 4).toBe(0);
        const jsonText = bytes.toString('utf8', 20, 20 + jsonLen);
        expect(jsonText.endsWith(' ') || jsonText.endsWith('}')).toBe(true);
        expect(jsonText.slice(jsonText.lastIndexOf('}') + 1)).toMatch(/^ *$/);
        const binAt = 20 + jsonLen;
        const binLen = bytes.readUInt32LE(binAt);
        expect(binLen % 4).toBe(0);
        expect(bytes.toString('ascii', binAt + 4, binAt + 8)).toBe('BIN\0');
        expect(binAt + 8 + binLen).toBe(bytes.length);
        const { json, bin } = parseGlb(bytes);
        expect(json.asset.version).toBe('2.0');
        expect(json.asset.generator).toMatch(/^Scratchbox /);
        expect(json.buffers).toHaveLength(1);
        expect(json.buffers[0].byteLength).toBe(bin.length);
        expect(json.materials).toHaveLength(1);
        const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
        const COMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
        for (const a of json.accessors) {
            const view = json.bufferViews[a.bufferView];
            const stride = view.byteStride ?? SIZE[a.componentType] * COMP[a.type];
            expect((a.byteOffset ?? 0) + (a.count - 1) * stride + SIZE[a.componentType] * COMP[a.type]).toBeLessThanOrEqual(view.byteLength);
            expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(bin.length);
            expect(view.byteOffset % 4).toBe(0);
            if (a.componentType === 5126) {
                const lo = new Array(COMP[a.type]).fill(Infinity), hi = new Array(COMP[a.type]).fill(-Infinity);
                for (let e = 0; e < a.count; e++) for (let c = 0; c < COMP[a.type]; c++) {
                    const v = bin.readFloatLE(view.byteOffset + (a.byteOffset ?? 0) + e * stride + c * 4);
                    expect(Number.isFinite(v)).toBe(true);
                    lo[c] = Math.min(lo[c], v); hi[c] = Math.max(hi[c], v);
                }
                if (a.min) for (let c = 0; c < lo.length; c++) { expect(a.min[c]).toBeCloseTo(lo[c], 4); expect(a.max[c]).toBeCloseTo(hi[c], 4); }
            }
        }
    });

    it('is one scene whose root carries the layer\'s extras, on the document and on the scene, and no node but the layer\'s items has extras.sb', () => {
        for (const [name, file] of layerFiles()) {
            const g = readStagedGlb(file);
            expect(validateContract('StagedGlbRootExtras', g.json.extras), name).toEqual([]);
            expect(g.json.scenes).toHaveLength(1);
            expect(g.json.scenes[0].extras, name).toEqual(g.json.extras);
            const items = g.nodes.filter(n => n.sb);
            expect(items.length, name).toBeGreaterThan(0);
            for (const n of items) {
                expect(validateContract('StagedNodeExtras', n.extras), `${name}/${n.name}`).toEqual([]);
                const tris = n.primitives.filter(p => p.mode === 4).reduce((a, p) => a + p.indices.length / 3, 0);
                const verts = n.primitives.reduce((a, p) => a + p.positions.length / 3, 0);
                expect(n.sb.counts.triangles, `${name}/${n.name}`).toBe(tris);
                expect(n.sb.counts.vertices, `${name}/${n.name}`).toBe(verts);
                if (n.sb.counts.lines !== undefined) expect(n.sb.counts.lines).toBe(n.primitives.filter(p => p.mode === 1).reduce((a, p) => a + p.indices.length / 2, 0));
            }
            expect(g.root.sb.stage).toBe(name === 'detail' ? 'detail' : 'fit');
            // the items are numbered by their real build order, 0 .. buildCount - 1, once each
            const orders = items.map(n => n.sb.buildOrder).sort((a, b) => a - b);
            expect(orders, name).toEqual(orders.map((_, i) => i));
            expect(items.every(n => n.sb.buildCount === items.length), name).toBe(true);
        }
    });
});

describe('the attributes', () => {
    it('`_REVEAL` is VEC2 unsigned short normalised in [0, 1]; `_DISP` is VEC3 float in metres; LINES carry COLOR_0; nothing is NaN', () => {
        const g = readStagedGlb(detail);
        let reveal = 0, disp = 0;
        for (const mesh of g.json.meshes) for (const p of mesh.primitives) {
            if (p.attributes._REVEAL !== undefined) {
                const a = g.json.accessors[p.attributes._REVEAL];
                expect([a.componentType, a.type, a.normalized]).toEqual([5123, 'VEC2', true]);
                reveal++;
            }
            if (p.attributes._DISP !== undefined) {
                const a = g.json.accessors[p.attributes._DISP];
                expect([a.componentType, a.type, a.normalized ?? false]).toEqual([5126, 'VEC3', false]);
                disp++;
            }
            if (p.mode === 1) {
                const a = g.json.accessors[p.attributes.COLOR_0];
                expect([a.componentType, a.type, a.normalized]).toEqual([5121, 'VEC4', true]);
                expect(p.attributes.NORMAL).toBeUndefined();
            } else {
                expect(p.attributes.NORMAL).toBeDefined();
            }
        }
        expect(reveal).toBeGreaterThanOrEqual(3);
        expect(disp).toBe(2);    // the recess and the lattice; the sweep carries no displacement
        for (const n of g.nodes) for (const p of n.primitives) {
            for (const v of p.reveal ?? []) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
            for (const v of p.disp ?? []) expect(Number.isFinite(v)).toBe(true);
            for (const v of p.normals ?? []) expect(Number.isFinite(v)).toBe(true);
        }
        // the node that says it has `_DISP` has it, and the one that says it has not does not
        for (const n of g.nodes.filter(x => x.sb && x.primitives.some(p => p.mode === 4))) {
            expect(n.sb.reveal.attribute).toBe('_REVEAL');
            expect(n.primitives.every(p => (p.disp !== undefined) === (n.sb.reveal.displacement === '_DISP'))).toBe(true);
        }
        expect(g.byName('e1').sb.reveal.displacement).toBe('_DISP');
        expect(g.byName('e0').sb.reveal.displacement).toBeNull();
    });

    it('a layer of one item writes its order as 0, never NaN, and a layer of n writes rank / (n - 1): the outlines of a fit of one primitive, of two, of three', () => {
        const nodes = (k: string) => readStagedGlb(fits[k].fit.outputs.outlinesGlb).nodes.filter(n => n.sb);
        for (const [k, count] of [['facade', 1], ['arcade', 2], ['lplan', 3]] as const) {
            const items = nodes(k);
            expect(items, k).toHaveLength(count);
            expect(fits[k].fit.primitives, k).toHaveLength(count);
            let withLines = 0;
            for (const n of items) {
                expect(n.sb.buildCount).toBe(count);
                for (const p of n.primitives) {
                    withLines++;
                    for (let i = 0; i < p.reveal!.length; i += 2) {
                        // normalised unsigned short: the order is rank / max(1, n - 1)
                        expect(Math.round(p.reveal![i] * 65535), `${k}/${n.name}`).toBe(Math.round(65535 * (count === 1 ? 0 : n.sb.buildOrder / (count - 1))));
                        expect(Number.isNaN(p.reveal![i + 1])).toBe(false);
                    }
                }
                // a primitive with no hard crease (a smooth column) has an outline item with no lines, and says it has no attribute
                if (!n.primitives.length) { expect(n.sb.reveal.attribute).toBeNull(); expect(n.sb.counts.lines).toBe(0); }
            }
            expect(withLines, k).toBeGreaterThan(0);
        }
        // the arcade's two: its columns first (smooth: no outline lines), its slab second at order 1
        const arcade = nodes('arcade');
        expect(arcade.map(n => n.sb.buildOrder)).toEqual([0, 1]);
        expect(arcade[0].primitives).toHaveLength(0);
        expect(arcade[1].primitives[0].reveal![0]).toBe(1);
        // the three of the L plan are at 0, a half and 1
        const l = nodes('lplan').flatMap(n => n.primitives.map(p => Math.round(p.reveal![0] * 65535)));
        expect([...new Set(l)].sort((a, b) => a - b)).toEqual([0, 32768, 65535]);
    });
});

describe('the loader', () => {
    it('three\'s GLTFLoader keeps node extras as userData and lowercases `_REVEAL` and `_DISP`, with LINES as line segments', async () => {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const bytes = fs.readFileSync(detail);
        const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
        expect(gltf.userData.sb).toMatchObject({ schema: 'scratchbox.staged-glb/2', stage: 'detail' });
        expect(gltf.scene.userData.sb).toMatchObject({ schema: 'scratchbox.staged-glb/2', stage: 'detail' });
        const seen: Record<string, { reveal: boolean; disp: boolean; lines: boolean; kind: string }> = {};
        gltf.scene.traverse((o: any) => {
            const id = o.userData?.sb?.ids?.elementId ?? o.userData?.sb?.ids?.degradationId;
            if (!id || !(o.isMesh || o.isLineSegments)) return;
            const g = o.geometry;
            seen[id] = { reveal: !!g.getAttribute('_reveal'), disp: !!g.getAttribute('_disp'), lines: !!o.isLineSegments, kind: o.userData.sb.revealKind };
            if (g.getAttribute('_reveal')) expect(g.getAttribute('_reveal').itemSize).toBe(2);
            if (g.getAttribute('_disp')) expect(g.getAttribute('_disp').itemSize).toBe(3);
            expect(g.getAttribute('_REVEAL')).toBeUndefined();
        });
        expect(seen.e0).toEqual({ reveal: true, disp: false, lines: false, kind: 'sweep' });
        expect(seen.e1).toEqual({ reveal: true, disp: true, lines: false, kind: 'rise' });
        expect(seen.e2).toEqual({ reveal: true, disp: true, lines: false, kind: 'cells' });
        const deg = Object.entries(seen).find(([k]) => k.startsWith('ornament:'));
        expect(deg, 'the outline of the slot that e3 left without detail').toBeDefined();
        expect(deg![1]).toMatchObject({ lines: true, kind: 'outline' });
    });

    it('the fit\'s outlines are LINES coloured by fit error, one node per primitive, and read back through the loader', async () => {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const bytes = fs.readFileSync(fits.lplan.fit.outputs.outlinesGlb);
        const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
        const ids: string[] = [];
        gltf.scene.traverse((o: any) => {
            if (!o.isLineSegments) return;
            ids.push(o.userData.sb.ids.primitiveId);
            expect(o.geometry.getAttribute('color')).toBeDefined();
            expect(o.geometry.getAttribute('_reveal')).toBeDefined();
        });
        expect(ids).toEqual(fits.lplan.fit.primitives.map(p => p.id));
    });
});

describe('run independence', () => {
    it('the fit and the detail layers are the same bytes in another cache: nothing in the extras is a path, a time or a process id', async () => {
        const other = new ScanFitService({ workspaceRoot: work, repoRoot: REPO, cacheDir: '.cache-other' });
        const lp = fits.lplan;
        const r = await other.fit({ scanGlb: rel(lp.scan), anchor: { x: lp.anchor[0], z: lp.anchor[1] }, sourceLimits: LIMITS });
        expect(r.dir).not.toBe(path.dirname(lp.path));
        expect(sha(r.value.outputs.fittedGlb)).toBe(sha(lp.fit.outputs.fittedGlb));
        expect(sha(r.value.outputs.outlinesGlb)).toBe(sha(lp.fit.outputs.outlinesGlb));
        const text = fs.readFileSync(detail, 'latin1');
        expect(text).not.toContain(work);
        expect(text).not.toContain(os.tmpdir());
        const shot = saveClayShot('staged_glb_lplan_fit', [{ file: fits.lplan.fit.outputs.fittedGlb, color: [0.72, 0.74, 0.77] }], { bearingDeg: 200, elevationDeg: 25 });
        expect(shot.covered).toBeGreaterThan(0.03);
    }, 120_000);
});
