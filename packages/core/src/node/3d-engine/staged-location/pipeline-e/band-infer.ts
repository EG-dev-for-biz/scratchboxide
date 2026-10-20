/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (b): horizontal bands (anything that runs along a wall and stands proud of it over a range of
 * heights: cornices, string courses, plinths, a parapet's coping) read from a side-on render of the scan cut through the
 * wall, and kept only where the scan's own cross-section agrees.
 *
 * The native tool renders, per large wall, the scanned surface within half a metre of three cuts across it (a quarter, half
 * and three quarters along), seen side-on: x is the distance out from the wall plane, y the height. It also records the
 * profile behind the picture: per row, the outermost surface of each cut. The vision model reads the picture as bands
 * ([top, bottom] and how far each stands out); each band is checked against the profile (median over the three cuts): it
 * must stand at least MIN_BAND_DEPTH_M and half the read depth out from the wall's own line, and more than the rows just
 * above and below it. It is built at the measured height range and depth, as a profile swept along the wall and, mitred,
 * along the neighbouring walls of the same plan that show it too.
 */

import type { MassingSection } from './native-massing';

export const MIN_BAND_DEPTH_M = 0.1;
export const MAX_BAND_DEPTH_M = 1.5;
export const BAND_CONTRAST_M = 0.05;

export interface BandReading { bands: Array<{ y: [number, number]; depthM: number; label?: string }>; conf: number }

export function bandPrompt(sec: Pick<MassingSection, 'hMin' | 'hMax' | 'tTop' | 'tBottom'>): string {
    return [
        `This is a side-on cut through a building wall from a photogrammetric scan: the wall's face is the thin red vertical line; the building is to its left and the street to its right. Each pixel row is a height (top of the image ${(sec.tTop - sec.tBottom).toFixed(1)} m above the bottom); the horizontal axis runs from ${(-sec.hMin).toFixed(1)} m inside the wall to ${sec.hMax.toFixed(1)} m out from it. The coloured area is the scanned surface seen edge-on.`,
        'Find the horizontal bands that stand out from the wall face to the right of the red line over a range of heights (a cornice at the top, string courses between storeys, a plinth at the bottom, a parapet coping): ignore single bumps.',
        'For each band give "y": [top, bottom] in per-mille of the image height (0 = top) and "depthM": how far it stands out from the red line in metres. Give "conf" 0..100.',
        'Answer with JSON only: {"bands":[{"y":[t,b],"depthM":0.5,"label":"..."}],"conf":0}'
    ].join('\n');
}

export function parseBandReply(text: string): BandReading {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    const bands: BandReading['bands'] = [];
    for (const e of Array.isArray(j?.bands) ? j.bands : []) {
        if (!Array.isArray(e?.y) || e.y.length !== 2 || !e.y.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) continue;
        const y0 = Math.max(0, Math.min(1000, Math.min(e.y[0], e.y[1]))), y1 = Math.max(0, Math.min(1000, Math.max(e.y[0], e.y[1])));
        const d = typeof e.depthM === 'number' && Number.isFinite(e.depthM) ? e.depthM : 0;
        if (y1 > y0 && d > 0) bands.push({ y: [y0, y1], depthM: Math.min(3, d), ...(typeof e.label === 'string' ? { label: e.label.slice(0, 40) } : {}) });
    }
    return { bands, conf: typeof j?.conf === 'number' && Number.isFinite(j.conf) ? Math.max(0, Math.min(100, j.conf)) : 50 };
}

const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/** The section's profile: per row, the median over the cuts of the outermost surface (NaN where fewer than two cuts saw it). */
export function sectionProfile(sec: MassingSection): Float32Array {
    const out = new Float32Array(sec.height).fill(NaN);
    for (let r = 0; r < sec.height; r++) {
        const v = sec.profiles.map(p => p[r]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
        if (v.length >= 2) out[r] = median(v);
    }
    return out;
}

export interface BandDecision { y0: number; y1: number; readDepthM: number; accepted: boolean; why: string; depthM?: number; t0?: number; t1?: number }

/** Checks each read band against the profile; heights returned in the wall's t (absolute y for walls). */
export function decideBands(sec: MassingSection, reading: BandReading): BandDecision[] {
    const prof = sectionProfile(sec);
    const wall = median(Array.from(prof).filter(Number.isFinite));  // the wall's own line (most rows)
    const rowT = (r: number) => sec.tTop - (r + 0.5) * sec.pixel;
    return reading.bands.map(b => {
        const r0 = Math.max(0, Math.floor((b.y[0] / 1000) * sec.height)), r1 = Math.min(sec.height, Math.ceil((b.y[1] / 1000) * sec.height));
        const inside = Array.from(prof.subarray(r0, r1)).filter(Number.isFinite);
        const margin = Math.max(4, Math.round(0.5 / sec.pixel));
        const outside = [...Array.from(prof.subarray(Math.max(0, r0 - 2 * margin), Math.max(0, r0 - margin))), ...Array.from(prof.subarray(Math.min(sec.height, r1 + margin), Math.min(sec.height, r1 + 2 * margin)))].filter(Number.isFinite);
        const base = { y0: b.y[0], y1: b.y[1], readDepthM: b.depthM };
        if (inside.length < 3 || !Number.isFinite(wall)) return { ...base, accepted: false, why: 'the scan does not cover the band' };
        const out = median(inside) - wall, around = outside.length ? median(outside) - wall : 0;
        const ok = out >= MIN_BAND_DEPTH_M && out >= 0.5 * b.depthM && out - around >= BAND_CONTRAST_M && out <= MAX_BAND_DEPTH_M;
        const why = `the scan's cut stands ${out.toFixed(2)} m out over the band (read ${b.depthM.toFixed(2)} m), ${around.toFixed(2)} m just above and below`;
        if (!ok) return { ...base, accepted: false, why };
        // the band's measured extent: rows around the read range standing at least half its depth out
        let ra = r0, rb = r1;
        while (ra > 0 && Number.isFinite(prof[ra - 1]) && prof[ra - 1] - wall >= 0.5 * out && r0 - ra < margin) ra--;
        while (rb < sec.height && Number.isFinite(prof[rb]) && prof[rb] - wall >= 0.5 * out && rb - r1 < margin) rb++;
        return { ...base, accepted: true, why, depthM: Math.min(out, 1.5 * b.depthM), t0: rowT(rb - 1) - sec.pixel / 2, t1: rowT(ra) + sec.pixel / 2 };
    });
}

/** The swept profile of a band in (outward offset, height): a sloped underside, a vertical front, a flat top. */
export function bandProfile(t0: number, t1: number, depth: number): Array<[number, number]> {
    const slope = Math.min(0.35 * (t1 - t0), depth);
    return [[0, t0], [depth, t0 + slope], [depth, t1], [0, t1]];
}

/**
 * A parapet's profile: the wall continued up, a coping, the inner face back down. Heights are above the wall's own top
 * (sweep it with `relativeToTop`): a part's `topY` is only a cap over its roof planes, and a parapet drawn at it stood
 * metres above a roof whose planes sit lower (488 Broadway: 34.3 m against a roof at 24-26 m).
 */
export function parapetProfile(height: number, thickness: number): Array<[number, number]> {
    return [[0, 0], [0, height], [-thickness, height], [-thickness, 0]];
}
