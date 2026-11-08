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
 * a metal read is settled against the other classes' first (settleFinishes: a class of the colour the building mostly
 * reads dielectric is that material in shade, never drawn metal);
 * and the set's grain is drawn only as far as the pick by appearance confirmed the set (grainFullAtConf) and as far as its
 * tile fits the element its class repeats on (patternFit) and its pattern is borne out by the photo (energyFit).
 * Labelled photo-inferred.
 *
 * The texturing expert (user ask, 2026-11-08: "too many surfaces look reflective"): the read is asked as an experienced
 * PBR texture artist would judge it, told our reference of measured finishes and the artists' rules
 * (common/spatial/pbr-artist-reference.ts), and also gives each row's grain (how much the surface varies at a metre's
 * scale) and coverage (the share of the row's area its material covers). Its numbers are then drawn by those rules
 * (drawnRoughness, drawnMetalness): metalness 0 or 1, never in between (1 only when read metal, confidently, over most of the class: a
 * colour class that mixes mullions with shaded wall is not drawn metal), the read roughness drawn as read (no squaring:
 * that made a read of 0.4 a sheen of 0.32 and a hedged 0.3 metalness a non-physical 0.18), a glass read (under
 * glassBelow) at main's glass setting, and the set's grain at most the read grain.
 */

import type { RegionClass } from './material-regions';
import { ARTIST_FINISH, pbrReferenceLines } from '../../../../common/spatial/pbr-artist-reference';

export const MATERIAL_FINISH_VERSION = 'material-finish/4';

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
     * The drawn finish of a read (the texturing expert, 2026-11-08; superseding 2026-11-05's squaring, r x r / 0.5 below
     * 0.5, which drew a read of 0.4 at a sheen of 0.32 and a hedged 0.3 metalness at a non-physical 0.18): a read under
     * glassBelow is window glass, drawn at minRoughness, main's glass setting (user asks, 2026-11-05: "give glass less
     * roughness", "match glass setting to main"); any other as read. Metalness: drawnMetalness, 0 or 1.
     */
    minRoughness: ARTIST_FINISH.minRoughness,
    glassBelow: 0.2,
    /**
     * Shade twins (user, 2026-11-05: "we are assigning a shine to too many things, this stone work should not have a sheen
     * at all"): a class is a colour cluster, so a wall's shaded parts fall in a darker class with whatever else is that
     * dark (the Empire State Building's shadowed limestone with its aluminium spandrels), and one metal read was drawn on
     * all of it. Classes of one region within shadeChroma of each other (CIELAB a, b distance: lightness left out) are one
     * colour lit differently; a class read metal (metalness at least metalAt) keeps it only when, among those, the share
     * read metal is at least the share read dielectric; else it is the dielectric majority's material in shade.
     */
    shadeChroma: 4, metalAt: 0.5
} as const;

/**
 * Settles the classes' readings against each other (FINISH_READ.shadeChroma): a class confidently read metal whose colour
 * the building's surface mostly reads dielectric takes the finish of its nearest such class in lightness (that material in
 * shade), keeping its own confidence and words, with `shadeOf` naming the class. Readings are returned in class order.
 */
export function settleFinishes(classes: Array<{ meanLab: [number, number, number]; share: number; openings?: boolean }>, finishes: Array<ClassFinish | undefined>, R = FINISH_READ): Array<(ClassFinish & { shadeOf?: number }) | undefined> {
    const sure = (k: number) => !!finishes[k] && finishes[k]!.conf >= R.minConf;
    const metal = (k: number) => finishes[k]!.metalness >= R.metalAt;
    return finishes.map((f, k) => {
        if (!f || !sure(k) || !metal(k)) return f;
        const near = classes.map((_, j) => j).filter(j => sure(j) && !!classes[j].openings === !!classes[k].openings && Math.hypot(classes[j].meanLab[1] - classes[k].meanLab[1], classes[j].meanLab[2] - classes[k].meanLab[2]) <= R.shadeChroma);
        const metalShare = near.filter(metal).reduce((a, j) => a + classes[j].share, 0), others = near.filter(j => !metal(j));
        if (!others.length || metalShare >= others.reduce((a, j) => a + classes[j].share, 0)) return f;
        const twin = others.reduce((a, j) => (Math.abs(classes[j].meanLab[0] - classes[k].meanLab[0]) < Math.abs(classes[a].meanLab[0] - classes[k].meanLab[0]) ? j : a));
        return { ...f, roughness: finishes[twin]!.roughness, metalness: finishes[twin]!.metalness, shadeOf: twin };
    });
}

