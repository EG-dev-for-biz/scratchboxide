/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a district's ground is grass, from two measurements that must agree:
 *   - height: the scan's top surface within `maxAboveGroundM` of the terrain (the ground model), so building roofs,
 *     tree crowns, hedges taller than that and parked cars are never grass;
 *   - appearance: the cell's lit colour (litColour over the top-down tile photo) is vegetation green in CIELAB
 *     (a* well below zero, with chroma), not a grey plaza or a brown path.
 * A majority filter removes speckle, and patches under `minPatchM2` are dropped. Each grass cell carries a confidence
 * from how green it is and how close to the terrain it lies; the mask is photo-inferred (read off photographs), never
 * measured. Known gap: grass under a tree crown is hidden from above and is not found here.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { TopDownFrame, TopDownPhoto } from './top-down-photo';
import { litColour } from './surface-materials';

export const GRASS_DETECT_VERSION = 'grass-detect/1';

export const GRASS_DETECT_PARAMS = {
    /** Highest the top surface may stand above the terrain and still be a lawn (m). */
    maxAboveGroundM: 0.6,
    /** CIELAB a* at or below which a cell reads as green, and where its confidence reaches 1. */
    greenA: -5, fullGreenA: -16,
    /** Lightness range of a lawn texel mean (excludes deep shade and specular glare). */
    minL: 12, maxL: 88,
    /** Least chroma (sqrt(a*^2 + b*^2)) of a green cell. */
    minChroma: 7,
    majorityPasses: 2,
    minPatchM2: 4
};

export interface GrassMask {
    version: string;
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** 1 where the cell is grass. */
    mask: Uint8Array;
    /** 0..1 per grass cell (0 elsewhere). */
    confidence: Float32Array;
    cells: number;
    areaM2: number;
    patches: Array<{ cells: number; areaM2: number; centre: [number, number]; meanConfidence: number }>;
    /** Cells looked at, and why the rest were not grass. */
    stats: { measured: number; tooHigh: number; notGreen: number; noColour: number; speckle: number };
    provenance: { label: 'photo-inferred'; method: string };
}

