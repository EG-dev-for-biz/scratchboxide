/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Each appearance class's finish read by the vision model from the classes' swatch sheet (the same sheet the namer reads,
 * material-naming.ts), before the library sets are ranked (material-sets.ts): its roughness (0 mirror, 1 matte), its
 * metalness (0 a dielectric: stone, brick, concrete, render, paint, glass; 1 bare, anodized or coated metal) and the
 * model's confidence. Numbers, not names: the ranking reads the numbers, never words (AGENTS.md section 1).
 *
 * The ranking ranks toward a reading's roughness and metalness when it is at least FINISH_READ.minConf confident, else
 * toward the matte dielectric finish (REGION_FINISH). Every class takes the set the ranking and the pick by appearance
 * choose, drawn with all of its maps (user decision, 2026-11-05: one material path for every surface; no plain finish, no
 * metal gate, no glass layer); a confident reading also sets the finish those maps are drawn at (finishMaps): the set's
 * roughness and metalness scaled to the read values, its grain kept, and its normal relief by the square of the read
 * roughness (reliefFullAt), so a surface read smooth and reflective (window glass) is drawn smooth and nearly flat (user, 2026-11-05);
 * and the set's grain is drawn only as far as the pick by appearance confirmed the set (grainFullAtConf) and as far as its
 * tile fits the element its class repeats on (patternFit) and its pattern is borne out by the photo (energyFit).
 * Labelled photo-inferred.
 */

import type { RegionClass } from './material-regions';

export const MATERIAL_FINISH_VERSION = 'material-finish/2';

export const FINISH_READ = {
    /** A reading's roughness and metalness rank the class's sets, and set its drawn finish, at this confidence (0..100) and above. */
    minConf: 50,
    /**
     * The set's normal relief drawn in full at this read roughness and above, and by the square of the read roughness over
     * it below: a surface read smooth (window glass about 0.05-0.15, under 10%; polished stone 0.3, 36%) is drawn nearly
     * flat, whatever grain its set has.
     */
    reliefFullAt: 0.5,
    /**
     * The set's grain (its roughness and metalness variation and its normal relief) drawn in full when the pick by
     * appearance confirmed the set at this confidence (0..100) and above, in proportion below it, and not at all when it
     * confirmed none: a set chosen by numbers alone is often another kind of surface (a fence's pattern on Penn 2's
     * spandrels), so only its finish is drawn, not its pattern. With no pick by appearance in the build, in full.
     */
    grainFullAtConf: 70,
    /**
     * The drawn finish of a read (user asks, 2026-11-05: "give glass less roughness", "match glass setting to main"):
     * below smoothBelow a read roughness r is drawn as r x r / smoothBelow, never under minRoughness, and a read metalness
     * m below it as m x m / smoothBelow; at smoothBelow and above as read. So a surface read smooth and dielectric is drawn
     * as main drew window glass (roughness 0.05 under the viewer's 0.08 floor, flat, no metalness): glass read 0.2 or
     * smoother drawn 0.08, its hedged 0.1-0.2 metalness drawn 0.02-0.08; polished stone read 0.3 drawn 0.18; a matte or
     * metal read (0.5 and up) as read. One curve for every class.
     */
    smoothBelow: 0.5, minRoughness: 0.08
} as const;

/** The roughness a read is drawn at (FINISH_READ.smoothBelow): smooth reads drawn smoother, matte ones as read. */
export function drawnRoughness(read: number, R = FINISH_READ): number {
    return Math.max(R.minRoughness, read < R.smoothBelow ? (read * read) / R.smoothBelow : read);
}

/** The metalness a read is drawn at (FINISH_READ.smoothBelow): a low read drawn lower still, a metal read as read. */
export function drawnMetalness(read: number, R = FINISH_READ): number {
    return read < R.smoothBelow ? (read * read) / R.smoothBelow : read;
}

