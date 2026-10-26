/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The general, any-mesh version of facade-materials.ts's evidentiary floor: given several masked views of a mesh — real
 * photos with a known camera, or views the caller rendered of the mesh itself — a region of the mesh's own texture UV is
 * accepted as the described surface (by default glass) only where at least `minAgreeingViews` independent views mark it,
 * and more views mark it than don't. Nothing here is staged-location-specific: it only needs a GLB path and, per view, a
 * pinhole camera and a 0/255/128 mask (facade-material-evidence.ts's MASK_YES/MASK_NO/MASK_UNREAD) the same size as the
 * view. Projection is one BVH ray per sampled pixel (mesh_bvh_raycast's texCoord: the hit triangle's own UV, not the
 * barycentric weights), so a mesh needs no known facade planes or atlas, unlike readFacadeMaterials.
 */

import { bvhQueryHandlers } from '../gemini/tools/bvh-query-tools';
import type { ToolContext } from '../gemini/tools/types';
import { MASK_NO, MASK_YES } from '../3d-engine/staged-location/facade-material-evidence';

const raycastHandler = bvhQueryHandlers.find(([decl]) => decl.name === 'mesh_bvh_raycast')?.[1];

/** A pinhole camera in world space (right-handed, `fwd` the view direction, `fx`/`fy` in pixels). */
export interface PinholeView {
    eye: [number, number, number];
    right: [number, number, number];
    up: [number, number, number];
    fwd: [number, number, number];
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width: number;
    height: number;
    /** MASK_YES/MASK_NO/MASK_UNREAD per pixel, row-major, `width * height` long. */
    mask: Uint8Array;
}

export interface SpecularProjectionOptions {
    /** Rays cast per view, per axis (default 48: 2304 rays/view). The mask is sampled on this grid, not per source pixel. */
    raysPerAxis?: number;
    /** A UV cell needs at least this many distinct views marking it yes (default 2: the same floor as Street View agreement). */
    minAgreeingViews?: number;
    /** The UV-space accumulator's resolution per axis (default 256). */
    gridSize?: number;
}

export interface SpecularRegion {
    /** Cell indices [x0, y0, x1, y1) in the accumulator grid. */
    bounds: [number, number, number, number];
    cells: number;
    /** Share of the cells' total votes that were yes, across every view that saw them. */
    confidence: number;
    agreeingViews: number;
}

export interface SpecularProjectionResult {
    gridSize: number;
    /** uv = uvMin + (cell + 0.5) / gridSize * (uvMax - uvMin). */
    uvMin: [number, number];
    uvMax: [number, number];
    /** 0..255 per cell, row-major: the accepted confidence, 0 where not accepted. */
    votes: Uint8Array;
    cellsSampled: number;
    cellsAccepted: number;
    regions: SpecularRegion[];
}

function normalize(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** One ray per cell of a `raysPerAxis x raysPerAxis` grid over the view's own pixels, through its pinhole model. */
function viewRays(view: PinholeView, raysPerAxis: number): { originX: number; originY: number; originZ: number; dirX: number; dirY: number; dirZ: number }[] {
    const rays: { originX: number; originY: number; originZ: number; dirX: number; dirY: number; dirZ: number }[] = [];
    for (let gy = 0; gy < raysPerAxis; gy++) {
        const py = ((gy + 0.5) / raysPerAxis) * view.height;
        for (let gx = 0; gx < raysPerAxis; gx++) {
            const px = ((gx + 0.5) / raysPerAxis) * view.width;
            // pixel row 0 is the image's top (row-major, top row first): a smaller py is "more up", so the up
            // contribution is -dy, not +dy, or a pixel below centre would tilt the ray toward "up" instead of "down".
            const dx = (px - view.cx) / view.fx, dy = (py - view.cy) / view.fy;
            const dir = normalize([
                view.fwd[0] + dx * view.right[0] - dy * view.up[0],
                view.fwd[1] + dx * view.right[1] - dy * view.up[1],
                view.fwd[2] + dx * view.right[2] - dy * view.up[2]
            ]);
            rays.push({ originX: view.eye[0], originY: view.eye[1], originZ: view.eye[2], dirX: dir[0], dirY: dir[1], dirZ: dir[2] });
        }
    }
    return rays;
}

/** The mask value nearest the ray's own sample point (nearest-neighbour: the mask is already coarser than the source photo). */
function maskAt(view: PinholeView, gx: number, gy: number, raysPerAxis: number): number {
    const px = Math.min(view.width - 1, Math.floor(((gx + 0.5) / raysPerAxis) * view.width));
    const py = Math.min(view.height - 1, Math.floor(((gy + 0.5) / raysPerAxis) * view.height));
    return view.mask[py * view.width + px];
}

/**
 * Projects every view's mask onto the mesh's own texture UV via one BVH raycast per sampled pixel, and accepts a UV
 * accumulator cell as the described surface only where `minAgreeingViews` or more distinct views mark it yes and more
 * views mark it yes than no (the same two-views-must-agree floor facade-materials.ts holds real photos to).
 */
export async function projectMaskedViewsToUv(glbPath: string, views: PinholeView[], opts: SpecularProjectionOptions = {}): Promise<SpecularProjectionResult> {
    if (!raycastHandler) throw new Error('mesh_bvh_raycast is not registered in bvhQueryHandlers');
    if (views.length < 1) throw new Error('projectMaskedViewsToUv needs at least one view');
    const raysPerAxis = opts.raysPerAxis ?? 48;
    const minAgreeingViews = opts.minAgreeingViews ?? Math.min(2, views.length);
    const gridSize = opts.gridSize ?? 256;

    // pass 1: cast every view's rays once, keep (texCoord, maskValue) per hit so the grid can be sized to the mesh's own UV span
    const hitsPerView: Array<Array<{ u: number; v: number; yes: boolean }>> = [];
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const view of views) {
        const rays = viewRays(view, raysPerAxis);
        const outcome = await raycastHandler({ glbPath, rays }, {} as ToolContext);
        if (outcome.status !== 'completed') throw new Error(`raycast failed: ${JSON.stringify(outcome.resultPayload)}`);
        const hits = (outcome.resultPayload as { hits: Array<{ hit: boolean; texCoord?: [number, number] }> }).hits;
        const kept: Array<{ u: number; v: number; yes: boolean }> = [];
        for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            if (!h.hit || !h.texCoord) continue;
            const m = maskAt(view, i % raysPerAxis, Math.floor(i / raysPerAxis), raysPerAxis);
            if (m !== MASK_YES && m !== MASK_NO) continue; // unread: not a vote either way
            const [u, v] = h.texCoord;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
            kept.push({ u, v, yes: m === MASK_YES });
        }
        hitsPerView.push(kept);
    }
    if (!Number.isFinite(uMin)) return { gridSize, uvMin: [0, 0], uvMax: [1, 1], votes: new Uint8Array(gridSize * gridSize), cellsSampled: 0, cellsAccepted: 0, regions: [] };
    // a little slack so a hit exactly on the max edge still lands in-bounds
    const uSpan = Math.max(1e-6, uMax - uMin) * 1.001, vSpan = Math.max(1e-6, vMax - vMin) * 1.001;

    // pass 2: accumulate, per cell, which distinct views voted yes/no
    const yesViews: Array<Set<number>> = Array.from({ length: gridSize * gridSize }, () => new Set<number>());
    const noViews: Array<Set<number>> = Array.from({ length: gridSize * gridSize }, () => new Set<number>());
    hitsPerView.forEach((hits, viewIndex) => {
        for (const h of hits) {
            const gx = Math.min(gridSize - 1, Math.floor(((h.u - uMin) / uSpan) * gridSize));
            const gy = Math.min(gridSize - 1, Math.floor(((h.v - vMin) / vSpan) * gridSize));
            const cell = gy * gridSize + gx;
            (h.yes ? yesViews[cell] : noViews[cell]).add(viewIndex);
        }
    });

    const votes = new Uint8Array(gridSize * gridSize);
    let cellsSampled = 0, cellsAccepted = 0;
    for (let c = 0; c < votes.length; c++) {
        const yes = yesViews[c].size, no = noViews[c].size;
        if (!yes && !no) continue;
        cellsSampled++;
        if (yes >= minAgreeingViews && yes > no) {
            votes[c] = Math.round(Math.min(1, yes / (yes + no)) * 255);
            cellsAccepted++;
        }
    }

    // connected-component regions of accepted cells (4-neighbour flood fill), reported for the summary, not for the mask itself
    const seen = new Uint8Array(votes.length);
    const regions: SpecularRegion[] = [];
    for (let start = 0; start < votes.length; start++) {
        if (!votes[start] || seen[start]) continue;
        const stack = [start];
        let minX = gridSize, minY = gridSize, maxX = -1, maxY = -1, cells = 0, confSum = 0, viewsUnion = new Set<number>();
        while (stack.length) {
            const c = stack.pop()!;
            if (seen[c] || !votes[c]) continue;
            seen[c] = 1;
            const x = c % gridSize, y = Math.floor(c / gridSize);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            cells++; confSum += votes[c] / 255;
            for (const v of yesViews[c]) viewsUnion.add(v);
            if (x > 0) stack.push(c - 1);
            if (x < gridSize - 1) stack.push(c + 1);
            if (y > 0) stack.push(c - gridSize);
            if (y < gridSize - 1) stack.push(c + gridSize);
        }
        regions.push({ bounds: [minX, minY, maxX + 1, maxY + 1], cells, confidence: confSum / cells, agreeingViews: viewsUnion.size });
    }
    regions.sort((a, b) => b.cells - a.cells);

    return { gridSize, uvMin: [uMin, vMin], uvMax: [uMin + uSpan, vMin + vSpan], votes, cellsSampled, cellsAccepted, regions };
}