/** The roughness a read is drawn at (the expert's rule, FINISH_READ.glassBelow): a glass read at main's glass setting, any other as read. */
export function drawnRoughness(read: number, R = FINISH_READ): number {
    return read < R.glassBelow ? R.minRoughness : Math.max(R.minRoughness, read);
}

/**
 * The metalness a reading is drawn at (the artists' rule: 0 or 1, never in between; ARTIST_FINISH): 1 only when it was
 * read metal (at least metalAt) at confidence metalConf or more and covers at least metalCoverage of the class (a coverage
 * not given counts as covering it), else 0.
 */
export function drawnMetalness(f: Pick<ClassFinish, 'metalness' | 'conf' | 'coverage'>, A = ARTIST_FINISH): 0 | 1 {
    return f.metalness >= A.metalAt && f.conf >= A.metalConf && (f.coverage ?? 1) >= A.metalCoverage ? 1 : 0;
}

export interface ClassFinish {
    roughness: number; metalness: number; conf: number; seen?: string;
    /** How much the surface varies at a metre's scale, 0 (glass) to 1 (weathered rubble): the most of a set's grain drawn (the expert's read). */
    grain?: number;
    /** The share of the class's area the read material covers (0..1; the expert's read). */
    coverage?: number;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function finishPrompt(classes: Array<Pick<RegionClass, 'meanLab' | 'share' | 'wall'> & { openings?: boolean }>, ctx: { building?: string; brief?: string } = {}): string {
    return [
        `You are an experienced PBR texture artist setting the materials of a photoreal model of ${ctx.building ?? 'a building'}.`,
        'Each row of this image is one appearance class of its outside: patches of its photographed surfaces where that class covers most of the patch (straightened, de-lit photos).',
        ...classes.map((c, k) => `- row ${k + 1}: ${pct(c.share)} of the facades' texels, lightness ${Math.round(c.meanLab[0])} of 100${c.wall ? ', the lightest (the wall)' : ''}${c.openings ? ', inside the window openings' : ''}`),
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        ...pbrReferenceLines(),
        'For each row, set the finish of the real material it shows as you would in a metal/rough PBR material, within the reference ranges:',
        '- "roughness": 0 a mirror, 1 fully matte;',
        '- "metalness": 0 or 1 only (see the rules);',
        '- "grain": 0..1, how much the surface varies at a metre\'s scale (glass 0, smooth paint 0.2, dressed stone 0.5, rough brick or concrete 0.8);',
        '- "coverage": 0..1, the share of the row\'s patches the material you set covers;',
        '- "conf": 0..100, how sure you are of the material; a row that is no one material (shadow, a mix, reflected sky) gets a low conf;',
        '- "seen": the material in a few words.',
        // a window opening's surface is the pane that closes it: the photo there shows what lies behind or mirrored in it
        ...(classes.some(c => c.openings) ? ['A row marked "inside the window openings" is photographed through or off the pane that closes the opening: set the finish of that pane itself (the glazing, or an opaque infill panel when the patches show one), not of the blinds, rooms, shadows or reflections seen in it.'] : []),
        'Answer with JSON only: {"classes":[{"row":1,"roughness":0.85,"metalness":0,"grain":0.5,"coverage":0.9,"conf":0,"seen":"..."}]}'
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
        const grain = unit(c.grain), coverage = unit(c.coverage);
        out[k] = { roughness, metalness, conf: typeof c.conf === 'number' && Number.isFinite(c.conf) ? Math.max(0, Math.min(100, c.conf)) : 0, ...(typeof c.seen === 'string' && c.seen.trim() ? { seen: c.seen.trim().slice(0, 80) } : {}), ...(grain !== undefined ? { grain } : {}), ...(coverage !== undefined ? { coverage } : {}) };
    }
    return out;
}

/**
 * The finish of a class inside the window openings with no confident reading (user ask, 2026-11-05: window openings glass
 * smooth, as main drew them): what closes a fitted window is a pane, so its prior is a smooth dielectric, drawn as a
 * confident smooth read is (finishMaps), where a class outside the openings falls back to matte (REGION_FINISH). A
 * confident reading (an opaque infill read rough) stands. Labelled generated.
 */
export const OPENING_FINISH = { roughness: 0.08, metalness: 0 } as const;

/** The finish a class is drawn at: its confident reading, else the opening prior inside the openings, else none (the set's own). */
export function drawFinish(f: ClassFinish | undefined, openings: boolean | undefined, R = FINISH_READ): { finish?: ClassFinish; prior: boolean } {
    if (f && f.conf >= R.minConf) return { finish: f, prior: false };
    return openings ? { finish: { ...OPENING_FINISH, conf: R.minConf }, prior: true } : { prior: false };
}

/** What the ranking ranks toward: the reading's roughness and metalness when it is confident enough, else the matte finish. */
export function finishTarget(f: ClassFinish | undefined, matte: { roughness: number; metallic: number }, R = FINISH_READ): { roughness: number; metallic: number } {
    return f && f.conf >= R.minConf ? { roughness: drawnRoughness(f.roughness, R), metallic: drawnMetalness(f) } : { roughness: matte.roughness, metallic: matte.metallic };
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
 * and drawnMetalness) with a confident reading (a set with no metalness takes the read value even); without one the
 * roughness is the set's own and the metalness 0: a set's metal is never drawn on a reading's say-so alone (nothing is
 * drawn metal unless read as metal, user decision 2026-10-28; the Seagram's bronze classes came out at 0.8 from
 * MetalPlates sets their reads never called metal). The tangent-space normal is
 * tilted toward flat by `grain` and, with a confident reading, by the square of the read roughness over reliefFullAt. Occlusion (red)
 * keeps its mean. The occlusion, roughness and metalness variation is drawn as far as the relief is (`relief`): a surface
 * read smooth is drawn even as well as flat. Returns new images (the inputs when nothing changes).
 */
