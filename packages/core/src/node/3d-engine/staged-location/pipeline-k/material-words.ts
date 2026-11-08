/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The library sets named for what a class was seen to be (MAIN's verdict on PR #190, 2026-11-08: the ESB's limestone took
 * trowelled concrete and plaster grains, and the real height made the wrong pick plain). The colour ranking (material-sets.ts)
 * shortlists by colour, finish and tile size, and on a grey limestone that shortlist holds concrete, asphalt and plaster
 * only: no set of the kind the finish read saw ("limestone cladding") ever reaches the pick by appearance. So beside the
 * colour shortlist a text model reads the whole facade-scale pool, every set's id, its publisher's free text and tags and
 * its tile size, and names for each class up to WORD_CANDIDATES sets whose description is the material and finish the
 * class was seen to be (open vocabulary: the model's knowledge that travertine is a limestone, that coursed stone has
 * joints; nothing here matches words itself). Those sets join the class's shortlist, are measured and ranked like the
 * rest, and are shown to the pick by appearance beside the colour ranking's nearest, recoloured to the class as all
 * candidates are; the pick still decides by the surface. One call a building, kept in the readings store under the seen
 * words and the pool, so a rebuild or another side of a benchmark asks nothing twice.
 */

import type { TextureLibraryEntry } from '../../../../common/spatial/texture-library-index';
import { readingKey } from './model-readings';

export const MATERIAL_WORDS_VERSION = 'material-words/2';

/** Sets named per class, at most; a class whose finish read is this unsure, or has no words, is not asked. */
export const WORD_CANDIDATES = 6, WORDS_MIN_CONF = 50;

/** One line a set, for the model: its id, real size and the publisher's words (the appearance text's first clause and the tags). */
export function poolLines(entries: Array<Pick<TextureLibraryEntry, 'id' | 'appearance' | 'tags' | 'realSizeM'>>): string[] {
    return entries.map(e => {
        const size = e.realSizeM ? `${Math.round(e.realSizeM[0] * 10) / 10} m` : '';
        const text = (e.appearance ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const tags = (e.tags ?? []).slice(0, 12).join(', ');
        return `${e.id}${size ? ` (${size})` : ''}: ${text}${tags ? ` [${tags}]` : ''}`;
    });
}

export function wordsPrompt(rows: Array<{ seen: string }>, lines: string[], ctx: { building?: string; brief?: string } = {}): string {
    return [
        `Below is a texture library: one set a line, its id, the real width of one tile and its publisher's description and tags.`,
        `For the outside of ${ctx.building ?? 'a building'}, a vision model described each appearance class of its photographed surfaces:`,
        ...rows.map((r, k) => `- class ${k + 1}: ${r.seen}`),
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        `For each class name up to ${WORD_CANDIDATES} set ids whose description is nearest to the same material and finish, as a facade expert reads them (a dressed stone cladding is a flat, fine-grained stone with joints, not rubble, concrete or plaster; a travertine, a limestone tile or a marble is a limestone; a shaded or dark class is still its material), nearest first. When no set is that exact material, name the sets of the nearest kind (the same family of material and the same finish); an empty list only for a class that is no material (glass, sky, a shadow, a mix).`,
        `Answer with JSON only: {"classes":[{"class":1,"sets":["id","id"]}]}`,
        '',
        'The library:',
        ...lines
    ].join('\n');
}

/** The reply: per class, the valid set ids named, in order, at most WORD_CANDIDATES (a class left out gets none). Throws on anything malformed. */
export function parseWordCandidates(text: string, rows: number, valid: ReadonlySet<string>): Array<string[] | undefined> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j?.classes)) throw new Error('the reply has no "classes" list');
    const out: Array<string[] | undefined> = new Array(rows).fill(undefined);
    for (const c of j.classes) {
        if (typeof c?.class !== 'number' || !Array.isArray(c.sets)) throw new Error('a class without a "class" number or a "sets" list');
        const k = Math.round(c.class) - 1;
        if (k < 0 || k >= rows) continue;
        const ids: string[] = [];
        for (const s of c.sets) if (typeof s === 'string' && valid.has(s) && !ids.includes(s)) ids.push(s);
        out[k] = ids.slice(0, WORD_CANDIDATES);
    }
    return out;
}

/** The kept answer for this prompt (the seen words, the pool's lines and the wording) and model. */
export const wordsKey = (prompt: string, model: string) => readingKey('material-words', [MATERIAL_WORDS_VERSION, model, prompt]);
