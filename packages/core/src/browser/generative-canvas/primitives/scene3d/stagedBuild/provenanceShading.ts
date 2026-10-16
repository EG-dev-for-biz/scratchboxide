/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The provenance view of a staged location build (design §7.4): every part shaded by how it was made.
 *
 *  - Hue is the kind (the label's legend colour); pattern marks a variant of a kind. Colours and patterns come from
 *    StagedBuildState.provenanceLegend, then the contract defaults; an unknown label gets neutral grey and its own
 *    legend row. Nothing here switches on a label.
 *  - Uncertainty never fades a colour: a screen-space dot pattern in the background colour breaks the surface up
 *    instead. A node with a confidence (photo-inferred, photo-corrected, fitted-unobserved) is dotted by
 *    0.6 × (1 − confidence); a node with a fit residual (fitted surfaces) by 0.6 × min(1, rms / 10 cm), its RMS
 *    shading. Measured residual colours stay on the outlines (cividis, 0–10 cm).
 *  - tile_refine's per-vertex provenance is read with the contract's own bands (classifyRemeshVertex's order:
 *    carved relief, then proud-block codes, then the displacement bands), never with an exact-zero test. Each
 *    displacement band keeps the remeshed hue; its pattern steps up with the band (solid, stripes, cross-hatch).
 *  - Degraded parts carry a vermillion hatch over their colour.
 *  - Lighting stays on, the background is #1c2026, and every legend colour keeps ≥ 3:1 contrast against it.
 */

import * as THREE from 'three';
import {
    DEFAULT_PROVENANCE_LEGEND,
    DEGRADED_OUTLINE_COLOR,
    PROUD_BLOCK_BANDS,
    PROVENANCE_BACKGROUND,
    RECTIFY_DISPLACEMENT_BANDS,
    RELIEF_HEIGHT_CARVED_MIN_M,
    TILE_REFINE_VERTEX_ATTRIBUTES,
    classifyRemeshVertex,
    type ProvenanceLabel,
    type ProvenanceLegendEntry,
    type ProvenanceRecord,
    type StagedBuildState,
    type VertexBand
} from '../../../../../common/spatial/staged-location-contracts';

/** Colour of a label no legend lists. */
export const UNKNOWN_LABEL_COLOR = '#C9CDD3';
/** Dot coverage at confidence 0 (and for unrated photo-inferred relief); solid at confidence 1. */
export const MAX_DOT_COVERAGE = 0.6;
/** Residual at which a fitted surface's RMS shading reaches full dot coverage (the outline scale's top). */
export const RMS_SHADING_FULL_M = 0.10;
/** Diagonal stripes: period (CSS px) and the share of each period drawn in the background colour. */
export const STRIPE_PERIOD_PX = 6;
export const STRIPE_COVERAGE = 0.35;

/** Shader pattern codes. A legend pattern word maps to one; an unknown word draws solid. */
export const PATTERN_CODE = { solid: 0, stripes: 1, crosshatch: 2, dots: 3 } as const;
const PATTERN_WORDS: Record<string, number> = { solid: 0, stripes: 1, crosshatch: 2, 'cross-hatch': 2, dots: 3 };

export function patternCode(pattern: string | undefined): number {
    return pattern !== undefined && pattern in PATTERN_WORDS ? PATTERN_WORDS[pattern] : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Colour math (sRGB, CIE Lab, WCAG contrast, Machado 2009 colour-vision simulation): used by the legend checks.
// ---------------------------------------------------------------------------------------------------------------

export type Rgb01 = [number, number, number];

export function hexToRgb01(hex: string): Rgb01 {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb01;
}

export function rgb01ToHex(rgb: Rgb01): string {
    return '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
}

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance(rgb: Rgb01): number {
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string | Rgb01, b: string | Rgb01): number {
    const la = relativeLuminance(typeof a === 'string' ? hexToRgb01(a) : a);
    const lb = relativeLuminance(typeof b === 'string' ? hexToRgb01(b) : b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Machado, Oliveira & Fernandes (2009), severity 1.0, applied to linear RGB. */
export const CVD_MATRICES: Record<'none' | 'protanopia' | 'deuteranopia' | 'tritanopia', number[][]> = {
    none: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
};

/** The linear RGB a viewer with the given colour vision sees for an sRGB colour. */
export function simulateCvdLinear(rgb: Rgb01, kind: keyof typeof CVD_MATRICES): Rgb01 {
    const lin = rgb.map(srgbToLinear);
    return CVD_MATRICES[kind].map(row => Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))) as Rgb01;
}

/** CIE L*a*b* (D65) of a linear RGB colour. */
export function linearToLab(lin: Rgb01): [number, number, number] {
    const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
    const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE76(a: [number, number, number], b: [number, number, number]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Cividis (Nuñez et al. 2018) at t ∈ [0, 1]: the fit-error scale of the outlines, 0–10 cm. */
const CIVIDIS_STOPS: Array<[number, string]> = [
    [0, '#00224e'], [0.125, '#123570'], [0.25, '#3b496c'], [0.375, '#575d6d'], [0.5, '#707173'],
    [0.625, '#8a8678'], [0.75, '#a59c74'], [0.875, '#c3b369'], [1, '#fee838']
];
export function cividis(t: number): string {
    const x = Math.min(1, Math.max(0, t));
    for (let i = 1; i < CIVIDIS_STOPS.length; i++) {
        const [t1, c1] = CIVIDIS_STOPS[i];
        const [t0, c0] = CIVIDIS_STOPS[i - 1];
        if (x <= t1) {
            const k = (x - t0) / (t1 - t0);
            const a = hexToRgb01(c0), b = hexToRgb01(c1);
            return rgb01ToHex([0, 1, 2].map(j => a[j] + (b[j] - a[j]) * k) as Rgb01);
        }
    }
    return CIVIDIS_STOPS[CIVIDIS_STOPS.length - 1][1];
}

// ---------------------------------------------------------------------------------------------------------------
// The legend
// ---------------------------------------------------------------------------------------------------------------

export interface LegendStyle extends ProvenanceLegendEntry {
    /** False for a label no legend lists (drawn in neutral grey). */
    known: boolean;
}

/** Every label the run uses, styled: the run's legend first, then the contract defaults, then neutral grey. */
export function resolveLegend(state: StagedBuildState | undefined, extraLabels: Iterable<ProvenanceLabel> = []): Map<ProvenanceLabel, LegendStyle> {
    const out = new Map<ProvenanceLabel, LegendStyle>();
    const run = new Map((state?.provenanceLegend ?? []).map(e => [e.label, e] as const));
    const defaults = new Map(DEFAULT_PROVENANCE_LEGEND.map(e => [e.label, e] as const));
    const labels: ProvenanceLabel[] = [];
    const add = (l: ProvenanceLabel | undefined | null) => { if (l && !labels.includes(l)) labels.push(l); };
    for (const e of state?.provenanceLegend ?? []) add(e.label);
    for (const layer of state?.layers ?? []) {
        add(layer.provenance.label);
        layer.provenanceLabels.forEach(add);
    }
    for (const d of state?.degradations ?? []) add(d.provenanceAfter);
    for (const l of extraLabels) add(l);
    for (const label of labels) {
        const r = run.get(label);
        const d = defaults.get(label);
        out.set(label, {
            label,
            color: r?.color ?? d?.color ?? UNKNOWN_LABEL_COLOR,
            pattern: r?.pattern ?? d?.pattern ?? 'solid',
            description: r?.description ?? '',
            known: !!(r || d)
        });
    }
    return out;
}

export function styleFor(label: ProvenanceLabel, legend: Map<ProvenanceLabel, LegendStyle>): LegendStyle {
    return legend.get(label) ?? { label, color: UNKNOWN_LABEL_COLOR, pattern: 'solid', description: '', known: false };
}

/**
 * Dot coverage that shows a node's uncertainty: from its confidence when it has one (photo inference, photo
 * corrections, unobserved faces), else from its fit residual (fitted surfaces); 0 for measured scan geometry.
 */
export function uncertaintyCoverage(provenance: ProvenanceRecord | undefined, fitRmsM?: number): number {
    if (provenance?.confidence !== undefined && Number.isFinite(provenance.confidence)) {
        return MAX_DOT_COVERAGE * (1 - Math.min(1, Math.max(0, provenance.confidence)));
    }
    const rms = fitRmsM ?? provenance?.residual?.rmsM;
    if (rms !== undefined && Number.isFinite(rms)) return MAX_DOT_COVERAGE * Math.min(1, Math.max(0, rms / RMS_SHADING_FULL_M));
    return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-vertex classes for tile_refine's attributes (classifyRemeshVertex's reading, as shader code)
// ---------------------------------------------------------------------------------------------------------------

/** three's GLTFLoader lowercases custom attribute names (`_RELIEF_HEIGHT` → `_relief_height`). */
export const VERTEX_ATTRIBUTE = {
    reliefHeight: TILE_REFINE_VERTEX_ATTRIBUTES.reliefHeight.toLowerCase(),
    proudBlock: TILE_REFINE_VERTEX_ATTRIBUTES.proudBlock.toLowerCase(),
    rectifyDisplacement: TILE_REFINE_VERTEX_ATTRIBUTES.rectifyDisplacement.toLowerCase()
} as const;

/** One shading class: index 0 is the node's own label; the rest come from the contract bands. */
export interface ShadingClass {
    /** "node", "relief-inferred", or the contract band's name: a legend row key, never read by the shader. */
    key: string;
    label: ProvenanceLabel | null;
    patternCode: number;
    /** Dot coverage when patternCode is dots. */
    coverage: number;
    description: string;
}

/** Hatch level of displacement band i: the bands go solid, stripes, cross-hatch as the scan moved more. */
function bandPattern(i: number): number {
    return [PATTERN_CODE.solid, PATTERN_CODE.stripes, PATTERN_CODE.crosshatch][Math.min(i, 2)];
}

/** The class table the provenance shader indexes; built from the contract's bands, so it follows any change to them. */
export function shadingClasses(legend: Map<ProvenanceLabel, LegendStyle>): ShadingClass[] {
    const classes: ShadingClass[] = [{ key: 'node', label: null, patternCode: 0, coverage: 0, description: "the node's own provenance" }];
    // classifyRemeshVertex's reading: a carved relief vertex is photo-inferred.
    const photo = styleFor(classifyRemeshVertex({ reliefHeightM: 1 }).label, legend);
    classes.push({
        key: 'relief-inferred', label: photo.label, patternCode: PATTERN_CODE.dots, coverage: MAX_DOT_COVERAGE,
        description: "carved by tile_refine's photo relief: inferred from the photo, unrated"
    });
    for (const b of PROUD_BLOCK_BANDS) {
        const s = styleFor(b.label, legend);
        classes.push({ key: b.band, label: b.label, patternCode: patternCode(s.pattern), coverage: 0, description: b.description });
    }
    RECTIFY_DISPLACEMENT_BANDS.forEach((b, i) => {
        classes.push({ key: b.band, label: b.label, patternCode: bandPattern(i), coverage: 0, description: b.description });
    });
    return classes;
}

const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

function bandTest(variable: string, b: VertexBand): string {
    return b.maxM === undefined ? `${variable} >= ${glslFloat(b.minM)}` : `${variable} >= ${glslFloat(b.minM)} && ${variable} < ${glslFloat(b.maxM)}`;
}

/** Vertex-shader code that sets `sbClass` from the attributes, generated from the contract bands. */
export function vertexClassGlsl(): string {
    const proudBase = 2;
    const dispBase = proudBase + PROUD_BLOCK_BANDS.length;
    const proud = PROUD_BLOCK_BANDS.map((b, i) => `if (${bandTest('_proud_block', b)}) { sbClass = ${glslFloat(proudBase + i)}; sbClassified = true; }`).join(' else ');
    const disp = RECTIFY_DISPLACEMENT_BANDS.map((b, i) => `if (${bandTest('sbDispAbs', b)}) { sbClass = ${glslFloat(dispBase + i)}; }`).join(' else ');
    return `
    float sbClass = 0.0;
    bool sbClassified = false;
    if (uSbHasRelief > 0.5 && abs(_relief_height) >= ${glslFloat(RELIEF_HEIGHT_CARVED_MIN_M)}) { sbClass = 1.0; sbClassified = true; }
    if (!sbClassified && uSbHasProud > 0.5) { ${proud} }
    if (!sbClassified && uSbHasRectify > 0.5) { float sbDispAbs = abs(_rectify_displacement); ${disp} }
    vSbClass = sbClass;`;
}

/** Linear-RGB uniform values for each class, with the node's own colour in slot 0. */
export function classUniforms(classes: ShadingClass[], legend: Map<ProvenanceLabel, LegendStyle>, nodeColor: string, nodeCoverage: number, nodePattern: number): { colors: THREE.Color[]; patterns: THREE.Vector2[] } {
    const colors = classes.map((c, i) => new THREE.Color(i === 0 ? nodeColor : styleFor(c.label ?? '', legend).color));
    const patterns = classes.map((c, i) => (i === 0 ? new THREE.Vector2(nodePattern, nodeCoverage) : new THREE.Vector2(c.patternCode, c.coverage)));
    return { colors, patterns };
}

/** The provenance-mode background, as a THREE colour. */
export function provenanceBackground(): THREE.Color {
    return new THREE.Color(PROVENANCE_BACKGROUND);
}

export { DEGRADED_OUTLINE_COLOR, PROVENANCE_BACKGROUND };

// ---------------------------------------------------------------------------------------------------------------
// Legend rows for the overlay
// ---------------------------------------------------------------------------------------------------------------

export interface LegendRow {
    key: string;
    label: ProvenanceLabel;
    color: string;
    pattern: string;
    /** Words for the row: the label, then the run's own description or the band's. */
    text: string;
    /** A count from the run (vertices in a band), when known. */
    count?: number;
    unknown?: boolean;
    indent?: boolean;
}

const PATTERN_NAME = ['solid', 'stripes', 'crosshatch', 'dots'];

/**
 * The legend the overlay shows: one row per label the run uses (with the run's per-run description), sub-rows for
 * tile_refine's per-vertex bands with the run's own vertex counts, and the scales for uncertainty and fit error.
 */
export function legendRows(state: StagedBuildState, legend: Map<ProvenanceLabel, LegendStyle>, opts: { hasOutlines?: boolean } = {}): LegendRow[] {
    const rows: LegendRow[] = [];
    for (const s of legend.values()) {
        rows.push({ key: `label:${s.label}`, label: s.label, color: s.color, pattern: s.pattern, text: s.description ? `${s.label}: ${s.description}` : s.label, ...(s.known ? {} : { unknown: true }) });
    }
    const classes = shadingClasses(legend);
    const vp = state.layers.find(l => l.vertexProvenance)?.vertexProvenance;
    if (vp) {
        const relief = classes.find(c => c.key === 'relief-inferred')!;
        if (vp.relief && vp.relief.carvedVertices > 0) {
            rows.push({ key: 'band:relief-inferred', label: relief.label!, color: styleFor(relief.label!, legend).color, pattern: 'dots', text: `relief-inferred: ${relief.description} (max ${(vp.relief.maxAbsHeightM * 100).toFixed(1)} cm)`, count: vp.relief.carvedVertices, indent: true });
        }
        if (vp.proudBlocks) {
            PROUD_BLOCK_BANDS.forEach((b, i) => {
                const n = i === 0 ? vp.proudBlocks!.keptAsScannedVertices : vp.proudBlocks!.snappedVertices;
                if (n > 0) rows.push({ key: `band:${b.band}`, label: b.label, color: styleFor(b.label, legend).color, pattern: styleFor(b.label, legend).pattern, text: `${b.label}: ${b.description}`, count: n, indent: true });
            });
        }
        for (const band of vp.rectifyDisplacement?.bands ?? []) {
            const i = RECTIFY_DISPLACEMENT_BANDS.findIndex(b => b.minM === band.minM && b.maxM === band.maxM);
            const contract = RECTIFY_DISPLACEMENT_BANDS[i];
            if (!contract) continue;
            rows.push({ key: `band:${contract.band}`, label: contract.label, color: styleFor(contract.label, legend).color, pattern: PATTERN_NAME[bandPattern(i)], text: `${contract.band}: ${contract.description}`, count: band.vertices, indent: true });
        }
    }
    rows.push({ key: 'scale:uncertainty', label: 'uncertainty', color: '#d4d4d8', pattern: 'dots', text: `dots break a surface up by its uncertainty: ${Math.round(MAX_DOT_COVERAGE * 100)}% at confidence 0 or a fit RMS of ${RMS_SHADING_FULL_M * 100} cm, solid at confidence 1 or 0 cm` });
    if (opts.hasOutlines) rows.push({ key: 'scale:fit-error', label: 'fit error', color: cividis(1), pattern: 'cividis', text: `outlines: local fit error, cividis 0 cm (${cividis(0)}) to ${RMS_SHADING_FULL_M * 100} cm (${cividis(1)})` });
    if (state.degradations.length > 0) rows.push({ key: 'degraded', label: 'degraded', color: DEGRADED_OUTLINE_COLOR, pattern: 'hatch', text: `degraded parts (${state.degradations.length}): vermillion hatch over the rung they fell to` });
    return rows;
}
