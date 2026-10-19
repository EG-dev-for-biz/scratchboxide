/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode: the identity gate of a redrawn wall plate.
 *
 * Round 4 gated plates on edge alignment (symmetric chamfer at most 2.2 px, at most 15 % of the tile's edges lost). The user
 * judged the Nano Banana Lite redraws that gate rejected (chamfer 3.5-4.4 px, 17-35 % lost) the most realistic: they redraw
 * the wall crisply and keep it recognisably the same wall, with windows a few decimetres off the melted tile's. So alignment
 * is now reported, not gated, and a plate is accepted when it is the same wall at the level a person recognises it:
 *
 *   - framing: the answer has the aspect it was asked for (within MAX_ASPECT_DRIFT), and the corrective warp (enhance.ts
 *     alignPlate) brought it within the gross bound below;
 *   - storeys and bays: counted by the vision model on the tile ortho and on the plate with the same prompt (countPrompt),
 *     agreeing within COUNT_TOLERANCE of the tile's count, and always within one. The melted tile's storeys rarely repeat
 *     cleanly enough for an autocorrelation count (Puck's, normalised 0.1-0.2), so the counts are read, not measured; a
 *     wall whose counts could not be read says so and is not held to them;
 *   - colour: the wall's median CIELAB colour within MAX_WALL_COLOUR_DE (CIEDE2000) of the tile's (one colour family);
 *   - a loose gross-failure bound on the reported alignment (GROSS_MAX_CHAMFER_PX, GROSS_MAX_LOST_SHARE), chosen from the
 *     round-4 and round-5 plates (docs/processes/staged_location_pipeline_e.md, round 5) so that the redraws the user chose
 *     pass and a broken answer does not.
 *
 * The region-level identity audit (plate-audit.ts: replaced, erased or retoned distinct elements revert regionally) runs
 * after this gate, tolerant of the same drift.
 */

import { ciede2000 } from '../../../spatial/StreetViewStage3Metrics';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import { labPlanes } from './plate-audit';

/** The answer's aspect may differ from the one asked for by at most this share. */
export const MAX_ASPECT_DRIFT = 0.03;
/**
 * Gross-failure bound on the symmetric edge chamfer after the corrective warp, pixels (the plates are 0.05 m per pixel):
 * the plates the user chose measured 3.5 and 4.4 px, every Lite and full redraw of rounds 4 and 5 1.05-4.96 px. Chamfer
 * saturates (each pixel counts at most 8 px), so it only catches garbage: an answer with no wall structure at all.
 */
export const GROSS_MAX_CHAMFER_PX = 6;
/** Gross-failure bound on the share of the tile's edges with no plate edge within LOST_EDGE_M (chosen plates 0.165 and 0.348; all redraws at most 0.49). */
export const GROSS_MAX_LOST_SHARE = 0.6;
/** Storey and bay counts agree within this share of the tile's count (and always within one). */
export const COUNT_TOLERANCE = 0.15;
/**
 * The wall's median colour may move at most this far (CIEDE2000) from the tile's: the same colour family. A redraw lit
 * evenly, or guided by a Street View photo, moves it (rounds 4-5: up to 18); red brick redrawn as pale stone moves it 30+.
 */
export const MAX_WALL_COLOUR_DE = 22;

export interface FacadeCounts { storeys: number; bays: number; conf: number }
/** Reads a wall image's storey and bay counts (the vision model in a build; a stub in tests). */
export type FacadeCounter = (png: Uint8Array, widthM: number, heightM: number) => Promise<FacadeCounts>;

export function countPrompt(widthM: number, heightM: number): string {
    return [
        `This image is a straight-on (orthographic) texture of one exterior wall of a building, ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall; up is up. Uniform grey areas are not covered.`,
        'Count two things on the wall as drawn:',
        '- "storeys": the floors of the wall from the ground to the top of the wall (a tall ground floor counts once; a roof, parapet or cornice is not a storey);',
        '- "bays": the vertical columns of windows or openings across the whole width, counted at the most typical upper storey (an opening holding a group of windows between two piers counts once).',
        'Reply with JSON only: {"storeys": <integer>, "bays": <integer>, "conf": <0-100>}.'
    ].join('\n');
}

export function parseCountReply(text: string): FacadeCounts {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in the count reply: ${text.slice(0, 120)}`);
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : NaN);
    const out = { storeys: n(j.storeys), bays: n(j.bays), conf: typeof j.conf === 'number' ? j.conf : 50 };
    if (!Number.isFinite(out.storeys) || !Number.isFinite(out.bays)) throw new Error(`the count reply has no storeys or bays: ${m[0].slice(0, 120)}`);
    return out;
}

/** The production counter: one vision call through the chain (temperature 0), remembered when it parsed. */
export function visionFacadeCounter(chain: VisionModelChain<string>): FacadeCounter {
    return async (png, widthM, heightM) => {
        const r = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } }, { text: countPrompt(widthM, heightM) }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'grammar' });
        const text = r.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
        const value = parseCountReply(text);
        r.remember();
        return value;
    };
}

export interface CountCheck {
    axis: 'storeys' | 'bays' | (string & {});
    tile?: number;
    plate?: number;
    /** Whether both counts were read; when not, the check is not applied (and says so). */
    measured: boolean;
    passed: boolean;
    why: string;
}

export function countCheck(axis: string, tile: number | undefined, plate: number | undefined, unread?: string): CountCheck {
    if (tile === undefined || plate === undefined || !(tile > 0)) return { axis, ...(tile !== undefined ? { tile } : {}), ...(plate !== undefined ? { plate } : {}), measured: false, passed: true, why: `${axis}: not counted (${unread ?? 'no count'})` };
    const tol = Math.max(1, Math.round(COUNT_TOLERANCE * tile));
    const passed = Math.abs(plate - tile) <= tol;
    return { axis, tile, plate, measured: true, passed, why: `${axis}: ${tile} on the tile, ${plate} on the plate (within ${tol}${passed ? '' : ': not the same wall'})` };
}

/** The median CIELAB colour of an image over the `use` pixels. */
export function medianLab(rgba: Uint8Array, W: number, H: number, use: Uint8Array): [number, number, number] {
    const [L, A, B] = labPlanes(rgba, W * H);
    const pick = (p: Float32Array) => { const v: number[] = []; const step = Math.max(1, Math.floor(p.length / 40000)); for (let i = 0; i < p.length; i += step) if (use[i]) v.push(p[i]); v.sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };
    return [pick(L), pick(A), pick(B)];
}

export interface IdentityGate {
    passed: boolean;
    why: string;
    aspect: { asked: number; answered: number; drift: number; passed: boolean };
    gross: { chamferPx: number; lostShare: number; passed: boolean };
    storeys: CountCheck;
    bays: CountCheck;
    colour: { tileLab: [number, number, number]; plateLab: [number, number, number]; de: number; passed: boolean };
}

/**
 * The identity gate of an aligned plate against its input (both W x H RGBA8, `use` the covered texels). `askedAspect` and
 * `answeredAspect` are width / height of the image sent and of the answer; chamfer and lost are alignPlate's; `counts` the
 * vision model's storey and bay counts of the tile and of the plate (either may be missing, with why).
 */
export function identityGate(input: Uint8Array, aligned: Uint8Array, W: number, H: number, use: Uint8Array, a: {
    askedAspect: number; answeredAspect: number; chamferPx: number; lostShare: number;
    counts?: { tile?: FacadeCounts; plate?: FacadeCounts; unread?: string };
}): IdentityGate {
    const drift = Math.abs(a.answeredAspect / a.askedAspect - 1);
    const aspect = { asked: Math.round(a.askedAspect * 1000) / 1000, answered: Math.round(a.answeredAspect * 1000) / 1000, drift: Math.round(drift * 1000) / 1000, passed: drift <= MAX_ASPECT_DRIFT };
    const gross = { chamferPx: a.chamferPx, lostShare: a.lostShare, passed: a.chamferPx <= GROSS_MAX_CHAMFER_PX && a.lostShare <= GROSS_MAX_LOST_SHARE };
    const c = a.counts;
    const storeys = countCheck('storeys', c?.tile?.storeys, c?.plate?.storeys, c?.unread);
    const bays = countCheck('bays', c?.tile?.bays, c?.plate?.bays, c?.unread);
    const tileLab = medianLab(input, W, H, use), plateLab = medianLab(aligned, W, H, use);
    const de = Math.round(ciede2000(tileLab, plateLab) * 10) / 10;
    const colour = { tileLab: tileLab.map(v => Math.round(v * 10) / 10) as [number, number, number], plateLab: plateLab.map(v => Math.round(v * 10) / 10) as [number, number, number], de, passed: de <= MAX_WALL_COLOUR_DE };
    const passed = aspect.passed && gross.passed && storeys.passed && bays.passed && colour.passed;
    const parts = [
        `aspect ${aspect.answered} for ${aspect.asked}${aspect.passed ? '' : ` (more than ${100 * MAX_ASPECT_DRIFT}% off: reframed)`}`,
        `edge chamfer ${a.chamferPx.toFixed(2)} px, ${(100 * a.lostShare).toFixed(0)}% of the tile's edges lost (reported; gross failure above ${GROSS_MAX_CHAMFER_PX} px or ${100 * GROSS_MAX_LOST_SHARE}%${gross.passed ? '' : ': a broken answer'})`,
        storeys.why, bays.why,
        `wall colour ${de.toFixed(1)} dE00 from the tile's${colour.passed ? '' : ` (more than ${MAX_WALL_COLOUR_DE}: another colour family)`}`
    ];
    return { passed, why: parts.join('; '), aspect, gross, storeys, bays, colour };
}
