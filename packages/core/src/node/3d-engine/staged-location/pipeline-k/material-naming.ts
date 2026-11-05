/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building's materials, saved with it (user ask, 2026-10-30): its appearance classes (material-regions.ts), each named
 * in words by a vision model that sees patches of it (classSwatchSheet) and is told the building, its brief and what the
 * facade reader saw between the windows, with its colour, the library set chosen for it and where each of those came
 * from. Written into the twin's GLB as `asset.extras.sbMaterialClasses`, so the building
 * carries its own material map wherever it goes.
 *
 * The words are labels (open vocabulary): nothing in the build branches on them. Provenance: the colour and the words are
 * photo-inferred (read from the photos), the library set generated (chosen to look like it).
 */

import type { FacadeReadRecord } from './facade-reader';
import type { RegionClass } from './material-regions';

export const MATERIAL_NAMING_VERSION = 'material-naming/2';

/** What the namer is told beside the swatches. */
export interface NamingContext { building?: string; brief?: string; between?: string[] }

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function namingPrompt(classes: Array<Pick<RegionClass, 'meanLab' | 'share' | 'wall'>>, ctx: NamingContext = {}): string {
    return [
        `Each row of this image is one appearance class of the outside of ${ctx.building ?? 'a building'}: patches of its photographed surfaces where that class covers most of the patch (straightened, de-lit photos).`,
        ...classes.map((c, k) => `- row ${k + 1}: ${pct(c.share)} of the facades' texels, lightness ${Math.round(c.meanLab[0])} of 100${c.wall ? ', the lightest (the wall)' : ''}`),
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        ...(ctx.between?.length ? [`Between its windows a reader saw: ${ctx.between.join('; ')}.`] : []),
        'Name the material each row shows, in a few words, as a facade expert would (what it is and its finish), from the patches first and the description second. A row that is no one material (shadow, a mix, sky reflected) says so.',
        'Give for each row "row", "words" and "conf" (0..100). Answer with JSON only: {"classes":[{"row":1,"words":"...","conf":0}]}'
    ].join('\n');
}

export interface ClassWords { words: string; conf: number }

/** The namer's reply: one entry per row, in row order (a row it left out gets none). Throws on anything malformed. */
export function parseClassWords(text: string, rows = 0): Array<ClassWords | undefined> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j?.classes)) throw new Error('the reply has no "classes" list');
    const out: Array<ClassWords | undefined> = new Array(rows).fill(undefined);
    for (const c of j.classes) {
        if (typeof c?.row !== 'number' || typeof c.words !== 'string' || !c.words.trim()) throw new Error('a class without a "row" or "words"');
        const k = Math.round(c.row) - 1;
        if (k < 0 || (rows && k >= rows)) continue;
        out[k] = { words: c.words.trim().slice(0, 80), conf: typeof c.conf === 'number' && Number.isFinite(c.conf) ? Math.max(0, Math.min(100, c.conf)) : 50 };
    }
    return out;
}

/** What the reader saw between the windows, its commonest words first (at most `n`). */
export function betweenSeen(records: FacadeReadRecord[], n = 5): string[] {
    const count = new Map<string, number>();
    for (const r of records) for (const z of r.zones ?? []) if (z.outcome === 'drawn' && z.reading?.between) count.set(z.reading.between, (count.get(z.reading.between) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export interface MaterialClassEntry {
    index: number; share: number; wall: boolean;
    colour: { lab: [number, number, number]; srgb: string; label: 'photo-inferred' };
    /** `by`: whether the set was picked by its look (material-choice.ts) or is the ranking's nearest; `seen`: the chooser's words for the class (a label). */
    set: { name: string; distance: number; label: 'generated'; by?: 'appearance' | 'ranking'; seen?: string };
    words?: { text: string; conf: number; label: 'photo-inferred'; source: string };
}

export interface MaterialClassesExtras {
    schema: 'scratchbox.material-classes/1'; version: string;
    classes: MaterialClassEntry[];
    /** Why the classes carry no words, when they do not. */
    unnamed?: string;
}

const hex = (linear: [number, number, number]) => '#' + linear.map(v => { const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, s)) * 255).toString(16).padStart(2, '0'); }).join('');

/** The classes as saved with the building: each with its colour, its library set and (when named) its words. */
export function materialClassesExtras(classes: Array<RegionClass & { set: string; distance: number; choice?: { by: 'appearance' | 'ranking'; seen?: string } }>, words: Array<ClassWords | undefined> | undefined, unnamed?: string): MaterialClassesExtras {
    return {
        schema: 'scratchbox.material-classes/1', version: MATERIAL_NAMING_VERSION,
        classes: classes.map((c, k) => ({
            index: c.index, share: c.share, wall: c.wall,
            colour: { lab: c.meanLab, srgb: hex(c.meanLinear), label: 'photo-inferred' },
            set: { name: c.set, distance: Math.round(c.distance * 1000) / 1000, label: 'generated', ...(c.choice ? { by: c.choice.by, ...(c.choice.seen ? { seen: c.choice.seen } : {}) } : {}) },
            ...(words?.[k] ? { words: { text: words[k]!.words, conf: words[k]!.conf, label: 'photo-inferred', source: 'a vision model naming patches of the class, told the building, its brief and what the facade reader saw' } } : {})
        })),
        ...(unnamed ? { unnamed } : {})
    };
}
