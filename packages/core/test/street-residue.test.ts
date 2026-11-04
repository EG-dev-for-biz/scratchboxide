/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street residue (street-residue.ts) on a synthetic street with the native residual audit (no network, no model): a lane
 * street photographed at 5 cm a texel, a crumpled brown pile melted into it over the dashed line, a second pile under a
 * fixture the vehicle step's model read, two bollards, and a needle shard hanging in the air. The pile is patched (its
 * vertices down on the street, its texels the street's own), the shard deleted, and the bollards and the read fixture kept
 * byte for byte; the spike rule reads a twisting section and not a post's.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { auditDistrict } from '../src/node/3d-engine/staged-location/district-residual-audit';
import { removeStreetResidue, sectionReversals, selectStreetResidue, STREET_RESIDUE_PARAMS } from '../src/node/3d-engine/staged-location/street-residue';
import { loadScanMesh, type GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import { HALF, inLump, laneStreet, lumpBump, noise, STEP, TEX, type Lump } from './surface-infill-fixtures';

type P3 = [number, number, number];
const PILE: Lump = { cx: -4, cz: 2.6, ax: 2.2, az: 1.1, h: 1.35, colour: [128, 84, 52] };
const READ: Lump = { cx: 6, cz: -6, ax: 1.6, az: 1.0, h: 1.2, colour: [128, 84, 52] };
const BOLLARDS: Array<[number, number]> = [[-5.5, 5.6], [-3, 5.6]];
const BOLLARD_HALF = 0.15, BOLLARD_TOP = 1.3;
const ground = (x: number, z: number) => laneStreet.ground(x, z);
/** The scan's surface: the street with both piles melted in, crumpled (a melted car is no smooth dome). */
const scanY = (x: number, z: number) => ground(x, z) + Math.max(...[PILE, READ].map(l => { const b = lumpBump(l, x, z); return b > 0 ? Math.max(0, b + 0.22 * noise(x, z, 0.35, 5)) : 0; }));

/** The street as a textured grid mesh, and the bollards and the shard as a second primitive in their own grey photo. */
function streetGlb(): Buffer {
    const parts: Buffer[] = [];
    const views: any[] = [];
    let off = 0;
    const add = (b: Buffer, target?: number) => { const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b); off += b.length; return views.length - 1; };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const accessors: any[] = [];
    const prim = (pos: number[], uv: number[], idx: number[], material: number) => {
        const nor = pos.map((_, j) => (j % 3 === 1 ? 1 : 0));
        const ax = [0, 1, 2].map(k => pos.filter((_, j) => j % 3 === k));
        accessors.push({ bufferView: add(f32(pos), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: ax.map(a => Math.min(...a)), max: ax.map(a => Math.max(...a)) });
        accessors.push({ bufferView: add(f32(nor), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3' });
        accessors.push({ bufferView: add(f32(uv), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC2' });
        accessors.push({ bufferView: add(Buffer.from(new Uint32Array(idx).buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        const b = accessors.length - 4;
        return { attributes: { POSITION: b, NORMAL: b + 1, TEXCOORD_0: b + 2 }, indices: b + 3, mode: 4, material };
    };
    const n = Math.round((2 * HALF) / STEP) + 1, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) { const x = -HALF + i * STEP, z = -HALF + k * STEP; pos.push(x, scanY(x, z), z); uv.push((x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF)); }
    for (let k = 0; k + 1 < n; k++) for (let i = 0; i + 1 < n; i++) { const a = k * n + i, b = a + 1, c = a + n, d = c + 1; idx.push(a, c, b, b, c, d); }
    const street = prim(pos, uv, idx, 0);
    // the bollards (closed boxes on the street) and the shard (a needle sheet 2.5-4 m up, touching nothing)
    const fp: number[] = [], fu: number[] = [], fi: number[] = [];
    const tri = (a: P3, b: P3, c: P3) => { const o = fp.length / 3; fp.push(...a, ...b, ...c); fu.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5); fi.push(o, o + 1, o + 2); };
    const quad = (a: P3, b: P3, c: P3, d: P3) => { tri(a, b, c); tri(a, c, d); };
    for (const [x, z] of BOLLARDS) {
        const g = ground(x, z), lo: P3 = [x - BOLLARD_HALF, g, z - BOLLARD_HALF], hi: P3 = [x + BOLLARD_HALF, g + BOLLARD_TOP, z + BOLLARD_HALF];
        quad([lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]);
        quad([lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]);
        quad([lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]]);
        quad([lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]);
        quad([hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]);
    }
    const gs = ground(8, 6);
    tri([8, gs + 2.5, 6], [8.6, gs + 2.5, 6], [8.3, gs + 4, 6]);
    tri([8, gs + 2.5, 6], [8.3, gs + 4, 6], [7.95, gs + 3.6, 6]);
    const furniture = prim(fp, fu, fi, 1);
    const rgba = new Uint8Array(TEX * TEX * 4);
    for (let k = 0; k < TEX; k++) for (let i = 0; i < TEX; i++) {
        const x = -HALF + ((i + 0.5) / TEX) * 2 * HALF, z = -HALF + ((k + 0.5) / TEX) * 2 * HALF;
        const l = [PILE, READ].find(q => inLump(q, x, z, 0.1));
        const c = l ? l.colour.map(v => v + 18 * noise(x, z, 0.1, 3)) : laneStreet.truth(x, z);
        rgba.set([c[0], c[1], c[2], 255], (k * TEX + i) * 4);
    }
    const grey = new Uint8Array(16 * 16 * 4).map((_, j) => (j % 4 === 3 ? 255 : 150));
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [{ primitives: [street] }, { primitives: [furniture] }],
        materials: [0, 1].map(t => ({ pbrMetallicRoughness: { baseColorTexture: { index: t }, metallicFactor: 0, roughnessFactor: 1 } })),
        accessors, bufferViews: views
    };
    const v0 = add(encodePng(TEX, TEX, rgba, 4)), v1 = add(encodePng(16, 16, grey, 4));
    json.images = [{ bufferView: v0, mimeType: 'image/png' }, { bufferView: v1, mimeType: 'image/png' }];
    json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }];
    json.textures = [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }];
    json.buffers = [{ byteLength: off }];
    return assembleGlb(json, Buffer.concat(parts));
}

/** The street as measured (its grade, 1 m cells), the piles not in it. */
function groundModel(R: number): GroundModel {
    const nx = 2 * R, nz = 2 * R;
    const g = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) g[k * nx + i] = ground(-R + i + 0.5, -R + k + 0.5);
    return {
        cellMeters: 1, x0: -R, z0: -R, nx, nz, top: g, ground: g, open: new Uint8Array(nx * nz).fill(1), terrainMethod: 'walkable-surface',
        cellIndex: (x, z) => Math.floor(z + R) * nx + Math.floor(x + R),
        groundAt: (x, z) => (Math.abs(x) <= R && Math.abs(z) <= R ? ground(x, z) : NaN),
        topAt: (x, z) => ground(x, z)
    };
}

describe('street residue', () => {
    it('reads a twisting section as a spike and a post or a sign on one as not', () => {
        const tol = STREET_RESIDUE_PARAMS.spikeSizeTol;
        expect(sectionReversals([0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62], tol)).toBe(0);
        expect(sectionReversals([0.1, 0.1, 0.1, 0.1, 0.1, 0.6, 0.6, 0.6, 0.1], tol)).toBe(1);
        expect(sectionReversals([0.15, 0.29, 0.39, 0.22, 0.1, 0.32, 0.44, 0.55, 0.58, 0.37], tol)).toBeGreaterThanOrEqual(STREET_RESIDUE_PARAMS.spikeMinReversals);
    });

    it('patches the pile, deletes the floating shard, and keeps the bollards and the fixture the model read', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'street-residue-'));
        const before = streetGlb();
        const file = path.join(dir, 'stripped.glb');
        fs.writeFileSync(file, before);
        const scan = loadScanMesh(file);
        const R = HALF - 1, within = (x: number, z: number) => Math.abs(x) <= R && Math.abs(z) <= R;
        const g = groundModel(HALF);
        const audit = await auditDistrict({ scan, ground: g, buildingAt: () => 0, within, dir: path.join(dir, 'audit') });
        const keep = [{ lo: [READ.cx - READ.ax, READ.cz - READ.az] as [number, number], hi: [READ.cx + READ.ax, READ.cz + READ.az] as [number, number] }];
        // the selection: the pile a lump, the shard floating, the bollards slender, the read pile a fixture
        const sel = selectStreetResidue(audit.audit.clusters, keep);
        const at = (x: number, z: number) => audit.audit.clusters.filter(c => c.lo[0] - 0.3 < x && c.hi[0] + 0.3 > x && c.lo[2] - 0.3 < z && c.hi[2] + 0.3 > z).map(c => c.id);
        expect(sel.lumps).toHaveLength(1);
        expect(sel.lumps[0].kind).toBe('lump');
        expect(sel.lumps[0].lo[0]).toBeLessThan(PILE.cx);
        expect(sel.lumps[0].hi[0]).toBeGreaterThan(PILE.cx);
        expect(sel.floating).toEqual(expect.arrayContaining(at(8.3, 6)));
        const kept = new Map(sel.kept.map(k => [k.id, k.why] as const));
        for (const [x, z] of BOLLARDS) for (const id of at(x, z)) expect(kept.get(id)).toBe('slender');
        for (const id of at(READ.cx, READ.cz)) expect(kept.get(id)).toBe('fixture');
        const { glb, report } = await removeStreetResidue({ glb: before, scan, ground: g, audit, keep, look: { within } });
        expect(report.floating.triangles).toBe(2);
        expect(report.lumps).toHaveLength(1);
        const g0 = parseGlbBytes(before), g1 = parseGlbBytes(glb);
        // the shard's two triangles are gone from the furniture; the bollards' vertices are untouched
        const furn0 = g0.json.meshes[1].primitives[0], furn1 = g1.json.meshes[1].primitives[0];
        expect(readAccessor(g1, furn1.indices).count).toBe(readAccessor(g0, furn0.indices).count - 6);
        expect(Array.from(readAccessor(g1, furn1.attributes.POSITION).data)).toEqual(Array.from(readAccessor(g0, furn0.attributes.POSITION).data));
        // the street: the pile down on the street within 3 cm, the read pile and everything away from the pile as it was
        const p0 = readAccessor(g0, 0).data, p1 = readAccessor(g1, g1.json.meshes[0].primitives[0].attributes.POSITION).data;
        let inPile = 0, worst = 0, changedFar = 0, readKept = 0, readTotal = 0;
        for (let v = 0; v < p0.length; v += 3) {
            const x = p0[v], z = p0[v + 2];
            if (inLump(PILE, x, z)) { inPile++; worst = Math.max(worst, Math.abs(p1[v + 1] - ground(x, z))); }
            else if (!inLump(PILE, x, z, 2.5) && p1[v + 1] !== p0[v + 1]) changedFar++;
            if (inLump(READ, x, z, -0.3)) { readTotal++; if (p1[v + 1] === p0[v + 1]) readKept++; }
        }
        expect(inPile).toBeGreaterThan(100);
        expect(worst).toBeLessThan(0.03);
        expect(changedFar).toBe(0);
        expect(readKept).toBe(readTotal);
        // the pile's texels: the street's own (asphalt and the dashed line), no brown left
        const img = (() => { const view = g1.json.bufferViews[g1.json.images[0].bufferView]; return decodeImageInMemory(g1.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)); })();
        const lab = (c: ArrayLike<number>) => Colour.srgbToLab(c[0], c[1], c[2]);
        const brown = lab(PILE.colour);
        let core = 0, stillBrown = 0;
        for (let k = 0; k < img.height; k++) for (let i = 0; i < img.width; i++) {
            const x = -HALF + ((i + 0.5) / img.width) * 2 * HALF, z = -HALF + ((k + 0.5) / img.height) * 2 * HALF;
            if (!inLump(PILE, x, z, -0.3)) continue;
            core++;
            const o = (k * img.width + i) * 4;
            if (Colour.calculateDeltaE00(lab([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]), brown) < 15) stillBrown++;
        }
        expect(core).toBeGreaterThan(1000);
        expect(stillBrown / core).toBeLessThan(0.03);
        // the provenance
        const ex = g1.json.extras.sbStreetResidue;
        expect(ex.lumps).toHaveLength(1);
        expect(ex.lumps[0].geometry.label).toBe('generated');
        expect(ex.floating.triangles).toBe(2);
        expect(ex.infill.regions.length).toBeGreaterThan(0);
        expect(report.notes[0]).toMatch(/1 lumps and 0 spikes/);
    }, 900_000);
});
