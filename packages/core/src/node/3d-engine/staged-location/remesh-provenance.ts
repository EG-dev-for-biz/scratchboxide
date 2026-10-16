/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's per-vertex provenance, read from the remeshed GLB it wrote (595978d7):
 *   _RECTIFY_DISPLACEMENT  metres the scan surface was moved by rectify and facade flatten (relief not included);
 *   _PROUD_BLOCK           1 = a proud block kept as scanned, 2 = a block snapped at its own level, 0 = not a block;
 *   _RELIEF_HEIGHT         metres carved along the facade normal by photometric relief: inferred from the photo.
 * Each is counted in the contracts' bands (classifyRemeshVertex), never by an exact-zero test: the seam solve nudges
 * vertices by sub-millimetre amounts. A written attribute is on every primitive, so an attribute that is absent is no
 * per-vertex claim, never "as scanned". The GLB bytes are only read.
 */

import * as fs from 'fs';
import {
    PROUD_BLOCK_BANDS,
    RECTIFY_DISPLACEMENT_BANDS,
    RELIEF_HEIGHT_CARVED_MIN_M,
    TILE_REFINE_VERTEX_ATTRIBUTES,
    type TileRefineAssetExtras,
    type VertexBand,
    type VertexProvenanceSummary
} from '../../../common/spatial/staged-location-contracts';

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

interface Glb { json: any; bin: Buffer }

