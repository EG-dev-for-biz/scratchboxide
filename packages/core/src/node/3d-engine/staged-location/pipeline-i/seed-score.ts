/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How well a fitted model agrees with the character sheet it was made from: from each panel's own station camera, the
 * model's filled silhouette against the structure in that panel (everything not near-white), as IoU. A candidate's score
 * is 0.7 x the mean silhouette IoU + 0.3 x its plan IoU with the scan footprint (Puck, 2026-10-24: seeds of one request
 * ranged 0.71-0.79 on this score; the best beat Meshy's 0.75).
 */

import type { ColmapCameraPose } from '../../../../common/spatial/colmap-vector-reference-types';
import { decodePng } from '../../../texture-processing';

export const SILHOUETTE_WEIGHT = 0.7;
const MW = 480, MH = 270;

/** The structure in a panel at mask resolution: pixels not near-white (the sheet's ground). */
export function panelMask(png: Buffer, w = MW, h = MH): Uint8Array {
    const img = decodePng(png), m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / h)) * img.width + Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / w))) * 4;
        m[y * w + x] = Math.abs(img.rgba[i] - 255) + Math.abs(img.rgba[i + 1] - 255) + Math.abs(img.rgba[i + 2] - 255) > 40 ? 1 : 0;
    }
    return m;
}

/** The filled silhouette of triangles (tile frame, flat xyz + indices) from a station camera. */
export function silhouetteMask(positions: ArrayLike<number>, indices: ArrayLike<number>, station: ColmapCameraPose, w = MW, h = MH): Uint8Array {
    const e = station.positionLocalENU, f = station.forwardVector;
    let rx = f[1] * 0 - f[2] * 1, ry = f[2] * 0 - f[0] * 0, rz = f[0] * 1 - f[1] * 0;           // r = f x up
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * f[2] - rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1] - ry * f[0];   // u = r x f
    const t = Math.tan((station.fovDegrees * Math.PI / 180) / 2), th = t * h / w;
    const n = positions.length / 3, px = new Float64Array(n), py = new Float64Array(n), ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const dx = positions[3 * i] - e[0], dy = positions[3 * i + 1] - e[1], dz = positions[3 * i + 2] - e[2];
        const z = dx * f[0] + dy * f[1] + dz * f[2];
        if (z <= 0.5) continue;
        ok[i] = 1;
        px[i] = ((dx * rx + dy * ry + dz * rz) / z / t + 1) * w / 2;
        py[i] = (1 - (dx * ux + dy * uy + dz * uz) / z / th) * h / 2;
    }
    const m = new Uint8Array(w * h);
    for (let k = 0; k < indices.length; k += 3) {
        const a = indices[k], b = indices[k + 1], c = indices[k + 2];
        if (!ok[a] || !ok[b] || !ok[c]) continue;
        const x0 = Math.max(0, Math.floor(Math.min(px[a], px[b], px[c]))), x1 = Math.min(w - 1, Math.ceil(Math.max(px[a], px[b], px[c])));
        const y0 = Math.max(0, Math.floor(Math.min(py[a], py[b], py[c]))), y1 = Math.min(h - 1, Math.ceil(Math.max(py[a], py[b], py[c])));
        const den = (py[b] - py[c]) * (px[a] - px[c]) + (px[c] - px[b]) * (py[a] - py[c]);
        if (x1 < x0 || y1 < y0 || Math.abs(den) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const sx = x + 0.5, sy = y + 0.5;
            const l1 = ((py[b] - py[c]) * (sx - px[c]) + (px[c] - px[b]) * (sy - py[c])) / den, l2 = ((py[c] - py[a]) * (sx - px[c]) + (px[a] - px[c]) * (sy - py[c])) / den;
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) m[y * w + x] = 1;
        }
    }
    return m;
}

export function maskIoU(a: Uint8Array, b: Uint8Array): number {
    let inter = 0, union = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) union++; }
    return union ? inter / union : 0;
}

export interface CandidateScore { silhouetteIoU: number[]; meanSilhouetteIoU: number; planIoU: number; score: number }

export function scoreCandidate(positions: ArrayLike<number>, indices: ArrayLike<number>, stations: ColmapCameraPose[], masks: Uint8Array[], planIoU: number): CandidateScore {
    const s = stations.map((st, i) => maskIoU(silhouetteMask(positions, indices, st), masks[i]));
    const mean = s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
    return { silhouetteIoU: s, meanSilhouetteIoU: mean, planIoU, score: SILHOUETTE_WEIGHT * mean + (1 - SILHOUETTE_WEIGHT) * planIoU };
}
