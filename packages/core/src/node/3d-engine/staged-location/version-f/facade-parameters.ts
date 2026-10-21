/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment), step 1: one vision reading of a building's facade system as continuous numbers.
 *
 * The model sees the tile seen from above, each large wall as an orthographic picture with a metric ruler, oblique views of
 * the tile and Street View photos, and answers with dimensions in metres (storey heights, bay spacing, opening sizes and
 * sills, plinth, bands, cornice, parapet, piers, roof pitch and ridge direction, raised roof volumes), linear colours with
 * roughness, and free-text notes about anything the numbers cannot hold. There is no style or type vocabulary: every value
 * is a dimension that can be interpolated, and the free text is recorded, never branched on.
 */

export type Rgb = [number, number, number];

export interface OpeningParameters {
    /** Opening width (m). */
    widthM: number;
    /** Opening height (m). */
    heightM: number;
    /** Sill above the storey's floor (m). */
    sillM: number;
    /** How far the glazing sits behind the wall face (m). */
    recessM: number;
    /**
     * The head's rise over the half-width (0 a flat head; under 1 segmental; 1 semicircular; above 1 stilted). The opening's
     * height includes the head.
     */
    archRiseRatio?: number;
    /** 0 a round (or segmental) head, rising to 1 for an equilateral pointed head: the two arcs' centres move apart. */
    apexSharpness?: number;
}

/**
 * A horizontal band of the facade with its own openings: from `bottomM` to `topM` above the street, openings of `opening`'s
 * size; each spans `bayGroup` bays (an arcade opening over paired bays) and repeats every `storeyGroup` storeys (an arch
 * over two or three storeys). Both are counts read as numbers (rounded where they place openings).
 */
export interface FacadeBand {
    bottomM: number; topM: number; opening: OpeningParameters; bayGroup: number; storeyGroup: number;
    /** Round 3: the pier between the arches of a group (m); the read piers' width, else 0.4 m, when absent. */
    pierWidthM?: number;
}

/** One wall's own storeys (a double-height ground floor, a penthouse), keyed by the wall picture it was read from. */
export interface WallStoreys {
    picture: number; faceKey?: string; groundStoreyM: number; upperStoreysM: number[];
    /** Round 3 (a wall read on its own picture): its own bays, families and bands; absent fields take the building's. */
    bayWidthM?: number; edgeMarginM?: number; window?: OpeningParameters; groundOpening?: OpeningParameters; facadeBands?: FacadeBand[];
}

/**
 * Round 3: a feature the reading names on a wall picture, to be kept through the redraw (the must-keep guard, local-gate.ts).
 * `types` are open feature-type codes (sb-feature-types.ts, Google's FEATURE_TYPE_* and ours SB_FEATURE_TYPE_*), labels only:
 * nothing routes geometry by them. `box` is [x0, y0, x1, y1] in per-mille of the wall picture (x right, y down).
 */
export interface ReadFeature { picture: number; faceKey?: string; label: string; types: string[]; box: [number, number, number, number]; confidence: number }

export interface BandParameters {
    /** Height of the band's centre above the ground (m). */
    heightM: number;
    thicknessM: number;
    projectionM: number;
}

export interface SurfaceParameters { linearRgb: Rgb; roughness: number }

export interface RooftopVolume {
    /** [x0, y0, x1, y1] in per-mille of the top-down picture (x right, y down). */
    box: [number, number, number, number];
    heightM: number;
}

/** The facade system of one building, every field a continuous dimension (0 where a feature is absent). */
export interface BuildingParameters {
    /** Ground storey, floor to the next floor (m). */
    groundStoreyM: number;
    /** Upper storey heights from the second storey up (m); the last one repeats to the top. */
    upperStoreysM: number[];
    /** Centre-to-centre spacing of the window bays (m). */
    bayWidthM: number;
    /** Solid wall from a facade's end to the edge of its first bay (m). */
    edgeMarginM: number;
    window: OpeningParameters;
    groundOpening: OpeningParameters;
    /** Bands of the facade whose openings differ from `window` (arcades, arched storeys); empty when one family holds. */
    facadeBands: FacadeBand[];
    /** Walls whose storeys differ from the building's (by the picture they were read from). */
    wallStoreys: WallStoreys[];
    plinth: { heightM: number; projectionM: number };
    bands: BandParameters[];
    cornice: { thicknessM: number; projectionM: number };
    parapet: { heightM: number };
    /** Vertical piers or pilasters between the bays (0 width: none). */
    piers: { widthM: number; projectionM: number };
    roof: { pitchDeg: number; ridgeAzimuthDeg: number; hipped: boolean };
    rooftopVolumes: RooftopVolume[];
    materials: { wall: SurfaceParameters; trim: SurfaceParameters; glazing: SurfaceParameters };
    /** What the numbers cannot hold, in the model's words (recorded; nothing branches on it). */
    features: string[];
    /** Round 3: distinct features on the wall pictures with their regions, kept through the redraw (labels only). */
    featureRegions?: ReadFeature[];
    /** 0..1. */
    confidence: number;
}

