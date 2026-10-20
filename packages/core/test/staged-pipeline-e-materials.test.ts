/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's material channels (massing-materials.ts, written by massing-glb.ts): on a synthetic wall face with one
 * opening (a recessed pane inside four reveals), the textured twin's page gets a metallicRoughness texture whose pane
 * texels are glass (roughness 0.05, dielectric) and whose wall texels keep the masonry value, the viewer's parameters
 * (R glass weight from the opening's confidence, A the material source, labelled with the opening's own provenance), and
 * a pane that is not darker than its wall is rejected and leaves no material channels at all. Off (materials: false),
 * the page is the plain baseColor material it was.
 */

import { describe, expect, it } from 'vitest';
import type { ProvenanceRecord } from '../src/common/spatial/staged-location-contracts';
import { writeMassingTexturedGlb, type FaceTexture, type MassingGlbInput, type TexelSource } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import { GLASS_MAX_LUMA_RATIO, massingMaterials } from '../src/node/3d-engine/staged-location/pipeline-e/massing-materials';
import type { MassingFace, MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { GLASS_ROUGHNESS, WALL_ROUGHNESS } from '../src/node/3d-engine/staged-location/facade-materials';
import { parseGlb } from './helpers/clay-glb-render';
import { decodePng } from './helpers/png-decode';

/** One wall face: the plane z = 0 facing +z, s along +x (0..8 m), t along +y (0..6 m), 0.1 m texels. */
function wallFace(): MassingFace {
    return {
        index: 0, key: 'w:test:0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true,
        normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: 8, tMin: 0, tMax: 6, tBottom: 0, area: 48,
        pixel: 0.1, orthoSMin: 0, orthoTMax: 6, width: 80, height: 60, coverage: 1, openings: ['op'], top: []
    };
}

/** Quads as a node: each quad [s0, s1, t0, t1, depth z0, z1] in the face frame (pane: z0 = z1; reveals: z0 != z1). */
function node(name: string, kind: string, provenance: string, confidence: number | null, quads: Array<Array<[number, number, number]>>): MassingNode {
    const pos: number[] = [], nrm: number[] = [], st: number[] = [], ref: number[] = [], idx: number[] = [];
    for (const q of quads) {
        const base = pos.length / 3;
        for (const [x, y, z] of q) { pos.push(x, y, z); nrm.push(0, 0, 1); st.push(x, y); ref.push(0); }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { name, kind, provenance, confidence, positions: new Float32Array(pos), normals: new Float32Array(nrm), ref: new Int32Array(ref), st: new Float32Array(st), indices: new Uint32Array(idx) };
}

/** The wall with a hole at s 3..5, t 2..4 (four quads around it), and the opening: a pane 0.15 m back and its reveals. */
function scene(paneShade: number, label = 'generated'): { input: MassingGlbInput; paneTexel: number; wallTexel: number } {
    const face = wallFace();
    const wall = node('w:test:0', 'wall', 'massing', null, [
        [[0, 0, 0], [8, 0, 0], [8, 2, 0], [0, 2, 0]], [[0, 4, 0], [8, 4, 0], [8, 6, 0], [0, 6, 0]],
        [[0, 2, 0], [3, 2, 0], [3, 4, 0], [0, 4, 0]], [[5, 2, 0], [8, 2, 0], [8, 4, 0], [5, 4, 0]]
    ]);
    const d = -0.15;
    const opening = node('opening:plate_0_0', 'opening', label, 0.7, [
        [[3, 2, d], [5, 2, d], [5, 4, d], [3, 4, d]],                       // the pane
        [[3, 2, 0], [3, 2, d], [3, 4, d], [3, 4, 0]], [[5, 2, d], [5, 2, 0], [5, 4, 0], [5, 4, d]], // reveals (normal along s)
        [[3, 2, 0], [5, 2, 0], [5, 2, d], [3, 2, d]], [[3, 4, d], [5, 4, d], [5, 4, 0], [3, 4, 0]]  // sill and head (normal along t)
    ]);
    const tex: FaceTexture = { width: 80, height: 60, rgba: new Uint8Array(80 * 60 * 4), source: new Uint8Array(80 * 60) };
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
        const s = (x + 0.5) * 0.1, t = 6 - (y + 0.5) * 0.1;
        const inPane = s > 3 && s < 5 && t > 2 && t < 4;
        const v = inPane ? paneShade : 170 + ((x * 7 + y * 3) % 11);
        tex.rgba.set([v, v - 5, v - 10, 255], (y * 80 + x) * 4);
    }
    const legend: TexelSource[] = [{ source: 'tile-ortho', label: 'as-scanned', method: 'test', rung: 2, weight: 0.8 }];
    const provenanceOf = (n: MassingNode): ProvenanceRecord => (n.kind === 'opening' ? { label: n.provenance, measuredGeometry: false, confidence: n.confidence ?? 0.5, method: 'test opening', sources: [] } : { label: 'vector-massing', measuredGeometry: false, method: 'test wall', sources: [] });
    const input: MassingGlbInput = {
        nodes: [wall, opening], faces: [face], stage: 'remesh', stageKey: 'test', provenanceOf,
        textures: new Map([[0, tex]]), legend, tileImages: new Map(), tileLegendIndex: 0
    };
    // texel (x, y) of the face at s 4, t 3 (the pane's centre) and s 1, t 1 (the wall)
    return { input, paneTexel: 30 * 80 + 40, wallTexel: 50 * 80 + 10 };
}

function pageImages(glb: Buffer) {
    const { json, bin } = parseGlb(glb);
    const mat = json.materials.find((m: { name: string }) => m.name === 'MassingPage0');
    const imageOf = (tex: number) => { const im = json.images[json.textures[tex].source]; const v = json.bufferViews[im.bufferView]; return decodePng(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); };
    return { json, mat, imageOf };
}

describe('pipeline E material channels', () => {
    it('reads the pane as glass where it is darker than its wall, with the opening\'s label and confidence', () => {
        const { input } = scene(40);
        const r = massingMaterials({ nodes: input.nodes as MassingNode[], faces: input.faces, textures: input.textures, labelOf: n => input.provenanceOf(n).label, confidenceOf: n => input.provenanceOf(n).confidence ?? 0.5 });
        expect(r.totals).toMatchObject({ candidates: 1, accepted: 1, rejected: 0 });
        // the pane only (2 x 2 m at 0.1 m: ~400 texels), not the reveals' or sill's strips
        expect(r.totals.glassTexels).toBeGreaterThan(360);
        expect(r.totals.glassTexels).toBeLessThan(450);
        expect(r.sources).toHaveLength(1);
        expect(r.sources[0].label).toBe('generated');
        expect(r.regions[0].reason).toMatch(/darker than its wall/);
    });

    it('writes a metallicRoughness map: glass texels low roughness, masonry the wall value, dielectric; parameters with the source', () => {
        const { input, paneTexel, wallTexel } = scene(40, 'photo-inferred');
        const out = writeMassingTexturedGlb({ ...input, materials: true });
        expect(out.materials?.totals.accepted).toBe(1);
        const { mat, imageOf } = pageImages(out.glb);
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(mat.pbrMetallicRoughness.roughnessFactor).toBe(1);
        const ex = mat.extras.sbMaterial;
        expect(ex.schema).toBe('scratchbox.staged-material/1');
        expect(ex.materialSources.map((s: { label: string }) => s.label)).toEqual(['photo-inferred', 'assumed']);
        const mr = imageOf(mat.pbrMetallicRoughness.metallicRoughnessTexture.index), pr = imageOf(ex.paramsTexture);
        // the page packs the face at (2, 2) with scale 1 (GUTTER); the face's texel (x, y) is the page's (x + 2, y + 2)
        const pl = out.packing.place.get(0)!;
        expect(pl.scale).toBe(1);
        const at = (t: number) => (Math.floor(t / 80) + pl.y) * mr.width + (t % 80) + pl.x;
        const P = at(paneTexel), Wl = at(wallTexel);
        expect(mr.pixels[P * mr.channels + 1]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(mr.pixels[Wl * mr.channels + 1]).toBe(Math.round(WALL_ROUGHNESS * 255));
        expect(mr.pixels[P * mr.channels + 2]).toBe(0);
        expect(mr.pixels[Wl * mr.channels + 2]).toBe(0);
        expect(pr.pixels[P * pr.channels]).toBe(Math.round(255 * 0.7));
        expect(pr.pixels[Wl * pr.channels]).toBe(0);
        expect(pr.pixels[P * pr.channels + 3]).toBe(0);    // source 0: the photo-inferred openings
        expect(pr.pixels[Wl * pr.channels + 3]).toBe(255); // the assumed wall default
        // across the whole page: every glass texel is in the pane, every non-glass texel is the wall value
        let glass = 0;
        for (let i = 0; i < mr.width * mr.height; i++) {
            const g = mr.pixels[i * mr.channels + 1];
            if (pr.pixels[i * pr.channels] > 0) { glass++; expect(g).toBe(Math.round(GLASS_ROUGHNESS * 255)); } else expect(g).toBe(Math.round(WALL_ROUGHNESS * 255));
        }
        expect(glass).toBe(out.materials!.totals.glassTexels);
    });

    it(`a pane not darker than its wall (above ${GLASS_MAX_LUMA_RATIO} of it) is rejected and the page keeps its plain material`, () => {
        const { input } = scene(168);
        const out = writeMassingTexturedGlb({ ...input, materials: true });
        expect(out.materials?.totals).toMatchObject({ accepted: 0, rejected: 1, glassTexels: 0 });
        expect(out.materials?.regions[0].reason).toMatch(/not darker/);
        const { mat } = pageImages(out.glb);
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(mat.extras.sbMaterial).toBeUndefined();
        expect(mat.pbrMetallicRoughness.roughnessFactor).toBe(0.85);
    });

    it('off: the twin is byte-identical to the writer without material channels', () => {
        const { input } = scene(40);
        const off = writeMassingTexturedGlb({ ...input, materials: false });
        expect(off.materials).toBeUndefined();
        const { mat } = pageImages(off.glb);
        expect(mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(writeMassingTexturedGlb({ ...input, materials: false }).glb.equals(off.glb)).toBe(true);
    });
});
