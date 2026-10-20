/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One feature model (schema `sb-feature/1`) for Google's decoded vector features and for the features Scratchbox measures
 * or infers, in the style of Google's feature tiles: a feature carries `types`, a list of SCREAMING_SNAKE codes from
 * general to specific (several at once), and its geometry in separate named blocks.
 *
 *   - Google's own codes (FEATURE_TYPE_*) and geometry blocks (extrudedAreas, areas, lines, modeledVolumes) pass through
 *     unchanged. Our codes all start with SB_FEATURE_TYPE_, so the two never collide.
 *   - Our geometry blocks, one per universal operator: revolvedProfiles (harmonic solids of revolution), sweeps (curve
 *     sweeps), replicators (affine metric replicators), reliefFields (normal relief fields); plus measurements (metres
 *     measured from the scan) and provenance.
 *   - relations: PART_OF, STANDS_ON, ATTACHED_TO, OCCLUDES (open: other relation names are kept).
 *
 * Guardrails (Adaptive Domain Architecture):
 *   - The vocabulary is open: `types` is `string[]`; an unknown code is accepted and kept as given. SB_FEATURE_TYPE_OBJECT
 *     (with a free-text description and a confidence) is always valid.
 *   - A code is a label for prompting, filtering, display and export. No code ever selects a geometry path: geometry comes
 *     only from the operator blocks and the measurements (test: sb-feature-types.test.ts checks the execution code).
 *   - Codes are never renamed, only deprecated. A model may stop at a parent code with a confidence. A code a model proposes
 *     that is not in the list is logged for review (`reviewUnknownCodes`) and kept on the feature, never added to the list.
 */

export const SB_FEATURE_SCHEMA = 'sb-feature/1';
export const SB_FEATURE_PREFIX = 'SB_FEATURE_TYPE_';

/** A type code (open: Google's codes, ours, and any other string are all valid). */
export type SbFeatureTypeCode = `SB_FEATURE_TYPE_${string}` | `FEATURE_TYPE_${string}` | (string & {});

/** A relation between two features (open). */
export type SbFeatureRelationKind = 'PART_OF' | 'STANDS_ON' | 'ATTACHED_TO' | 'OCCLUDES' | (string & {});

export interface SbFeatureCodeEntry {
    code: string;
    /** In our own words. */
    description: string;
    parent?: string;
    /** Export mapping: a CityGML 3.0 class (module:Class) and OSM tags, when one fits. */
    export: { citygml?: string; osm?: Record<string, string> };
    /** Set when a code is retired; the code stays readable forever. */
    deprecated?: { since: string; useInstead?: string };
}

const P = SB_FEATURE_PREFIX;
const entry = (code: string, description: string, parent: string | undefined, citygml?: string, osm?: Record<string, string>): SbFeatureCodeEntry =>
    ({ code: P + code, description, ...(parent ? { parent: P + parent } : {}), export: { ...(citygml ? { citygml } : {}), ...(osm ? { osm } : {}) } });