export interface ClassFinish { roughness: number; metalness: number; conf: number; seen?: string }

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function finishPrompt(classes: Array<Pick<RegionClass, 'meanLab' | 'share' | 'wall'> & { openings?: boolean }>, ctx: { building?: string; brief?: string } = {}): string {
    return [
        `Each row of this image is one appearance class of the outside of ${ctx.building ?? 'a building'}: patches of its photographed surfaces where that class covers most of the patch (straightened, de-lit photos).`,
        ...classes.map((c, k) => `- row ${k + 1}: ${pct(c.share)} of the facades' texels, lightness ${Math.round(c.meanLab[0])} of 100${c.wall ? ', the lightest (the wall)' : ''}${c.openings ? ', inside the window openings' : ''}`),
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        'For each row, estimate the surface finish of the real material it shows, as a facade expert would from the patches:',
        '- "roughness": 0 a mirror, 1 fully matte (polished stone about 0.3, glass 0.05, painted metal panel 0.4, concrete or brick about 0.85);',
        '- "metalness": 0 a dielectric (stone, brick, concrete, render, paint over masonry, glass), 1 bare, anodized or coated metal panels or mullions;',
        '- "conf": 0..100, how sure you are of the material; a row that is no one material (shadow, a mix, reflected sky) gets a low conf;',
        '- "seen": the material in a few words.',
        'A dark colour alone is not metal: only say metal when the patches show it (sheen, panel joints, mullion profiles).',
        'Answer with JSON only: {"classes":[{"row":1,"roughness":0.8,"metalness":0,"conf":0,"seen":"..."}]}'
    ].join('\n');
}

/** The reply: one finish per row, in row order (a row left out gets none). Throws on anything malformed. */
export function parseClassFinish(text: string, rows = 0): Array<ClassFinish | undefined> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j?.classes)) throw new Error('the reply has no "classes" list');
    const out: Array<ClassFinish | undefined> = new Array(rows).fill(undefined);
    const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined);
    for (const c of j.classes) {
        if (typeof c?.row !== 'number') throw new Error('a class without a "row"');
        const k = Math.round(c.row) - 1, roughness = unit(c.roughness), metalness = unit(c.metalness);
        if (k < 0 || (rows && k >= rows) || roughness === undefined || metalness === undefined) continue;
        out[k] = { roughness, metalness, conf: typeof c.conf === 'number' && Number.isFinite(c.conf) ? Math.max(0, Math.min(100, c.conf)) : 0, ...(typeof c.seen === 'string' && c.seen.trim() ? { seen: c.seen.trim().slice(0, 80) } : {}) };
    }
    return out;
}

/** What the ranking ranks toward: the reading's roughness and metalness when it is confident enough, else the matte finish. */
export function finishTarget(f: ClassFinish | undefined, matte: { roughness: number; metallic: number }, R = FINISH_READ): { roughness: number; metallic: number } {
    return f && f.conf >= R.minConf ? { roughness: f.roughness, metallic: f.metalness } : { roughness: matte.roughness, metallic: matte.metallic };
}

/** What finishMaps drew: the mean roughness and metalness, the share of the set's normal relief kept, and of its grain. */
export interface DrawnFinish { roughness: number; metallic: number; relief: number; grain: number }

/**
 * How far a set's own pattern fits the element its class repeats on (RegionClass.repeatM, metres; the set's tile its real
 * size): in full when one tile fits within the element's shorter side, else in proportion (a 2 m fence tile on a 1 m
 * spandrel repeats out of step with it: half its grain). 1 for a class that holds no repeated element.
 */
export function patternFit(repeatM: number | undefined, tileM: [number, number]): number {
    if (!(repeatM && repeatM > 0)) return 1;
    return Math.max(0, Math.min(1, repeatM / Math.max(tileM[0], tileM[1])));
}

/**
 * How far a set's own pattern is borne out by the photos (RegionClass.photoTexture against the set's texture energy at the
 * class's texel, material-harvest.ts): the square root of the class's energy over the set's on the bands both resolve,
 * capped at 1, so a set is never drawn with more grain than the photo shows (a fence's pattern on a plain panel). 1 when
 * either is unmeasured.
 */
