/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree species library (assets/vegetation/species/index.json, schema scratchbox.tree-species/1): the proportions of
 * real trees, chosen per measured crown by its measurements in the native trees writer (scratchbox_tree_species.hpp), so
 * the parts a scan cannot see (crown base, trunk radius, stems, branching, leaf size) come from a tree of that shape.
 *
 * Every entry is described by continuous quantities only; `id`, `label` and `description` are labels for people and
 * prompts and are never branched on. A crown far from every entry is unmatched and grows from its measurements with the
 * grower's defaults (TreeSpeciesExtras.provenance 'unmatched').
 */

export const TREE_SPECIES_SCHEMA = 'scratchbox.tree-species/1';

export interface TreeSpeciesEntry {
    id: string;
    label: string;
    description: string;
    /** [min, max] apex above support the form is seen at (m). */
    heightM: [number, number];
    crownRadiusPerHeight: number;
    crownBaseRatio: number;
    trunkRadiusPerHeight: number;
    /** Share of the crown's surface samples within 0.35 crown radii of the apex (hemisphere ~0.58, 45° cone ~0.12, flat top ~1). */
    topShare: number;
    /** Stems leaving the ground; more than one grows as a shrub. */
    stems: number;
    /** Primary limbs at the crown break (0: the grower's seeded 2–4). */
    scaffoldBranches: number;
    apicalDominance: number;
    branchAngleRad: number;
    leafLengthM: number;
    leafAspect: number;
    /** [centre, spread] of the foliage's hue in the chromaticity plane (0 red, 60 yellow, 120 green). */
    hueDeg: [number, number];
}

export interface TreeSpeciesIndex {
    schema: typeof TREE_SPECIES_SCHEMA;
    about: string;
    conventions: Record<string, string>;
    entries: TreeSpeciesEntry[];
}

/** What is wrong with a species index, or nothing. Mirrors the native parser's checks (ranges, unique ids). */
export function validateTreeSpeciesIndex(doc: unknown): string[] {
    const out: string[] = [];
    const d = doc as Partial<TreeSpeciesIndex> | null;
    if (!d || typeof d !== 'object') return ['not an object'];
    if (d.schema !== TREE_SPECIES_SCHEMA) out.push(`schema is ${JSON.stringify(d.schema)}, not ${TREE_SPECIES_SCHEMA}`);
    if (!Array.isArray(d.entries) || d.entries.length === 0) return [...out, 'no entries'];
    const ids = new Set<string>();
    const inRange = (e: TreeSpeciesEntry, k: keyof TreeSpeciesEntry, lo: number, hi: number) => {
        const v = e[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) out.push(`${e.id}.${k} must be a number in [${lo}, ${hi}]`);
    };
    for (const e of d.entries) {
        if (!e.id) { out.push('an entry has no id'); continue; }
        if (ids.has(e.id)) out.push(`${e.id} is listed twice`);
        ids.add(e.id);
        if (!e.label) out.push(`${e.id} has no label`);
        if (!Array.isArray(e.heightM) || e.heightM.length !== 2 || !(e.heightM[0] >= 0.2) || !(e.heightM[1] >= e.heightM[0]) || e.heightM[1] > 150) out.push(`${e.id}.heightM must be [min, max] within [0.2, 150]`);
        inRange(e, 'crownRadiusPerHeight', 0.05, 3);
        inRange(e, 'crownBaseRatio', 0, 0.95);
        inRange(e, 'trunkRadiusPerHeight', 0.002, 0.2);
        inRange(e, 'topShare', 0, 1);
        inRange(e, 'stems', 1, 40);
        inRange(e, 'scaffoldBranches', 0, 24);
        inRange(e, 'apicalDominance', 0, 1);
        inRange(e, 'branchAngleRad', 0.05, 1.5);
        inRange(e, 'leafLengthM', 0.005, 6);
        inRange(e, 'leafAspect', 0.02, 2);
        if (!Array.isArray(e.hueDeg) || e.hueDeg.length !== 2 || !(e.hueDeg[1] >= 0) || e.hueDeg[1] > 180) out.push(`${e.id}.hueDeg must be [centre, spread]`);
    }
    return out;
}