/** The starter list. Add a code only when a consumer needs it; never rename one. */
export const SB_FEATURE_CODES: readonly SbFeatureCodeEntry[] = [
    entry('OBJECT', 'Anything: the catch-all, always valid; say what it is in the free-text description, with a confidence.', undefined, 'core:AbstractSpaceBoundary'),
    entry('BUILDING_PART', 'A volume of a building that stands as one block (a wing, a tower, a setback storey).', 'OBJECT', 'bldg:BuildingPart', { 'building:part': 'yes' }),
    entry('WALL_SURFACE', 'An outside wall surface of a building.', 'OBJECT', 'con:WallSurface'),
    entry('ROOF_SURFACE', 'A surface that closes a building at the top.', 'OBJECT', 'con:RoofSurface'),
    entry('GROUND_SURFACE', 'The walkable surface a structure stands on (street, pavement, plaza).', 'OBJECT', 'con:GroundSurface'),
    entry('ROOF_OBJECT', 'Something that stands on a roof and is not the roof itself.', 'OBJECT', 'bldg:BuildingInstallation', { 'roof:object': 'yes' }),
    entry('ROOF_OBJECT_TANK', 'A container on a roof, often raised on legs (water storage and the like).', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { man_made: 'water_tower' }),
    entry('ROOF_OBJECT_CHIMNEY', 'A narrow stack rising from a roof that carries smoke or air up.', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { man_made: 'chimney' }),
    entry('ROOF_OBJECT_BULKHEAD', 'A closed box on a roof housing stairs, a lift or plant.', 'ROOF_OBJECT', 'bldg:BuildingInstallation'),
    entry('ROOF_OBJECT_EQUIPMENT', 'Machinery on a roof (air handling, cooling, ducts).', 'ROOF_OBJECT', 'bldg:BuildingInstallation'),
    entry('ROOF_OBJECT_SKYLIGHT', 'A glazed opening or lantern in a roof.', 'ROOF_OBJECT', 'con:Window'),
    entry('ROOF_OBJECT_DORMER', 'A small structure projecting from a sloped roof with its own face and roof.', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { 'roof:dormer': 'yes' }),
    entry('ROOF_OBJECT_DOME', 'A rounded vault crowning a roof.', 'ROOF_OBJECT', 'bldg:BuildingPart', { 'roof:shape': 'dome' }),
    entry('ROOF_OBJECT_SPIRE', 'A tall tapering point on a roof or tower.', 'ROOF_OBJECT', 'bldg:BuildingPart', { 'roof:shape': 'pyramidal' }),
    entry('ROOF_OBJECT_MAST', 'A thin upright on a roof (antenna, flagpole, aerial).', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { man_made: 'mast' }),
    entry('ROOF_OBJECT_SIGN_FRAME', 'An open frame on a roof that holds a sign.', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { advertising: 'billboard' }),
    entry('ROOF_OBJECT_PARAPET', 'A low wall along a roof edge.', 'ROOF_OBJECT', 'bldg:BuildingConstructiveElement'),
    entry('ROOF_OBJECT_RAILING', 'A guard rail along a roof edge or around roof plant.', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { barrier: 'handrail' }),
    entry('ROOF_OBJECT_SOLAR_ARRAY', 'A field of flat panels on a roof that collect sunlight.', 'ROOF_OBJECT', 'bldg:BuildingInstallation', { 'generator:source': 'solar' }),
    entry('FACADE_ELEMENT', 'Something on or in a wall surface, proud of it or cut into it.', 'OBJECT', 'bldg:BuildingInstallation'),
    entry('FACADE_ELEMENT_OPENING', 'A hole through a wall, glazed or not.', 'FACADE_ELEMENT', 'con:AbstractFillingElement'),
    entry('FACADE_ELEMENT_OPENING_WINDOW', 'An opening that lets in light and is not walked through.', 'FACADE_ELEMENT_OPENING', 'con:Window', { window: 'yes' }),
    entry('FACADE_ELEMENT_OPENING_DOOR', 'An opening people walk through.', 'FACADE_ELEMENT_OPENING', 'con:Door', { entrance: 'yes' }),
    entry('FACADE_ELEMENT_OPENING_STOREFRONT', 'A wide street-level opening of glass, often a shop front.', 'FACADE_ELEMENT_OPENING', 'con:Window', { shop: 'yes' }),
    entry('FACADE_ELEMENT_BAND', 'A horizontal course running along a wall.', 'FACADE_ELEMENT', 'bldg:BuildingConstructiveElement'),
    entry('FACADE_ELEMENT_CORNICE', 'A projecting crown along the top of a wall.', 'FACADE_ELEMENT', 'bldg:BuildingConstructiveElement'),
    entry('FACADE_ELEMENT_COLUMN', 'An upright member on a wall, engaged or free-standing.', 'FACADE_ELEMENT', 'bldg:BuildingConstructiveElement'),
    entry('FACADE_ELEMENT_BALCONY', 'A platform projecting from a wall with a guard.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation', { balcony: 'yes' }),
    entry('FACADE_ELEMENT_BAY', 'A section of wall that projects outwards over its storeys.', 'FACADE_ELEMENT', 'bldg:BuildingPart'),
    entry('FACADE_ELEMENT_FIRE_ESCAPE', 'An open stair and platforms fixed to the outside of a wall.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation', { 'fire_escape': 'yes' }),
    entry('FACADE_ELEMENT_AWNING', 'A shade or canopy projecting over an opening.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation', { 'building:part': 'roof' }),
    entry('FACADE_ELEMENT_SIGN', 'Lettering or a board fixed to a wall.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation', { advertising: 'sign' }),
    entry('FACADE_ELEMENT_ORNAMENT', 'Carved or cast decoration on a wall.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation'),
    entry('FACADE_ELEMENT_FIGURE', 'A statue or relief figure on a wall.', 'FACADE_ELEMENT', 'bldg:BuildingInstallation', { artwork_type: 'statue' }),
    entry('TREE', 'A tree.', 'OBJECT', 'veg:SolitaryVegetationObject', { natural: 'tree' }),
    entry('STREET_FURNITURE', 'A fixed object in a street (bench, bin, kiosk, bollard).', 'OBJECT', 'frn:CityFurniture'),
    entry('POLE', 'A free-standing upright in a street (lamp, signal, sign post).', 'STREET_FURNITURE', 'frn:CityFurniture', { man_made: 'pole' }),
    entry('SCAN_ARTEFACT', 'Geometry in a scan that is not a real thing: an error of the reconstruction.', 'OBJECT'),
    entry('SCAN_ARTEFACT_SLIVER', 'A scan artefact made of needle-thin triangles.', 'SCAN_ARTEFACT'),
    entry('SCAN_ARTEFACT_FLOATING', 'A scan artefact that touches nothing, or a loose copy of a surface standing off it.', 'SCAN_ARTEFACT'),
    entry('SCAN_ARTEFACT_SPIKE', 'A scan artefact drawn out into a long thin shard.', 'SCAN_ARTEFACT'),
    entry('SCAN_UNEXPLAINED', 'Scan geometry nothing explains yet and nothing has ruled out.', 'OBJECT'),
    entry('OCCLUDED', 'A part that no source saw (hidden behind something).', 'OBJECT')
];

