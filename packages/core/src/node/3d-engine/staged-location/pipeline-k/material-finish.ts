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
 * roughness and metalness scaled to the read values, its grain kept, and its normal relief in proportion to the read
 * roughness, so a surface read smooth and reflective (window glass) is drawn smooth and nearly flat (user, 2026-11-05).
 * Labelled photo-inferred.
 */

import type { RegionClass } from './material-regions';

export const MATERIAL_FINISH_VERSION = 'material-finish/2';

export const FINISH_READ = {
    /** A reading's roughness and metalness rank the class's sets, and set its drawn finish, at this confidence (0..100) and above. */
    minConf: 50,
    /**
     * The set's normal relief drawn in full at this read roughness and above, and scaled down in proportion below it: a
     * surface read smooth (window glass about 0.05, polished stone 0.3) is drawn nearly flat, whatever grain its set has.
     */
    reliefFullAt: 0.5
} as const;

export interface ClassFinish { roughness: number; metalness: number; conf: number; seen?: string }

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function finishPrompt(classes: Array<Pick<RegionClass, 'meanLab' | 'share' | 'wall'>>, ctx: { building?: string; brief?: string } = {}): string {
    return [
        `Each row of this image is one appearance class of the outside of ${ctx.building ?? 'a building'}: patches of its photographed surfaces where that class covers most of the patch (straightened, de-lit photos).`,
        ...classes.map((c, k) => `- row ${k + 1}: ${pct(c.share)} of the facades' texels, lightness ${Math.round(c.meanLab[0])} of 100${c.wall ? ', the lightest (the wall)' : ''}`),
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

/** What finishMaps drew: the mean roughness and metalness and the share of the set's normal relief kept. */
export interface DrawnFinish { roughness: number; metallic: number; relief: number }

/**
 * A class's set maps drawn at its read finish (see the file comment): with no confident reading, the set's maps as they
 * are; else each texel's roughness (ORM green) and metalness (blue) scaled so their means are the read values (a set with
 * no metalness takes the read value even), and the tangent-space normal tilted toward flat by the read roughness over
 * reliefFullAt. Occlusion (red) is kept. Returns new images; the inputs are not changed.
 */
export function finishMaps(orm: { width: number; height: number; rgba: Uint8Array }, normal: { width: number; height: number; rgba: Uint8Array }, f: ClassFinish | undefined, R = FINISH_READ): { orm: typeof orm; normal: typeof normal; drawn?: DrawnFinish } {
    if (!f || f.conf < R.minConf) return { orm, normal };
    const n = orm.width * orm.height;
    let g = 0, b = 0;
    for (let k = 0; k < n; k++) { g += orm.rgba[k * 4 + 1]; b += orm.rgba[k * 4 + 2]; }
    const gMean = g / n / 255, bMean = b / n / 255;
    const o = orm.rgba.slice(), clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    for (let k = 0; k < n; k++) {
        o[k * 4 + 1] = clamp8(gMean > 0 ? orm.rgba[k * 4 + 1] * (f.roughness / gMean) : f.roughness * 255);
        o[k * 4 + 2] = clamp8(bMean > 0 ? orm.rgba[k * 4 + 2] * (f.metalness / bMean) : f.metalness * 255);
    }
    const relief = Math.max(0, Math.min(1, f.roughness / R.reliefFullAt)), nn = normal.rgba.slice();
    for (let k = 0; k < normal.width * normal.height; k++) {
        const x = (normal.rgba[k * 4] / 255) * 2 - 1, y = (normal.rgba[k * 4 + 1] / 255) * 2 - 1, z = (normal.rgba[k * 4 + 2] / 255) * 2 - 1;
        const tx = x * relief, ty = y * relief, tz = z * relief + (1 - relief), l = Math.hypot(tx, ty, tz) || 1;
        nn[k * 4] = clamp8((tx / l * 0.5 + 0.5) * 255); nn[k * 4 + 1] = clamp8((ty / l * 0.5 + 0.5) * 255); nn[k * 4 + 2] = clamp8((tz / l * 0.5 + 0.5) * 255);
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { orm: { ...orm, rgba: o }, normal: { ...normal, rgba: nn }, drawn: { roughness: r2(f.roughness), metallic: r2(f.metalness), relief: r2(relief) } };
}