/** Clamp ranges (also the adjustment's bounds). */
export const PARAMETER_BOUNDS = {
    storeyM: [2.4, 9],
    bayWidthM: [1.2, 12],
    edgeMarginM: [0, 8],
    openingWidthM: [0.4, 10],
    openingHeightM: [0.5, 8],
    sillM: [0, 3],
    recessM: [0.02, 1],
    plinthHeightM: [0, 4],
    projectionM: [0, 2],
    bandThicknessM: [0.05, 3],
    parapetM: [0, 4],
    pierWidthM: [0, 3],
    pitchDeg: [0, 75],
    rooftopHeightM: [0.5, 30],
    archRiseRatio: [0, 2],
    apexSharpness: [0, 1],
    groupCount: [1, 6]
} as const;

export const DEFAULT_PARAMETERS: BuildingParameters = {
    groundStoreyM: 4.2, upperStoreysM: [3.4], bayWidthM: 3.2, edgeMarginM: 0.8,
    window: { widthM: 1.3, heightM: 2.0, sillM: 0.9, recessM: 0.2 },
    groundOpening: { widthM: 2.4, heightM: 3.2, sillM: 0.3, recessM: 0.25 },
    facadeBands: [], wallStoreys: [], featureRegions: [],
    plinth: { heightM: 0, projectionM: 0 }, bands: [], cornice: { thicknessM: 0, projectionM: 0 }, parapet: { heightM: 0 },
    piers: { widthM: 0, projectionM: 0 }, roof: { pitchDeg: 0, ridgeAzimuthDeg: 0, hipped: false }, rooftopVolumes: [],
    materials: { wall: { linearRgb: [0.25, 0.22, 0.2], roughness: 0.85 }, trim: { linearRgb: [0.4, 0.38, 0.35], roughness: 0.7 }, glazing: { linearRgb: [0.03, 0.035, 0.04], roughness: 0.1 } },
    features: [], confidence: 0.5
};

/** What the reader showed the model, so the prompt can name each picture. */
export interface ReadingPictureNote {
    /** e.g. "top-down", "wall", "oblique", "street view" (open, for the prompt's wording only). */
    role: string;
    /** One sentence the prompt repeats for this picture (its scale, its ruler, which way it looks). */
    caption: string;
}

export const FACADE_PARAMETERS_PROMPT_ID = 'version-f/facade-parameters/v1';
export const FACADE_PARAMETERS_PROMPT_ID_V2 = 'version-f/facade-parameters/v2';

/** The reading prompt for the pictures described by `pictures` (in the order they are sent). */
export const FACADE_PARAMETERS_PROMPT_ID_V3 = 'version-f/facade-parameters/v3';

/**
 * The reading prompt for the pictures described by `pictures` (in the order they are sent). Round 3 (`wall` given): the
 * reading is of one wall, picture `wall.picture`, with the building's other pictures as context; it answers that wall's own
 * numbers and names the distinct features on it with their regions (open type codes, labels only).
 */
