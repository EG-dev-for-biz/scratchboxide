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
 * facade reader saw between and in the windows, with its colour, the library set chosen for it and where each of those came
 * from; and the glass the reader saw. Written into the twin's GLB as `asset.extras.sbMaterialClasses`, so the building
 * carries its own material map wherever it goes.
 *
 * The words are labels (open vocabulary): nothing in the build branches on them. Provenance: the colour and the words are
 * photo-inferred (read from the photos), the library set generated (chosen to look like it).
 */

import type { FacadeReadRecord, GlassReading } from './facade-reader';
import type { RegionClass } from './material-regions';

export const MATERIAL_NAMING_VERSION = 'material-naming/1';

/** What the namer is told beside the swatches. */
export interface NamingContext { building?: string; brief?: string; between?: string[]; glass?: string[] }

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function namingPrompt(classes: Array<Pick<RegionClass, 'meanLab' | 'share' | 'wall'>>, ctx: NamingContext = {}): string {
    return [
        `Each row of this image is one appearance class of the outside of ${ctx.building ?? 'a building'}: patches of its photographed surfaces where that class covers most of the patch (straightened, de-lit photos).`,
        ...classes.map((c, k) => `- row ${k + 1}: ${pct(c.share)} of the facades' texels, lightness ${Math.round(c.meanLab[0])} of 100${c.wall ? ', the lightest (the wall)' : ''}`),
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        ...(ctx.between?.length ? [`Between its windows a reader saw: ${ctx.between.join('; ')}.`] : []),
        ...(ctx.glass?.length ? [`Its glass a reader saw as: ${ctx.glass.join('; ')}.`] : []),
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

export interface GlassSeen { words: string; planes: number; transparency: number; reflectivity: number; tint?: string; opaque: boolean }

/** The glass the reader saw, by its words: on how many planes, its numbers averaged (the commonest first). */
export function glassSeen(records: FacadeReadRecord[]): GlassSeen[] {
    const by = new Map<string, { planes: Set<number>; g: GlassReading[] }>();
    for (const r of records) for (const z of r.zones ?? []) {
        if (z.outcome !== 'drawn' || !z.glass) continue;
        const words = z.glass.label ?? (z.glass.opaque ? 'opaque panel' : 'glass');
        const e = by.get(words) ?? { planes: new Set<number>(), g: [] };
        e.planes.add(r.facadeId); e.g.push(z.glass); by.set(words, e);
    }
    const avg = (v: number[]) => Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
    return [...by.entries()].map(([words, e]) => {
        const tints = e.g.map(g => g.tint).filter((t): t is string => !!t), tint = tints.sort((x, y) => tints.filter(t => t === y).length - tints.filter(t => t === x).length)[0];
        return { words, planes: e.planes.size, transparency: avg(e.g.map(g => g.transparency)), reflectivity: avg(e.g.map(g => g.reflectivity)), ...(tint ? { tint } : {}), opaque: e.g.filter(g => g.opaque).length > e.g.length / 2 };
    }).sort((x, y) => y.planes - x.planes);
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
    set: { name: string; distance: number; label: 'generated' };
    words?: { text: string; conf: number; label: 'photo-inferred'; source: string };
}

export interface MaterialClassesExtras {
    schema: 'scratchbox.material-classes/1'; version: string;
    classes: MaterialClassEntry[];
    glass?: Array<GlassSeen & { label: 'photo-inferred'; source: string }>;
    /** Why the classes carry no words, when they do not. */
    unnamed?: string;
}

const hex = (linear: [number, number, number]) => '#' + linear.map(v => { const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, s)) * 255).toString(16).padStart(2, '0'); }).join('');

/** The classes as saved with the building: each with its colour, its library set and (when named) its words, and the reader's glass. */
export function materialClassesExtras(classes: Array<RegionClass & { set: string; distance: number }>, words: Array<ClassWords | undefined> | undefined, glass: GlassSeen[] = [], unnamed?: string): MaterialClassesExtras {
    return {
        schema: 'scratchbox.material-classes/1', version: MATERIAL_NAMING_VERSION,
        classes: classes.map((c, k) => ({
            index: c.index, share: c.share, wall: c.wall,
            colour: { lab: c.meanLab, srgb: hex(c.meanLinear), label: 'photo-inferred' },
            set: { name: c.set, distance: Math.round(c.distance * 1000) / 1000, label: 'generated' },
            ...(words?.[k] ? { words: { text: words[k]!.words, conf: words[k]!.conf, label: 'photo-inferred', source: 'a vision model naming patches of the class, told the building, its brief and what the facade reader saw' } } : {})
        })),
        ...(glass.length ? { glass: glass.map(g => ({ ...g, label: 'photo-inferred' as const, source: "the facade reader's glass readings, by their words" })) } : {}),
        ...(unnamed ? { unnamed } : {})
    };
}