export function detectGrass(photo: TopDownPhoto, frame: TopDownFrame, ground: GroundModel, P = GRASS_DETECT_PARAMS): GrassMask {
    const { nx, nz, cellMeters: cellM, x0, z0 } = ground;
    const N = nx * nz;
    const raw = new Uint8Array(N), score = new Float32Array(N);
    const stats = { measured: 0, tooHigh: 0, notGreen: 0, noColour: 0, speckle: 0 };
    const per = Math.max(1, Math.round(cellM / photo.texelM));
    const buf = new Uint8Array(per * per * 4);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i;
        const top = ground.top[c], g = ground.ground[c];
        if (!Number.isFinite(top) || !Number.isFinite(g)) continue;
        stats.measured++;
        const above = top - g;
        if (above > P.maxAboveGroundM) { stats.tooHigh++; continue; }
        const cx = x0 + i * cellM, cz = z0 + k * cellM;
        const px0 = Math.floor((cx - frame.x0) / photo.texelM), py0 = Math.floor((cz - frame.z0) / photo.texelM);
        let n = 0;
        for (let y = 0; y < per; y++) for (let x = 0; x < per; x++, n++) {
            const sx = px0 + x, sy = py0 + y;
            if (sx < 0 || sy < 0 || sx >= photo.width || sy >= photo.height) { buf[n * 4 + 3] = 0; continue; }
            const o = (sy * photo.width + sx) * 4;
            buf[n * 4] = photo.rgba[o]; buf[n * 4 + 1] = photo.rgba[o + 1]; buf[n * 4 + 2] = photo.rgba[o + 2];
            buf[n * 4 + 3] = photo.rgba[o + 3];
        }
        const col = litColour(buf, { minTexels: Math.max(4, (per * per) >> 2) });
        if (!col) { stats.noColour++; continue; }
        const [L, a, b] = col.lab;
        if (a > P.greenA || L < P.minL || L > P.maxL || Math.hypot(a, b) < P.minChroma) { stats.notGreen++; continue; }
        raw[c] = 1;
        const green = Math.min(1, (P.greenA - a) / (P.greenA - P.fullGreenA));
        const low = 1 - Math.max(0, above) / P.maxAboveGroundM;
        score[c] = Math.max(0.05, 0.5 * green + 0.5 * Math.min(1, low * 1.5)) * (0.6 + 0.4 * green);
    }
    // majority filter (3 x 3): a cell takes the state most of its neighbourhood has
    let mask = raw;
    for (let pass = 0; pass < P.majorityPasses; pass++) {
        const next = new Uint8Array(N);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            let on = 0, tot = 0;
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                tot++; on += mask[kk * nx + ii];
            }
            next[k * nx + i] = on * 2 > tot ? 1 : 0;
        }
        mask = next;
    }
    // patches: 4-connected; the small ones dropped
    const label = new Int32Array(N).fill(-1);
    const patches: GrassMask['patches'] = [];
    const confidence = new Float32Array(N);
    const minCells = Math.max(1, Math.round(P.minPatchM2 / (cellM * cellM)));
    const stack: number[] = [], members: number[] = [];
    for (let s = 0; s < N; s++) {
        if (!mask[s] || label[s] >= 0) continue;
        members.length = 0; stack.push(s); label[s] = patches.length;
        while (stack.length) {
            const c = stack.pop()!; members.push(c);
            const i = c % nx, k = (c / nx) | 0;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (mask[n] && label[n] < 0) { label[n] = label[s]; stack.push(n); }
            }
        }
        if (members.length < minCells) { for (const c of members) mask[c] = 0; stats.speckle += members.length; label[s] = -2; continue; }
        let sx = 0, sz = 0, sc = 0;
        for (const c of members) {
            const conf = score[c] || 0.3; // a cell the filter filled in from its neighbours: lower confidence
            confidence[c] = conf; sc += conf;
            sx += x0 + ((c % nx) + 0.5) * cellM; sz += z0 + (((c / nx) | 0) + 0.5) * cellM;
        }
        patches.push({ cells: members.length, areaM2: members.length * cellM * cellM, centre: [sx / members.length, sz / members.length], meanConfidence: sc / members.length });
    }
    let cells = 0;
    for (let c = 0; c < N; c++) cells += mask[c];
    patches.sort((p, q) => q.areaM2 - p.areaM2);
    return {
        version: GRASS_DETECT_VERSION, x0, z0, nx, nz, cellM, mask, confidence, cells, areaM2: cells * cellM * cellM, patches, stats,
        provenance: { label: 'photo-inferred', method: `ground-level cells (within ${P.maxAboveGroundM} m of the terrain) whose lit top-down colour is vegetation green (CIELAB a* <= ${P.greenA}), majority-filtered, patches >= ${P.minPatchM2} m2` }
    };
}

/** The top-down photo with the grass mask laid over it (green tint by confidence, outlines bright), RGBA. */
export function grassOverlay(photo: TopDownPhoto, frame: TopDownFrame, g: GrassMask): Uint8Array {
    const out = Uint8Array.from(photo.rgba);
    const at = (x: number, z: number) => {
        const i = Math.floor((x - g.x0) / g.cellM), k = Math.floor((z - g.z0) / g.cellM);
        return i < 0 || k < 0 || i >= g.nx || k >= g.nz ? -1 : k * g.nx + i;
    };
    for (let py = 0; py < photo.height; py++) for (let px = 0; px < photo.width; px++) {
        const x = frame.x0 + (px + 0.5) * photo.texelM, z = frame.z0 + (py + 0.5) * photo.texelM;
        const c = at(x, z);
        const o = (py * photo.width + px) * 4;
        if (c < 0 || !g.mask[c]) { out[o] = out[o] * 0.55; out[o + 1] = out[o + 1] * 0.55; out[o + 2] = out[o + 2] * 0.55; continue; }
        const i = c % g.nx, k = (c / g.nx) | 0;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dk]) => { const ii = i + di, kk = k + dk; return ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz || !g.mask[kk * g.nx + ii]; });
        const t = 0.35 + 0.35 * g.confidence[c];
        if (edge) { out[o] = 255; out[o + 1] = 230; out[o + 2] = 0; continue; }
        out[o] = out[o] * (1 - t); out[o + 1] = out[o + 1] * (1 - t) + 255 * t; out[o + 2] = out[o + 2] * (1 - t) + 60 * t;
    }
    return out;
}