export function facadeParametersPrompt(place: string, pictures: ReadingPictureNote[], options: { shapes?: boolean; wall?: { picture: number } } = {}): string {
    const shapes = options.shapes ? [
        '- every opening ("window", "groundOpening" and each band\'s "opening") also has "archRiseRatio" (the head\'s rise over half the opening\'s width: 0 flat, about 0.3-0.6 segmental, 1 semicircular) and "apexSharpness" (0 round, up to 1 for an equilateral pointed arch); the opening\'s heightM includes its head;',
        '- "facadeBands": horizontal zones whose openings differ from "window" (an arcade over two or three storeys, an arched top storey, a double-height ground floor): [{"bottomM","topM" (above the street),"opening":{...},"bayGroup" (how many bays one opening spans, 1 = one per bay),"storeyGroup" (how many storeys one opening spans)}];',
        '- "wallStoreys": walls (by their picture number) whose storeys differ from the rest: [{"picture":2,"groundStoreyM","upperStoreysM":[...]}];'
    ] : [];
    const wall = options.wall ? [
        `This reading is of ONE wall: picture ${options.wall.picture}. Every number describes that wall (its own storeys, bays, openings, bands and arcades); the other pictures only give context (the building's depth, roof and neighbours).`,
        '- an arcade (a band whose "bayGroup" is above 1) is one arch PER BAY between piers: give the band\'s "pierWidthM" (the pier between two arches, m) and its "opening" as the width of one group of arches;',
        '- "featureRegions": the distinct features on THIS wall picture that must survive any redrawing (a clock, a sign, a statue, a fire escape, a balcony, an awning, a shopfront, a distinctive doorway), each with its region: [{"label": <a few words>, "types": [<feature type codes, general to specific, e.g. "SB_FEATURE_TYPE_FACADE_ELEMENT", "SB_FEATURE_TYPE_FACADE_ELEMENT_SIGN"; invent a code of that form when none fits, or "SB_FEATURE_TYPE_OBJECT">], "picture": ' + options.wall.picture + ', "box": [x0,y0,x1,y1] in per-mille of that picture (x right, y down), "confidence": 0..100}];'
    ] : [];
    return [
        `You are measuring the building "${place}" so it can be rebuilt procedurally from numbers. ${pictures.length} pictures follow, in this order:`,
        ...pictures.map((p, i) => `  ${i + 1}. ${p.caption}`),
        'The orthographic wall pictures are to scale: use their rulers (a tick every metre above the ground, a long tick every 5 m) to measure; the street level is the ruler\'s 0. The other pictures show context and depth.',
        'Read the facade system that repeats across the building\'s walls as numbers in metres (0 where something is absent):',
        '- "groundStoreyM": the ground storey, floor to the next floor; "upperStoreysM": the heights of the storeys above it from the second storey up, in order (the last repeats to the top);',
        '- "bayWidthM": the centre-to-centre spacing of the window bays; "edgeMarginM": the solid wall from a facade\'s end to the edge of its first bay;',
        '- "window": the typical upper-storey opening {"widthM","heightM","sillM" (above its storey\'s floor),"recessM" (how far the glass sits behind the wall face)}; "groundOpening": the same for the ground storey\'s openings (shopfronts, doors, arches as their bounding rectangle);',
        '- "plinth": {"heightM","projectionM"} a base course standing out at the bottom; "bands": horizontal string courses [{"heightM" (centre, above the street),"thicknessM","projectionM"}];',
        '- "cornice": {"thicknessM","projectionM"} at the top of the walls; "parapet": {"heightM"} a wall standing above the roof\'s edge;',
        '- "piers": {"widthM","projectionM"} vertical piers, pilasters or columns between the bays;',
        '- "roof": {"pitchDeg" (0 flat),"ridgeAzimuthDeg" (compass direction of the ridge, 0 north-south, 90 east-west),"hipped" (true when the ends slope too)};',
        '- "rooftopVolumes": raised blocks on the roof (bulkheads, plant rooms, towers) [{"box":[x0,y0,x1,y1] in per-mille of picture 1 (x right, y down),"heightM" above the roof}];',
        '- "materials": {"wall","trim","glazing"} each {"linearRgb":[r,g,b] linear 0..1 albedo (not sRGB),"roughness":0..1};',
        ...shapes,
        '- "features": short free-text notes on anything the numbers cannot hold (arches, ornament, columns\' shape, signs, fire escapes, irregular bays), as many as you see;',
        '- "confidence": 0..100.',
        ...wall,
        'Measure what the pictures show for this building only; do not invent storeys or bays that are not there.',
        'Answer with JSON only: {"groundStoreyM":4,"upperStoreysM":[3.5],"bayWidthM":3,"edgeMarginM":1,"window":{"widthM":1.2,"heightM":2,"sillM":0.9,"recessM":0.2},"groundOpening":{"widthM":2.5,"heightM":3,"sillM":0.3,"recessM":0.3},"plinth":{"heightM":0,"projectionM":0},"bands":[],"cornice":{"thicknessM":0,"projectionM":0},"parapet":{"heightM":0},"piers":{"widthM":0,"projectionM":0},"roof":{"pitchDeg":0,"ridgeAzimuthDeg":0,"hipped":false},"rooftopVolumes":[],"materials":{"wall":{"linearRgb":[0.2,0.2,0.2],"roughness":0.8},"trim":{"linearRgb":[0.3,0.3,0.3],"roughness":0.7},"glazing":{"linearRgb":[0.03,0.03,0.04],"roughness":0.1}},"features":[],"confidence":50}'
    ].join('\n');
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function opening(j: unknown, d: OpeningParameters): OpeningParameters {
    const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
    return {
        widthM: clamp(num(o.widthM) ?? d.widthM, PARAMETER_BOUNDS.openingWidthM),
        heightM: clamp(num(o.heightM) ?? d.heightM, PARAMETER_BOUNDS.openingHeightM),
        sillM: clamp(num(o.sillM) ?? d.sillM, PARAMETER_BOUNDS.sillM),
        recessM: clamp(num(o.recessM) ?? d.recessM, PARAMETER_BOUNDS.recessM),
        archRiseRatio: clamp(num(o.archRiseRatio) ?? d.archRiseRatio ?? 0, PARAMETER_BOUNDS.archRiseRatio),
        apexSharpness: clamp(num(o.apexSharpness) ?? d.apexSharpness ?? 0, PARAMETER_BOUNDS.apexSharpness)
    };
}

function surface(j: unknown, d: SurfaceParameters): SurfaceParameters {
    const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
    const rgb = Array.isArray(o.linearRgb) && o.linearRgb.length >= 3 && o.linearRgb.slice(0, 3).every(v => num(v) !== undefined)
        ? (o.linearRgb.slice(0, 3).map(v => num(v)!) as Rgb) : d.linearRgb;
    // a reply in 0..255 is read as sRGB bytes and linearised
    const lin = rgb.some(v => v > 1.5) ? (rgb.map(v => { const c = Math.max(0, Math.min(255, v)) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }) as Rgb) : (rgb.map(v => Math.max(0, Math.min(1, v))) as Rgb);
    return { linearRgb: lin, roughness: Math.max(0, Math.min(1, num(o.roughness) ?? d.roughness)) };
}

/**
 * Parses the model's reply into BuildingParameters: the JSON object in the text, every number clamped to PARAMETER_BOUNDS,
 * a missing field taking DEFAULT_PARAMETERS' value (listed in `defaulted`). Throws when the reply holds no JSON object.
 */
export function parseFacadeParameters(text: string): { params: BuildingParameters; defaulted: string[] } {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    const d = DEFAULT_PARAMETERS;
    const defaulted: string[] = [];
    const pick = (key: string, v: number | undefined, dv: number) => { if (v === undefined) defaulted.push(key); return v ?? dv; };
    const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
    const upper = (Array.isArray(j.upperStoreysM) ? j.upperStoreysM : num(j.upperStoreysM) !== undefined ? [j.upperStoreysM] : [])
        .map(num).filter((v): v is number => v !== undefined && v > 0).map(v => clamp(v, PARAMETER_BOUNDS.storeyM)).slice(0, 80);
    if (!upper.length) defaulted.push('upperStoreysM');
    for (const k of ['window', 'groundOpening', 'materials', 'roof'] as const) if (!j[k] || typeof j[k] !== 'object') defaulted.push(k);
    const bands = (Array.isArray(j.bands) ? j.bands : []).map(obj).map(e => ({ heightM: num(e.heightM), thicknessM: num(e.thicknessM), projectionM: num(e.projectionM) }))
        .filter(e => e.heightM !== undefined && e.heightM > 0 && (e.projectionM ?? 0) > 0)
        .map(e => ({ heightM: e.heightM!, thicknessM: clamp(e.thicknessM ?? 0.3, PARAMETER_BOUNDS.bandThicknessM), projectionM: clamp(e.projectionM!, PARAMETER_BOUNDS.projectionM) }))
        .sort((p, q) => p.heightM - q.heightM).slice(0, 24);
    const vols: RooftopVolume[] = [];
    for (const e of (Array.isArray(j.rooftopVolumes) ? j.rooftopVolumes : []).map(obj)) {
        const box = Array.isArray(e.box) ? e.box.map(num) : [];
        const h = num(e.heightM);
        if (box.length !== 4 || box.some(v => v === undefined) || h === undefined) continue;
        const [x0, y0, x1, y1] = box.map(v => Math.max(0, Math.min(1000, v!)));
        if (Math.abs(x1 - x0) < 2 || Math.abs(y1 - y0) < 2) continue;
        vols.push({ box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], heightM: clamp(h, PARAMETER_BOUNDS.rooftopHeightM) });
    }
    const parseBands = (v: unknown): FacadeBand[] => {
        const out: FacadeBand[] = [];
        for (const e of (Array.isArray(v) ? v : []).map(obj)) {
            const b0 = num(e.bottomM), b1 = num(e.topM);
            if (b0 === undefined || b1 === undefined || b1 - b0 < 1) continue;
            const pierW = num(e.pierWidthM);
            out.push({ bottomM: Math.max(0, b0), topM: b1, opening: opening(e.opening, d.window), bayGroup: clamp(num(e.bayGroup) ?? 1, PARAMETER_BOUNDS.groupCount), storeyGroup: clamp(num(e.storeyGroup) ?? 1, PARAMETER_BOUNDS.groupCount), ...(pierW !== undefined ? { pierWidthM: clamp(pierW, PARAMETER_BOUNDS.pierWidthM) } : {}) });
        }
        return out.sort((a, b) => a.bottomM - b.bottomM).slice(0, 12);
    };
    const facadeBands = parseBands(j.facadeBands);
    const wallStoreys: WallStoreys[] = [];
    for (const e of (Array.isArray(j.wallStoreys) ? j.wallStoreys : []).map(obj)) {
        const pic = num(e.picture), g = num(e.groundStoreyM);
        const up = (Array.isArray(e.upperStoreysM) ? e.upperStoreysM : []).map(num).filter((v): v is number => v !== undefined && v > 0).map(v => clamp(v, PARAMETER_BOUNDS.storeyM));
        if (pic === undefined || g === undefined || !up.length) continue;
        const bw = num(e.bayWidthM), em = num(e.edgeMarginM);
        wallStoreys.push({
            picture: Math.round(pic), groundStoreyM: clamp(g, PARAMETER_BOUNDS.storeyM), upperStoreysM: up.slice(0, 80),
            ...(bw !== undefined ? { bayWidthM: clamp(bw, PARAMETER_BOUNDS.bayWidthM) } : {}), ...(em !== undefined ? { edgeMarginM: clamp(em, PARAMETER_BOUNDS.edgeMarginM) } : {}),
            ...(e.window && typeof e.window === 'object' ? { window: opening(e.window, d.window) } : {}), ...(e.groundOpening && typeof e.groundOpening === 'object' ? { groundOpening: opening(e.groundOpening, d.groundOpening) } : {}),
            ...(Array.isArray(e.facadeBands) ? { facadeBands: parseBands(e.facadeBands) } : {})
        });
    }
    // round 3: distinct features with their regions (open type codes, labels only)
    const featureRegions: ReadFeature[] = [];
    for (const e of (Array.isArray(j.featureRegions) ? j.featureRegions : []).map(obj)) {
        const pic = num(e.picture), box = Array.isArray(e.box) ? e.box.map(num) : [];
        const label = typeof e.label === 'string' ? e.label.trim().slice(0, 120) : '';
        if (pic === undefined || box.length !== 4 || box.some(v => v === undefined) || !label) continue;
        const [x0, y0, x1, y1] = box.map(v => Math.max(0, Math.min(1000, v!)));
        if (Math.abs(x1 - x0) < 2 || Math.abs(y1 - y0) < 2) continue;
        const types = (Array.isArray(e.types) ? e.types : typeof e.type === 'string' ? [e.type] : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')).slice(0, 6);
        const c = num(e.confidence);
        featureRegions.push({ picture: Math.round(pic), label, types: types.length ? types : ['SB_FEATURE_TYPE_OBJECT'], box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], confidence: c === undefined ? 0.5 : Math.max(0, Math.min(1, c > 1 ? c / 100 : c)) });
    }
    const roof = obj(j.roof), plinth = obj(j.plinth), cornice = obj(j.cornice), parapet = obj(j.parapet), piers = obj(j.piers), mat = obj(j.materials);
    const conf = num(j.confidence);
    const params: BuildingParameters = {
        groundStoreyM: clamp(pick('groundStoreyM', num(j.groundStoreyM), d.groundStoreyM), PARAMETER_BOUNDS.storeyM),
        upperStoreysM: upper.length ? upper : [...d.upperStoreysM],
        bayWidthM: clamp(pick('bayWidthM', num(j.bayWidthM), d.bayWidthM), PARAMETER_BOUNDS.bayWidthM),
        edgeMarginM: clamp(pick('edgeMarginM', num(j.edgeMarginM), d.edgeMarginM), PARAMETER_BOUNDS.edgeMarginM),
        window: opening(j.window, d.window),
        groundOpening: opening(j.groundOpening, d.groundOpening),
        facadeBands: facadeBands.slice(0, 12),
        wallStoreys: wallStoreys.slice(0, 12),
        featureRegions: featureRegions.slice(0, 24),
        plinth: { heightM: clamp(num(plinth.heightM) ?? 0, PARAMETER_BOUNDS.plinthHeightM), projectionM: clamp(num(plinth.projectionM) ?? 0, PARAMETER_BOUNDS.projectionM) },
        bands,
        cornice: { thicknessM: clamp(num(cornice.thicknessM) ?? 0, [0, PARAMETER_BOUNDS.bandThicknessM[1]]), projectionM: clamp(num(cornice.projectionM) ?? 0, PARAMETER_BOUNDS.projectionM) },
        parapet: { heightM: clamp(num(parapet.heightM) ?? 0, PARAMETER_BOUNDS.parapetM) },
        piers: { widthM: clamp(num(piers.widthM) ?? 0, PARAMETER_BOUNDS.pierWidthM), projectionM: clamp(num(piers.projectionM) ?? 0, PARAMETER_BOUNDS.projectionM) },
        roof: { pitchDeg: clamp(num(roof.pitchDeg) ?? 0, PARAMETER_BOUNDS.pitchDeg), ridgeAzimuthDeg: ((num(roof.ridgeAzimuthDeg) ?? 0) % 180 + 180) % 180, hipped: roof.hipped === true || roof.hipped === 'true' },
        rooftopVolumes: vols.slice(0, 16),
        materials: { wall: surface(mat.wall, d.materials.wall), trim: surface(mat.trim, d.materials.trim), glazing: surface(mat.glazing, d.materials.glazing) },
        features: (Array.isArray(j.features) ? j.features : typeof j.features === 'string' ? [j.features] : []).filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim().slice(0, 240)).slice(0, 24),
        confidence: conf === undefined ? d.confidence : Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf))
    };
    // an opening never taller than its storey, a window never wider than its bay
    const minUpper = Math.min(...params.upperStoreysM);
    params.window.heightM = Math.min(params.window.heightM, minUpper - 0.2);
    params.window.sillM = Math.min(params.window.sillM, Math.max(0, minUpper - params.window.heightM - 0.1));
    params.window.widthM = Math.min(params.window.widthM, params.bayWidthM * 0.95);
    params.groundOpening.heightM = Math.min(params.groundOpening.heightM, params.groundStoreyM - 0.1);
    params.groundOpening.sillM = Math.min(params.groundOpening.sillM, Math.max(0, params.groundStoreyM - params.groundOpening.heightM - 0.05));
    params.groundOpening.widthM = Math.min(params.groundOpening.widthM, params.bayWidthM * 0.98);
    return { params, defaulted };
}

/** Storey floor heights above the ground (m), from 0 up to `heightM` (the last storey may be cut by the top). */
export function storeyLines(p: Pick<BuildingParameters, 'groundStoreyM' | 'upperStoreysM'>, heightM: number): number[] {
    const out = [0];
    let y = p.groundStoreyM, k = 0;
    while (y < heightM - 0.5 && out.length < 400) {
        out.push(y);
        y += p.upperStoreysM[Math.min(k, p.upperStoreysM.length - 1)];
        k++;
    }
    return out;
}