export function energyFit(photo: number[] | undefined, set: number[] | undefined): number {
    if (!photo || !set) return 1;
    let p = 0, s = 0;
    for (let b = 0; b < Math.min(photo.length, set.length); b++) if (Number.isFinite(photo[b]) && Number.isFinite(set[b])) { p += photo[b]; s += set[b]; }
    return s > 0 ? Math.max(0, Math.min(1, Math.sqrt(p / s))) : 1;
}

/** The share of a set's grain to draw from the pick by appearance (FINISH_READ.grainFullAtConf): undefined pick = no chooser. */
export function grainOf(pick: { by: 'appearance' | 'ranking'; conf?: number } | undefined, R = FINISH_READ): number {
    if (!pick) return 1;
    return pick.by === 'appearance' ? Math.max(0, Math.min(1, (pick.conf ?? R.grainFullAtConf) / R.grainFullAtConf)) : 0;
}

/**
 * A class's set maps drawn at its read finish and grain (see the file comment). Each texel's roughness (ORM green) and
 * metalness (blue) is its mean plus `grain` of its deviation from it, the mean being the read value (through drawnRoughness
 * and drawnMetalness) with a confident
 * reading (a set with no metalness takes the read value even) and the set's own without; the tangent-space normal is
 * tilted toward flat by `grain` and, with a confident reading, by the square of the read roughness over reliefFullAt. Occlusion (red)
 * is kept. Returns new images (the inputs when nothing changes).
 */
export function finishMaps(orm: { width: number; height: number; rgba: Uint8Array }, normal: { width: number; height: number; rgba: Uint8Array }, f: ClassFinish | undefined, grain = 1, R = FINISH_READ): { orm: typeof orm; normal: typeof normal; drawn?: DrawnFinish } {
    const sure = !!f && f.conf >= R.minConf;
    if (!sure && grain >= 1) return { orm, normal };
    const n = orm.width * orm.height;
    let g = 0, b = 0;
    for (let k = 0; k < n; k++) { g += orm.rgba[k * 4 + 1]; b += orm.rgba[k * 4 + 2]; }
    const gMean = g / n / 255, bMean = b / n / 255;
    const rTo = sure ? drawnRoughness(f!.roughness, R) : gMean, mTo = sure ? drawnMetalness(f!.metalness, R) : bMean;
    const o = orm.rgba.slice(), clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    // the deviation scaled with the mean (a set's grain is proportional to its level), then by the grain to draw
    const remap = (v: number, mean: number, to: number) => (mean > 0 ? (to + grain * (v / 255 - mean) * (to / mean)) * 255 : to * 255);
    for (let k = 0; k < n; k++) {
        o[k * 4 + 1] = clamp8(remap(orm.rgba[k * 4 + 1], gMean, rTo));
        o[k * 4 + 2] = clamp8(remap(orm.rgba[k * 4 + 2], bMean, mTo));
    }
    const relief = Math.max(0, Math.min(1, grain * (sure ? Math.min(1, (f!.roughness / R.reliefFullAt) ** 2) : 1))), nn = normal.rgba.slice();
    for (let k = 0; k < normal.width * normal.height; k++) {
        const x = (normal.rgba[k * 4] / 255) * 2 - 1, y = (normal.rgba[k * 4 + 1] / 255) * 2 - 1, z = (normal.rgba[k * 4 + 2] / 255) * 2 - 1;
        const tx = x * relief, ty = y * relief, tz = z * relief + (1 - relief), l = Math.hypot(tx, ty, tz) || 1;
        nn[k * 4] = clamp8((tx / l * 0.5 + 0.5) * 255); nn[k * 4 + 1] = clamp8((ty / l * 0.5 + 0.5) * 255); nn[k * 4 + 2] = clamp8((tz / l * 0.5 + 0.5) * 255);
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { orm: { ...orm, rgba: o }, normal: { ...normal, rgba: nn }, drawn: { roughness: r2(rTo), metallic: r2(mTo), relief: r2(relief), grain: r2(grain) } };
}
