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
 * Every entry is described by continuous quantities only; `id`, `label`, `description`, `sources` and `estimated` are
 * labels for people and prompts and are never branched on. A crown far from every entry is unmatched and grows from its
 * measurements with the grower's defaults (TreeSpeciesExtras.provenance 'unmatched').
 *
 * The pick is weighed by shape and by region (user decision, 2026-11-05): each entry carries the latitude bands it grows
 * in, its hardiness, the dryness it stands and how common it is in each of the index's regions, and the build's place
 * (treeSpeciesPlaceParams) costs an entry that is implausible there; it is never excluded.
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
    /** [min, max] absolute latitude (deg) this form grows outdoors: the older symmetric form of latRangesDeg, still read; never both. */
    latAbsRangeDeg?: [number, number];
    /** Signed latitude bands [south, north] (deg, south negative) it grows outdoors in; a place outside every band costs by its distance to the nearest. */
    latRangesDeg?: [number, number][];
    /** [coldest, warmest] USDA hardiness zones (1..13.5, halves allowed), read as the annual extreme minimum temperatures it lives through. */
    usdaZones?: [number, number];
    /** [driest, wettest] aridity index (annual precipitation / potential evapotranspiration) it grows across. */
    aridityIndexRange?: [number, number];
    /** How common it is in each of the index's regions, by region id, 0..1; a region not named counts the index's regionWeightElsewhere. */
    regionWeights?: Record<string, number>;
    /** The share of its foliage kept through the leafless season: 0 deciduous, 1 evergreen. */
    leafRetention?: number;
    /** Months (1 = January, fractional) the leaves open and have fallen at 40 degrees north; given together. */
    leafOutMonth?: number;
    leafFallMonth?: number;
    /** [centre, spread] of the foliage's hue before it falls. */
    autumnHueDeg?: [number, number];
    /** Where the entry's numbers come from (at least one). */
    sources: string[];
    /** Fields that are an estimate for this entry, each with how it was derived. */
    estimated?: string[];
}

/** One box of the index's coarse place table (see the index's conventions.regions): an estimate of a place's climate, never a measurement. */
export interface TreeSpeciesRegion {
    id: string;
    label: string;
    latDeg: [number, number];
    /** [west, east]; west > east wraps the antimeridian. */
    lonDeg: [number, number];
    /** The annual extreme minimum temperature (deg C) at the box's [south edge, north edge]. */
    minWinterTempC: [number, number];
    aridityIndex: number;
    referenceElevationM?: number;
    /** The cities whose published hardiness zones the box was fitted to. */
    fitTo?: string;
}

export interface TreeSpeciesIndex {
    schema: typeof TREE_SPECIES_SCHEMA;
    about: string;
    conventions: Record<string, string>;
    regionWeightElsewhere?: number;
    regionEdgeDeg?: number;
    regions?: TreeSpeciesRegion[];
    entries: TreeSpeciesEntry[];
}

/**
 * The tile vegetation parameters that tell the species choice where a build is (TileVegetationStripParams and the
 * plant's): the legacy |latitude| and the signed place. Strip and plant must be given the same ones.
 */
export interface TreeSpeciesPlaceParams {
    latAbsDeg: number;
    latDeg: number;
    lonDeg: number;
    elevationM?: number;
}

/** A build's geo anchor as the species choice's place. The elevation (above sea level) is passed only when it is known. */
export function treeSpeciesPlaceParams(anchor: { lat: number; lng: number; elevation?: number }): TreeSpeciesPlaceParams {
    return {
        latAbsDeg: Math.abs(anchor.lat),
        latDeg: anchor.lat,
        lonDeg: anchor.lng,
        ...(typeof anchor.elevation === 'number' && Number.isFinite(anchor.elevation) ? { elevationM: anchor.elevation } : {})
    };
}