function readGlb(file: string): Glb {
    const buf = fs.readFileSync(file);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a binary glTF`);
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
    const at = 20 + jsonLength;
    const bin = at + 8 <= buf.length ? buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at)) : Buffer.alloc(0);
    return { json, bin };
}

/** The first component of each element of a float accessor. */
function readScalar(glb: Glb, index: number): Float32Array {
    const acc = glb.json.accessors?.[index];
    if (!acc) throw new Error(`accessor ${index} is missing`);
    if (acc.componentType !== 5126) throw new Error(`accessor ${index} is not FLOAT (componentType ${acc.componentType})`);
    const out = new Float32Array(acc.count);
    if (acc.bufferView === undefined) return out; // all zero, per the glTF spec
    const view = glb.json.bufferViews[acc.bufferView];
    const stride = view.byteStride || 4 * (COMPONENTS[acc.type] ?? 1);
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    for (let i = 0; i < acc.count; i++) out[i] = glb.bin.readFloatLE(base + i * stride);
    return out;
}

function inBand(value: number, b: VertexBand): boolean {
    return value >= b.minM && (b.maxM === undefined || value < b.maxM);
}

export interface RemeshProvenance {
    summary: VertexProvenanceSummary;
    /** tile_refine's own description of each attribute (asset.extras.scratchbox.attributes). */
    attributeNotes: Record<string, string>;
    relief?: NonNullable<NonNullable<TileRefineAssetExtras['scratchbox']>['relief']>;
}

/** Counts a tile_refine GLB's per-vertex provenance in bands. Only TRIANGLES primitives are read. */
export function readRemeshProvenance(glbPath: string): RemeshProvenance {
    const glb = readGlb(glbPath);
    const names = Object.values(TILE_REFINE_VERTEX_ATTRIBUTES) as string[];
    const present = new Set<string>();
    let vertices = 0;
    const displacementCounts = RECTIFY_DISPLACEMENT_BANDS.map(() => 0);
    let maxDisplacement = 0;
    let kept = 0, snapped = 0;
    let carved = 0, maxRelief = 0;
    for (const mesh of glb.json.meshes ?? []) {
        for (const prim of mesh.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4) continue;
            const count = glb.json.accessors?.[prim.attributes?.POSITION]?.count ?? 0;
            vertices += count;
            const attrs = prim.attributes ?? {};
            for (const n of names) if (attrs[n] !== undefined) present.add(n);
            if (attrs[TILE_REFINE_VERTEX_ATTRIBUTES.rectifyDisplacement] !== undefined) {
                const d = readScalar(glb, attrs[TILE_REFINE_VERTEX_ATTRIBUTES.rectifyDisplacement]);
                for (const v of d) {
                    const a = Math.abs(v);
                    if (!Number.isFinite(a)) continue;
                    if (a > maxDisplacement) maxDisplacement = a;
                    const b = RECTIFY_DISPLACEMENT_BANDS.findIndex(x => inBand(a, x));
                    if (b >= 0) displacementCounts[b]++;
                }
            }
            if (attrs[TILE_REFINE_VERTEX_ATTRIBUTES.proudBlock] !== undefined) {
                const p = readScalar(glb, attrs[TILE_REFINE_VERTEX_ATTRIBUTES.proudBlock]);
                const [keptBand, snappedBand] = PROUD_BLOCK_BANDS;
                for (const v of p) {
                    if (inBand(v, keptBand)) kept++;
                    else if (inBand(v, snappedBand)) snapped++;
                }
            }
            if (attrs[TILE_REFINE_VERTEX_ATTRIBUTES.reliefHeight] !== undefined) {
                const h = readScalar(glb, attrs[TILE_REFINE_VERTEX_ATTRIBUTES.reliefHeight]);
                for (const v of h) {
                    const a = Math.abs(v);
                    if (Number.isFinite(a) && a >= RELIEF_HEIGHT_CARVED_MIN_M) {
                        carved++;
                        if (a > maxRelief) maxRelief = a;
                    }
                }
            }
        }
    }
    const summary: VertexProvenanceSummary = {
        schema: 'scratchbox.vertex-provenance/1',
        attributes: names.filter(n => present.has(n)),
        vertices,
        ...(present.has(TILE_REFINE_VERTEX_ATTRIBUTES.rectifyDisplacement) ? {
            rectifyDisplacement: {
                maxM: maxDisplacement,
                bands: RECTIFY_DISPLACEMENT_BANDS.map((b, i) => ({ band: b.band, minM: b.minM, ...(b.maxM !== undefined ? { maxM: b.maxM } : {}), vertices: displacementCounts[i] }))
            }
        } : {}),
        ...(present.has(TILE_REFINE_VERTEX_ATTRIBUTES.proudBlock) ? { proudBlocks: { keptAsScannedVertices: kept, snappedVertices: snapped } } : {}),
        ...(present.has(TILE_REFINE_VERTEX_ATTRIBUTES.reliefHeight) ? { relief: { carvedVertices: carved, maxAbsHeightM: maxRelief } } : {})
    };
    const extras = (glb.json.asset?.extras ?? {}) as TileRefineAssetExtras;
    return {
        summary,
        attributeNotes: { ...(extras.scratchbox?.attributes ?? {}) },
        ...(extras.scratchbox?.relief ? { relief: extras.scratchbox.relief } : {})
    };
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '0%');

/**
 * What the remesh did to the scan, per vertex, in words with numbers: the displacement bands, the proud blocks kept or
 * snapped, and the vertices carved by photo relief (photo-inferred). Without attributes it says there is no per-vertex
 * claim, never that the surface is as scanned.
 */
export function describeRemeshProvenance(s: VertexProvenanceSummary): string {
    if (s.attributes.length === 0) return 'tile_refine wrote no per-vertex provenance for this remesh, so no vertex is claimed as moved or as scanned';
    const parts: string[] = [];
    const d = s.rectifyDisplacement;
    if (d) {
        const by = Object.fromEntries(d.bands.map(b => [b.band, b.vertices]));
        const moved = (by.moved ?? 0) + (by.reshaped ?? 0);
        parts.push(`rectify and facade flatten moved ${pct(moved, s.vertices)} of its ${s.vertices.toLocaleString()} vertices by 1 cm or more (${pct(by.reshaped ?? 0, s.vertices)} by more than 5 cm; at most ${d.maxM.toFixed(2)} m)`);
    }
    const p = s.proudBlocks;
    if (p && (p.keptAsScannedVertices > 0 || p.snappedVertices > 0)) {
        parts.push(`${p.keptAsScannedVertices.toLocaleString()} vertices of proud blocks were kept as scanned and ${p.snappedVertices.toLocaleString()} snapped at their own level`);
    }
    const r = s.relief;
    if (r) {
        parts.push(r.carvedVertices > 0
            ? `${r.carvedVertices.toLocaleString()} vertices were carved by photo relief (photo-inferred, up to ${(r.maxAbsHeightM * 100).toFixed(0)} cm)`
            : 'photo relief carved no vertex');
    }
    return parts.join('; ');
}
