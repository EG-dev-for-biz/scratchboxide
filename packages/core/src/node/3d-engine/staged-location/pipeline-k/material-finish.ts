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
 * The ranking uses a reading only as confident as FINISH_READ asks: its roughness at minConf, and metal (the class's sets
 * drawn with their metalness) only at metalConf with metalness at least metalAt. Below that a class keeps the matte
 * dielectric finish (REGION_FINISH), as before the user's decision of 2026-11-04 (a class the model reads as metal panel
 * is drawn as one; the old rule "nothing is drawn metal" stood while no reading could tell a metal from a dark stone).
 * Labelled photo-inferred.
 */

import type { RegionClass } from './material-regions';

export const MATERIAL_FINISH_VERSION = 'material-finish/1';

export const FINISH_READ = {
    /** A reading's roughness ranks the class's sets at this confidence (0..100) and above. */
    minConf: 50,
    /** Metal: the class's sets may be metal, and are drawn with their metalness, at this confidence and metalness. */
    metalConf: 70, metalAt: 0.5
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

/** What the ranking takes from a reading: the roughness to rank toward, the metalness, and whether metal sets may be used. */
export function finishTarget(f: ClassFinish | undefined, matte: { roughness: number; metallic: number }, R = FINISH_READ): { roughness: number; metallic: number; metal: boolean } {
    const metal = !!f && f.conf >= R.metalConf && f.metalness >= R.metalAt;
    return { roughness: f && f.conf >= R.minConf ? f.roughness : matte.roughness, metallic: metal ? f!.metalness : matte.metallic, metal };
}
