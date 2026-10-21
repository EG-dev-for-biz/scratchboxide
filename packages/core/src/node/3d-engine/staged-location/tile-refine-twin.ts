/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The textured twin of a remesh whose texture pass would have to unwrap a whole district (a million triangles): the
 * photo-textured GLB tile_refine already writes beside its clay output (the same triangles, each primitive's UVs into the
 * leaf tile's own photo, as captured: not de-lit), made into a twin the viewport crossfades to.
 *
 *   - Every material gets the texture-pass extras (extras.sbTexture.confidenceTexture) so the viewport keeps the photo under
 *     its clay pass and shades its rung: a 1 x 1 confidence texel, R = provenance index, G = 255, B = rung, A = 255.
 *   - A primitive with a photo is rung 'tile photo transfer' (labelled photo-inferred, source 'tile-photo'); one without
 *     a photo is rung 'clay'. The shares are measured by triangle area, so the labels say what the twin holds.
 *   - Materials are drawn from both sides, like the clay they swap with.
 *
 * Nothing is re-projected or invented; the geometry bytes are tile_refine's.
 */

import { TEXTURE_LADDER_RUNGS, TEXTURE_RUNG_CLAY } from '../../../common/spatial/texture-pass-contracts';
import { assembleGlb, parseGlbBytes, readAccessor } from './glb-bytes';
import { encodePng } from './png-encode';
import { CONFIDENCE_CHANNELS } from './staged-glb-writer';

export const TILE_REFINE_TWIN_VERSION = 'tile-refine-twin/v1';
/** The rung of a photo texel from the tile (TEXTURE_LADDER_RUNGS). */
export const RUNG_TILE_PHOTO = TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer');

export interface TileRefineTwin {
    glb: Buffer;
    /** Share per rung by triangle area (TEXTURE_LADDER_RUNGS order). */
    rungShares: number[];
    provenance: Array<{ source: string; label: string; method: string; coverage: number }>;
    ladderRung: number;
    triangles: number;
}

function triArea(p: Float64Array, a: number, b: number, c: number): number {
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** The twin of tile_refine's photo-textured output `texturedGlb` (its bytes) for the layer `layerKey`. */
export function tileRefineTwin(texturedGlb: Uint8Array, layerKey: string): TileRefineTwin {
    const g = parseGlbBytes(texturedGlb);
    const json = JSON.parse(JSON.stringify(g.json));
    const materials: any[] = json.materials ?? (json.materials = []);
    const photo = (mi: number | undefined) => mi !== undefined && materials[mi]?.pbrMetallicRoughness?.baseColorTexture !== undefined;
    // measured shares: triangle area per primitive, photo or not
    let photoArea = 0, bareArea = 0, triangles = 0;
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        let area = 0;
        for (let t = 0; t + 2 < n; t += 3) area += idx ? triArea(pos, idx[t], idx[t + 1], idx[t + 2]) : triArea(pos, t, t + 1, t + 2);
        triangles += Math.floor(n / 3);
        if (photo(prim.material)) photoArea += area; else bareArea += area;
        // a primitive with no material gets one that says it is clay
        if (prim.material === undefined) {
            materials.push({ name: 'TileRefineTwinClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } });
            prim.material = materials.length - 1;
        }
    }
    const total = photoArea + bareArea;
    if (!(total > 0)) throw new Error('tile_refine wrote no triangles to texture');
    const provenance = [
        { source: 'tile-photo', label: 'photo-inferred', method: "tile_refine's remesh carries the leaf tiles' own photos (UVs into each leaf's image), as captured: not de-lit", coverage: photoArea / total },
        { source: 'clay', label: 'clay', method: 'no photo on these triangles', coverage: bareArea / total }
    ].filter(p => p.coverage > 0);
    const rungShares = new Array<number>(TEXTURE_LADDER_RUNGS.length).fill(0);
    rungShares[RUNG_TILE_PHOTO] = photoArea / total;
    rungShares[TEXTURE_RUNG_CLAY] += bareArea / total;
    const indexOf = (source: string) => provenance.findIndex(p => p.source === source);

    // the confidence texels, appended to the binary chunk as PNGs
    const bin: Uint8Array[] = [g.bin];
    let binLength = g.bin.byteLength;
    const pad = () => { const r = binLength % 4; if (r) { bin.push(new Uint8Array(4 - r)); binLength += 4 - r; } };
    json.images = json.images ?? [];
    json.textures = json.textures ?? [];
    json.samplers = json.samplers ?? [];
    json.bufferViews = json.bufferViews ?? [];
    json.samplers.push({ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 });
    const sampler = json.samplers.length - 1;
    const confTexture = (provIndex: number, rung: number): number => {
        const png = encodePng(1, 1, Uint8Array.from([provIndex, 255, rung, 255]), 4);
        pad();
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: png.length });
        bin.push(png);
        binLength += png.length;
        json.images.push({ name: `${layerKey}_confidence_${rung}`, mimeType: 'image/png', bufferView: json.bufferViews.length - 1 });
        json.textures.push({ sampler, source: json.images.length - 1, name: `${layerKey}_confidence_${rung}` });
        return json.textures.length - 1;
    };
    const photoConf = photoArea > 0 ? confTexture(indexOf('tile-photo'), RUNG_TILE_PHOTO) : -1;
    const bareConf = bareArea > 0 ? confTexture(indexOf('clay'), TEXTURE_RUNG_CLAY) : -1;
    materials.forEach((m, mi) => {
        const conf = photo(mi) ? photoConf : bareConf;
        if (conf < 0) return;
        m.doubleSided = true;
        m.extras = { ...(m.extras ?? {}), sbTexture: { confidenceTexture: conf, confidenceChannels: CONFIDENCE_CHANNELS } };
    });
    json.buffers = [{ byteLength: binLength }];
    json.asset = json.asset ?? { version: '2.0' };
    json.asset.extras = {
        ...(json.asset.extras ?? {}),
        sbTexture: {
            schema: 'scratchbox.staged-texture/1', layerKey, provenance, degradations: [], ladder: TEXTURE_LADDER_RUNGS,
            confidenceTexture: photoConf >= 0 ? photoConf : bareConf, confidenceChannels: CONFIDENCE_CHANNELS, source: TILE_REFINE_TWIN_VERSION
        }
    };
    pad();
    const out = new Uint8Array(binLength);
    let o = 0;
    for (const b of bin) { out.set(b, o); o += b.byteLength; }
    const ladderRung = rungShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1);
    return { glb: assembleGlb(json, out), rungShares, provenance, ladderRung, triangles };
}