/** What is wrong with a species index, or nothing. Mirrors the native parser's checks (ranges, unique ids). */
export function validateTreeSpeciesIndex(doc: unknown): string[] {
    const out: string[] = [];
    const d = doc as Partial<TreeSpeciesIndex> | null;
    if (!d || typeof d !== 'object') return ['not an object'];
    if (d.schema !== TREE_SPECIES_SCHEMA) out.push(`schema is ${JSON.stringify(d.schema)}, not ${TREE_SPECIES_SCHEMA}`);
    const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    const span = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 2 && num(v[0], lo, hi) && num(v[1], v[0], hi);
    const strings = (v: unknown, least: number): boolean => Array.isArray(v) && v.length >= least && v.every(x => typeof x === 'string' && x.length > 0);
    if (d.regionWeightElsewhere !== undefined && !num(d.regionWeightElsewhere, 0, 1)) out.push('regionWeightElsewhere must be a number in [0, 1]');
    if (d.regionEdgeDeg !== undefined && !num(d.regionEdgeDeg, 0.1, 45)) out.push('regionEdgeDeg must be a number in [0.1, 45]');
    const regionIds = new Set<string>();
    if (d.regions !== undefined && !Array.isArray(d.regions)) out.push('regions must be a list');
    for (const r of Array.isArray(d.regions) ? d.regions : []) {
        if (!r || !r.id) { out.push('a region has no id'); continue; }
        if (regionIds.has(r.id)) out.push(`region ${r.id} is listed twice`);
        regionIds.add(r.id);
        if (!r.label) out.push(`region ${r.id} has no label`);
        if (!span(r.latDeg, -90, 90) || !(r.latDeg[1] > r.latDeg[0])) out.push(`region ${r.id}.latDeg must be [south, north] within [-90, 90]`);
        if (!Array.isArray(r.lonDeg) || r.lonDeg.length !== 2 || !num(r.lonDeg[0], -180, 180) || !num(r.lonDeg[1], -180, 180)) out.push(`region ${r.id}.lonDeg must be [west, east] within [-180, 180]`);
        if (!Array.isArray(r.minWinterTempC) || r.minWinterTempC.length !== 2 || !num(r.minWinterTempC[0], -70, 30) || !num(r.minWinterTempC[1], -70, 30)) out.push(`region ${r.id}.minWinterTempC must be [at the south edge, at the north edge] within [-70, 30]`);
        if (!num(r.aridityIndex, 0.005, 5)) out.push(`region ${r.id}.aridityIndex must be a number in [0.005, 5]`);
        if (r.referenceElevationM !== undefined && !num(r.referenceElevationM, -430, 6000)) out.push(`region ${r.id}.referenceElevationM must be a number in [-430, 6000]`);
    }
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
        if (e.latAbsRangeDeg !== undefined && !span(e.latAbsRangeDeg, 0, 90)) out.push(`${e.id}.latAbsRangeDeg must be [min, max] within [0, 90]`);
        if (e.latRangesDeg !== undefined) {
            if (e.latAbsRangeDeg !== undefined) out.push(`${e.id} gives both latAbsRangeDeg and latRangesDeg`);
            if (!Array.isArray(e.latRangesDeg) || e.latRangesDeg.length === 0 || !e.latRangesDeg.every(b => span(b, -90, 90))) out.push(`${e.id}.latRangesDeg must be a list of [south, north] within [-90, 90]`);
        }
        if (e.usdaZones !== undefined && !span(e.usdaZones, 1, 13.5)) out.push(`${e.id}.usdaZones must be [coldest, warmest] within [1, 13.5]`);
        if (e.aridityIndexRange !== undefined && !span(e.aridityIndexRange, 0.005, 5)) out.push(`${e.id}.aridityIndexRange must be [driest, wettest] within [0.005, 5]`);
        if (e.regionWeights !== undefined) {
            if (!e.regionWeights || typeof e.regionWeights !== 'object' || Array.isArray(e.regionWeights)) out.push(`${e.id}.regionWeights must be an object of region id: weight`);
            else for (const [region, w] of Object.entries(e.regionWeights)) {
                if (!regionIds.has(region)) out.push(`${e.id}.regionWeights names ${region}, which is not one of the index's regions`);
                if (!num(w, 0, 1)) out.push(`${e.id}.regionWeights.${region} must be a number in [0, 1]`);
            }
        }
        if (e.leafRetention !== undefined && !num(e.leafRetention, 0, 1)) out.push(`${e.id}.leafRetention must be a number in [0, 1]`);
        if ((e.leafOutMonth === undefined) !== (e.leafFallMonth === undefined)) out.push(`${e.id} gives one of leafOutMonth and leafFallMonth without the other`);
        else if (e.leafOutMonth !== undefined && (!num(e.leafOutMonth, 1, 13) || !num(e.leafFallMonth, e.leafOutMonth, 13))) out.push(`${e.id}.leafOutMonth and leafFallMonth must be months in [1, 13], leaf-out first`);
        if (e.autumnHueDeg !== undefined && (!Array.isArray(e.autumnHueDeg) || e.autumnHueDeg.length !== 2 || !num(e.autumnHueDeg[0], -180, 360) || !num(e.autumnHueDeg[1], 0, 180))) out.push(`${e.id}.autumnHueDeg must be [centre, spread]`);
        if (!strings(e.sources, 1)) out.push(`${e.id}.sources must name at least one source`);
        if (e.estimated !== undefined && !strings(e.estimated, 0)) out.push(`${e.id}.estimated must be a list of non-empty strings`);
    }
    return out;
}