const BY_CODE = new Map(SB_FEATURE_CODES.map(e => [e.code, e]));

/** A code of the list, or undefined (an unknown code is still valid on a feature; it is only not described here). */
export function featureCodeEntry(code: string): SbFeatureCodeEntry | undefined { return BY_CODE.get(code); }

/** The code and its parents, general first (an unknown code stands alone). */
export function featureCodeLineage(code: string): string[] {
    const out: string[] = [];
    for (let c: string | undefined = code, guard = 0; c && guard < 16; c = BY_CODE.get(c)?.parent, guard++) out.unshift(c);
    return out;
}

/** True when `code` is `ancestor` or under it (unknown codes are under nothing but themselves). */
export function featureCodeIsA(code: string, ancestor: string): boolean { return featureCodeLineage(code).includes(ancestor); }

// ------------------------------------------------------------------------------------------------ geometry blocks

export type SbVec3 = [number, number, number];

/** Harmonic solid of revolution: r(z) about an axis, with K radial lobes and a helical twist. */
export interface SbRevolvedProfile {
    axisOrigin: SbVec3; axisDirection: SbVec3;
    /** (z along the axis from the origin, radius), metres, z ascending. */
    profile: Array<[number, number]>;
    lobes?: { count: number; amplitude: number };
    twistDegPerM?: number;
}

/** Curve sweep: a profile carried along a 3D curve with scale and twist along it. */
export interface SbSweep {
    carrier: SbVec3[];
    /** A closed (u, v) outline in metres, in the carrier's normal plane. */
    profile: Array<[number, number]>;
    scale?: Array<[number, number]>;
    twistDeg?: Array<[number, number]>;
}

/** Affine metric replicator: a seed repeated at a pitch along a carrier (or over a 2D lattice). */
export interface SbReplicator {
    /** Which geometry block the seed is, e.g. "sweeps/0". */
    seedRef: string;
    pitchM: number | [number, number];
    count: number | [number, number];
    carrier: SbVec3[];
}

/** Normal relief field: displacement along a surface's normal from a map, with its scale. */
export interface SbReliefField {
    /** The surface it displaces, e.g. a feature id or a geometry block ref. */
    surfaceRef: string;
    /** A displacement map (image path or inline grid) in metres at `scaleM` per unit. */
    map: string | { width: number; height: number; values: number[] };
    scaleM: number;
    /** Metres per map pixel on the surface. */
    pixelM?: number;
}