export function finishMaps(orm: { width: number; height: number; rgba: Uint8Array }, normal: { width: number; height: number; rgba: Uint8Array }, f: ClassFinish | undefined, grain = 1, R = FINISH_READ): { orm: typeof orm; normal: typeof normal; drawn?: DrawnFinish } {
    const sure = !!f && f.conf >= R.minConf;
    const n = orm.width * orm.height;
    let g = 0, b = 0;
    for (let k = 0; k < n; k++) { g += orm.rgba[k * 4 + 1]; b += orm.rgba[k * 4 + 2]; }
    const gMean = g / n / 255, bMean = b / n / 255;
    if (!sure && grain >= 1 && bMean === 0) return { orm, normal };
    const rTo = sure ? drawnRoughness(f!.roughness, R) : gMean, mTo = sure ? drawnMetalness(f!) : 0;
    // the expert's grain: the set's variation drawn at most as far as the read surface varies
    if (sure && f!.grain !== undefined) grain = Math.min(grain, f!.grain);
    const o = orm.rgba.slice(), clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    // how much of the set's own pattern is drawn: the grain, and with a confident reading the square of the read roughness
    // over reliefFullAt, on every map alike: a surface read smooth is drawn even as well as flat (the road markings in a
    // smooth library set's roughness and occlusion maps showed in the Empire State Building's glass reflections)
    const relief = Math.max(0, Math.min(1, grain * (sure ? Math.min(1, (f!.roughness / R.reliefFullAt) ** 2) : 1))), nn = normal.rgba.slice();
    let a = 0;
    for (let k = 0; k < n; k++) a += orm.rgba[k * 4];
    const aMean = a / n / 255;
    // the deviation scaled with the mean (a set's grain is proportional to its level), then by the pattern to draw
    const remap = (v: number, mean: number, to: number) => (mean > 0 ? (to + relief * (v / 255 - mean) * (to / mean)) * 255 : to * 255);
    for (let k = 0; k < n; k++) {
        o[k * 4] = clamp8(remap(orm.rgba[k * 4], aMean, aMean));
        o[k * 4 + 1] = clamp8(remap(orm.rgba[k * 4 + 1], gMean, rTo));
        o[k * 4 + 2] = clamp8(remap(orm.rgba[k * 4 + 2], bMean, mTo));
    }
    for (let k = 0; k < normal.width * normal.height; k++) {
        const x = (normal.rgba[k * 4] / 255) * 2 - 1, y = (normal.rgba[k * 4 + 1] / 255) * 2 - 1, z = (normal.rgba[k * 4 + 2] / 255) * 2 - 1;
        const tx = x * relief, ty = y * relief, tz = z * relief + (1 - relief), l = Math.hypot(tx, ty, tz) || 1;
        nn[k * 4] = clamp8((tx / l * 0.5 + 0.5) * 255); nn[k * 4 + 1] = clamp8((ty / l * 0.5 + 0.5) * 255); nn[k * 4 + 2] = clamp8((tz / l * 0.5 + 0.5) * 255);
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { orm: { ...orm, rgba: o }, normal: { ...normal, rgba: nn }, drawn: { roughness: r2(rTo), metallic: r2(mTo), relief: r2(relief), grain: r2(grain) } };
}
