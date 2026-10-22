/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture pass's generated-PBR rung (rung 5) from the surface library (surface-materials.ts): the texels of a rebuilt
 * surface that no photo reaches (no Street View view, no tile photo texel near it) take the library entry chosen for that
 * surface, at its real-world size (world-scale planar UVs from each texel's own position and normal) and tinted to the
 * colour measured on the surface. Labelled 'generated', with the entry. Data only (typed arrays), so the spec crosses into
 * a texture worker thread.
 */

import { packConfidenceTexel, TEXTURE_LADDER_RUNGS, type BakedTexturePlanes } from '../../../common/spatial/texture-pass-contracts';
import { linearToSrgb255, SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import type { LaidOutUvAtlas } from './texture-uv';

/** Part of the texture cache key of a layer filled from the library. */
export const LIBRARY_FILL_VERSION = 'library-fill/2-mip';

export const RUNG_LIBRARY = TEXTURE_LADDER_RUNGS.indexOf('generated tileable PBR');

/** Which use a texel takes: per node (by name) its walls' and its level surfaces' use; a grid in plan for a node split by region. */
export interface LibraryFillSpec {
    entries: Array<{ id: string; width: number; height: number; /** sRGB8 RGBA. */ rgba: Uint8Array; realSizeM: [number, number] }>;
    /** A use: an entry and the per-channel linear gain to the surface's measured colour. */
    uses: Array<{ entry: number; tint: [number, number, number]; key: string }>;
    byNode: Record<string, { wall: number; level: number }>;
    /** A node whose use is read from a plan grid (the ground's regions): cell -> use (-1: the node's own). */
    grids?: Record<string, { x0: number; z0: number; cellM: number; nx: number; nz: number; use: Int16Array }>;
    /** For nodes not named. */
    fallback?: { wall: number; level: number };
    /** |n_y| at or above this: a level surface. */
    levelAbove?: number;
}

/**
 * Fills the texels `base` leaves empty (its albedo alpha 0) where the spec has a use for them. Returns new planes holding
 * only those texels, rung 5, with one provenance entry per use that filled any.
 */
/** An entry's colour map in linear light and its box-filtered halvings (level 0 the map itself). */
function mipChain(e: LibraryFillSpec['entries'][number]): Array<{ w: number; h: number; lin: Float32Array }> {
    const lin = new Float32Array(e.width * e.height * 3);
    for (let i = 0; i < e.width * e.height; i++) for (let c = 0; c < 3; c++) lin[i * 3 + c] = SRGB8_TO_LINEAR[e.rgba[i * 4 + c]];
    const out = [{ w: e.width, h: e.height, lin }];
    while (out[out.length - 1].w > 1 && out[out.length - 1].h > 1) {
        const p = out[out.length - 1], w = p.w >> 1, h = p.h >> 1, q = new Float32Array(w * h * 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
            const at = (xx: number, yy: number) => p.lin[(yy * p.w + xx) * 3 + c];
            q[(y * w + x) * 3 + c] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
        }
        out.push({ w, h, lin: q });
    }
    return out;
}

/**
 * Fills the texels `base` leaves empty (its albedo alpha 0) where the spec has a use for them. Each texel samples the
 * entry's map at the level whose pixel matches the texel's own footprint (a 0.3 m atlas texel over a gravel map of 1.25 mm
 * pixels takes the gravel's average, not one random pebble: Federation Square, 2026-10-22). Returns new planes holding
 * only those texels, rung 5, with one provenance entry per use that filled any.
 */
export function libraryFill(atlas: LaidOutUvAtlas, base: BakedTexturePlanes, spec: LibraryFillSpec): BakedTexturePlanes & { filled: number } {
    const W = atlas.width, H = atlas.height, N = W * H;
    const out: BakedTexturePlanes = {
        layerKey: base.layerKey, width: W, height: H, albedo: new Uint8Array(N * 4),
        confidence: { width: W, height: H, data: new Uint8Array(N * 4) },
        provenance: [], degradations: []
    };
    const P = atlas.texels.position, Nn = atlas.texels.normal, T = atlas.texels;
    const levelAbove = spec.levelAbove ?? 0.6;
    const counts = new Map<number, number>();
    const useIndex = new Map<number, number>();
    const mips = new Map<number, ReturnType<typeof mipChain>>();
    let filled = 0;
    for (let i = 0; i < N; i++) {
        if (!T.covered[i] || T.gutter[i] || T.mapIndex[i] === 65535 || base.albedo[i * 4 + 3]) continue;
        // a surface cut into blocks for the texture pass keeps its own name before '#'
        const name = (atlas.maps[T.mapIndex[i]]?.nodeName ?? '').split('#')[0];
        const nx = Nn[i * 3], ny = Nn[i * 3 + 1], nz = Nn[i * 3 + 2];
        const level = Math.abs(ny) >= levelAbove;
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        let use = -1;
        const g = spec.grids?.[name];
        if (g) {
            const gi = Math.floor((x - g.x0) / g.cellM), gk = Math.floor((z - g.z0) / g.cellM);
            if (gi >= 0 && gk >= 0 && gi < g.nx && gk < g.nz) use = g.use[gk * g.nx + gi];
        }
        if (use < 0) { const r = spec.byNode[name] ?? spec.fallback; if (r) use = level ? r.level : r.wall; }
        if (use < 0 || !spec.uses[use]) continue;
        const u = spec.uses[use], e = spec.entries[u.entry];
        if (!e || !e.width || !e.height) continue;
        // world-scale planar UVs (as surface-materials.ts worldUvMetres): from above on the level, along and up a wall
        const h = Math.hypot(nx, nz);
        let um: number, vm: number;
        if (level || h < 1e-6) { um = x; vm = z; } else { um = (x * nz - z * nx) / h; vm = -y; }
        let chain = mips.get(u.entry);
        if (!chain) { chain = mipChain(e); mips.set(u.entry, chain); }
        const footprintPx = ((T.sizeM?.[i] || 0) * e.width) / e.realSizeM[0];
        const m = chain[Math.max(0, Math.min(chain.length - 1, Math.floor(Math.log2(Math.max(1, footprintPx)))))];
        const px = ((Math.floor((um / e.realSizeM[0]) * m.w) % m.w) + m.w) % m.w;
        const py = ((Math.floor((vm / e.realSizeM[1]) * m.h) % m.h) + m.h) % m.h;
        const s = (py * m.w + px) * 3;
        for (let c = 0; c < 3; c++) out.albedo[i * 4 + c] = Math.round(linearToSrgb255(Math.min(1, m.lin[s + c] * u.tint[c])));
        out.albedo[i * 4 + 3] = 255;
        if (!useIndex.has(use)) useIndex.set(use, useIndex.size);
        packConfidenceTexel(out.confidence, i, useIndex.get(use)!, 0.5, RUNG_LIBRARY);
        counts.set(use, (counts.get(use) ?? 0) + 1);
        filled++;
    }
    let covered = 0;
    for (let i = 0; i < N; i++) if (T.covered[i] && !T.gutter[i]) covered++;
    out.provenance = [...useIndex.keys()].map(use => ({
        source: 'generated-pbr', label: 'generated',
        method: `surface library entry ${spec.entries[spec.uses[use].entry].id} for ${spec.uses[use].key}, at its real size (${spec.entries[spec.uses[use].entry].realSizeM.join(' x ')} m a tile) and tinted to the colour measured on the surface; where no photo reaches`,
        coverage: covered ? (counts.get(use) ?? 0) / covered : 0
    }));
    return { ...out, filled };
}