export interface SbFeatureGeometry {
    // Google's blocks, carried as decoded or as received (never reinterpreted)
    extrudedAreas?: unknown[];
    areas?: unknown[];
    lines?: unknown[];
    modeledVolumes?: unknown[];
    // ours, one per universal operator
    revolvedProfiles?: SbRevolvedProfile[];
    sweeps?: SbSweep[];
    replicators?: SbReplicator[];
    reliefFields?: SbReliefField[];
    [block: string]: unknown;
}

/** Where a feature's numbers came from (labels open). */
export interface SbFeatureProvenance {
    label: 'measured' | 'vector-modelled' | 'photo-inferred' | 'generated' | (string & {});
    confidence: number;
    sources: Array<{ kind: string; id: string }>;
    method?: string;
}

export interface SbFeatureTypeLabel {
    code: SbFeatureTypeCode;
    confidence: number;
    /** Who proposed it: a numeric rule, a vision model, Google's data, a person. */
    by?: string;
}

export interface SbFeature {
    schema: typeof SB_FEATURE_SCHEMA;
    id: string;
    /** General to specific; any number; open vocabulary. */
    types: SbFeatureTypeCode[];
    /** Per code, how sure the proposer was (missing: as given by the source). */
    typeLabels?: SbFeatureTypeLabel[];
    /** Free text, required in spirit for SB_FEATURE_TYPE_OBJECT. */
    description?: string;
    displayName?: string;
    placeId?: string;
    geometry: SbFeatureGeometry;
    /** Measured from the scan, in metres (and m2, m3, ratios); open names. */
    measurements?: Record<string, number | number[] | null>;
    provenance: SbFeatureProvenance;
    relations?: Array<{ kind: SbFeatureRelationKind; target: string; confidence?: number }>;
    /** The frame the geometry is in (e.g. a tile grid, a local tangent plane). */
    frame?: Record<string, unknown>;
}

/**
 * Codes on a feature that the list does not know, for review: proposed codes are kept on the feature and reported, never
 * added to the list. Google's own codes are not ours to review and are skipped.
 */
export function reviewUnknownCodes(types: readonly string[], log?: (code: string) => void): string[] {
    const unknown = types.filter(t => t.startsWith(SB_FEATURE_PREFIX) && !BY_CODE.has(t));
    for (const u of unknown) log?.(u);
    return unknown;
}

/** The type labels with each code's parents filled in (a label for a child implies its parents at the same confidence). */
export function typesFromLabels(labels: readonly SbFeatureTypeLabel[]): SbFeatureTypeCode[] {
    const out: string[] = [];
    for (const l of labels) for (const c of featureCodeLineage(l.code)) if (!out.includes(c)) out.push(c);
    return out;
}

// ------------------------------------------------------------------------------------------------ Google's features

/** A raw Google feature tile feature (types, geometry and labels as received). */
export interface GoogleRawFeature { types?: string[]; geometry?: Record<string, unknown>; labels?: unknown[]; placeId?: string; displayName?: string }

/**
 * A Google feature carried into the model unchanged: its types as given, its geometry blocks as received (tile grid units),
 * its name and place id passed through. Provenance says it is Google's vector data.
 */
export function sbFeatureFromGoogle(raw: GoogleRawFeature, id: string, tile: { x: number; y: number; zoom: number }): SbFeature {
    const labelText = (raw.labels as Array<{ textComponents?: Array<{ texts?: Array<{ text?: string }> }> }> | undefined)?.[0]?.textComponents?.[0]?.texts?.[0]?.text;
    const displayName = raw.displayName ?? labelText;
    return {
        schema: SB_FEATURE_SCHEMA, id, types: [...(raw.types ?? [])],
        geometry: { ...(raw.geometry ?? {}) } as SbFeatureGeometry,
        ...(displayName ? { displayName } : {}), ...(raw.placeId ? { placeId: raw.placeId } : {}),
        provenance: { label: 'vector-modelled', confidence: 1, sources: [{ kind: 'vector-data', id: 'google-vectortiles' }], method: 'Google vector feature tile, carried unchanged' },
        frame: { kind: 'google-feature-tile', x: tile.x, y: tile.y, zoom: tile.zoom, grid: 4096 }
    };
}
