/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Plausibility of measured built dimensions: a shared check, not a tool.
 *
 * Each range is keyed by the dimension that was measured (a storey height, a door height, a step riser, a building's
 * height...), never by what kind of building it is: the same storey-height range applies to a house, a warehouse or a
 * structure nobody has a name for. A range is continuous: a typical span, and a wider span of what is still built. A
 * value outside the typical span is flagged `unusual`; one outside the wider span is flagged `implausible`, with the
 * probable cause the caller names (a fit, a grammar reading, the vector data...).
 *
 * Flags only: nothing here inserts, clamps or changes a value. Callers attach the flags beside the values they measured
 * and mention the warnings in their summary.
 */

/** The measured dimension a range is keyed by (open: a caller may check any dimension it gives a range for). */
export type PlausibleDimension =
    | 'storeyHeight' | 'groundStoreyHeight' | 'doorHeight' | 'stepRiser' | 'windowHeight' | 'windowWidth'
    | 'parapetHeight' | 'bayWidth' | 'buildingHeight' | (string & {});

export interface DimensionRange {
    /** Words for the dimension in a message ("storey height"). */
    noun: string;
    /** Where most built examples lie (m). */
    typical: [number, number];
    /** Outside this, the value is very unlikely to be a real built dimension (m). */
    possible: [number, number];
}

/**
 * The ranges, in metres. Typical spans follow common construction practice across building ages and uses; the possible
 * spans admit the unusual (a double-height banking hall storey, a cathedral portal, a stair in a garden wall).
 */
export const DIMENSION_RANGES: Readonly<Record<string, DimensionRange>> = {
    storeyHeight: { noun: 'storey height', typical: [2.6, 5.0], possible: [2.1, 8.0] },
    /** A ground storey may be taller (a shopfront, a lobby, a former stable). */
    groundStoreyHeight: { noun: 'ground storey height', typical: [2.6, 7.0], possible: [2.1, 10.0] },
    doorHeight: { noun: 'door height', typical: [1.9, 3.0], possible: [1.6, 9.0] },
    stepRiser: { noun: 'step riser', typical: [0.13, 0.22], possible: [0.08, 0.3] },
    windowHeight: { noun: 'window height', typical: [0.6, 3.0], possible: [0.25, 9.0] },
    windowWidth: { noun: 'window width', typical: [0.4, 2.6], possible: [0.15, 7.0] },
    parapetHeight: { noun: 'parapet height', typical: [0.3, 1.5], possible: [0.1, 4.0] },
    /** Centre-to-centre spacing of repeated openings along a facade. */
    bayWidth: { noun: 'bay width', typical: [1.2, 6.0], possible: [0.7, 15.0] },
    /** From its ground to its main roof. */
    buildingHeight: { noun: 'building height', typical: [2.5, 350], possible: [2.0, 830] }
};

/** unusual: outside the typical span, inside what is still built; implausible: outside that too. Open literal. */
export type PlausibilitySeverity = 'unusual' | 'implausible' | (string & {});

export interface PlausibilityFlag {
    dimension: PlausibleDimension;
    /** What was measured, as the caller names it ("facade 3, storey 2", "vector height"). */
    label: string;
    valueM: number;
    typicalRangeM: [number, number];
    possibleRangeM: [number, number];
    severity: PlausibilitySeverity;
    message: string;
}

export interface CheckOptions {
    /** What was measured ("facade 3 storey 2"); default the dimension's noun. */
    label?: string;
    /** The probable cause named in an implausible flag's message ("fit or grammar", "vector data"); default "measurement". */
    cause?: string;
    /** A range for a dimension not in DIMENSION_RANGES, or one that replaces it. */
    range?: DimensionRange;
}

const fmt = (v: number): string => {
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : 2;
    return v.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};
const span = (r: [number, number]) => `${fmt(r[0])}–${fmt(r[1])} m`;

/** The range of a dimension, or undefined when none is known for it. */
export function rangeOf(dimension: PlausibleDimension, override?: DimensionRange): DimensionRange | undefined {
    return override ?? DIMENSION_RANGES[dimension];
}

/**
 * One measured value against its dimension's range. Returns a flag when it lies outside the typical span (undefined
 * inside it, for a non-finite value, or for a dimension with no range). Never changes the value.
 */
export function checkDimension(dimension: PlausibleDimension, valueM: number, opts: CheckOptions = {}): PlausibilityFlag | undefined {
    const r = rangeOf(dimension, opts.range);
    if (!r || !Number.isFinite(valueM)) return undefined;
    const [lo, hi] = r.typical;
    if (valueM >= lo && valueM <= hi) return undefined;
    const implausible = valueM < r.possible[0] || valueM > r.possible[1];
    const label = opts.label ?? r.noun;
    const what = label === r.noun ? r.noun : `${label} (${r.noun})`;
    const message = implausible
        ? `${what} ${fmt(valueM)} m is outside ${span(r.typical)}: probable ${opts.cause ?? 'measurement'} error`
        : `${what} ${fmt(valueM)} m is outside ${span(r.typical)}: unusual, though still built; check the ${opts.cause ?? 'measurement'}`;
    return { dimension, label, valueM: Math.round(valueM * 1000) / 1000, typicalRangeM: [lo, hi], possibleRangeM: [r.possible[0], r.possible[1]], severity: implausible ? 'implausible' : 'unusual', message };
}

/** Several values; the flags of those outside their typical span, in order. */
export function checkDimensions(items: Array<{ dimension: PlausibleDimension; valueM: number | undefined } & CheckOptions>): PlausibilityFlag[] {
    const out: PlausibilityFlag[] = [];
    for (const it of items) {
        if (it.valueM === undefined) continue;
        const f = checkDimension(it.dimension, it.valueM, it);
        if (f) out.push(f);
    }
    return out;
}

/**
 * A building's height against a storey count: the mean storey height it implies, with the ground storey allowed its
 * taller range and a roof allowance (a parapet's possible span at most) above the top storey. Flags the implied mean
 * storey height when the height is less than the storeys could be, or more than they and the roof could reach.
 */
export function checkHeightForStoreys(heightM: number, storeys: number, opts: { label?: string; cause?: string } = {}): PlausibilityFlag | undefined {
    if (!Number.isFinite(heightM) || !Number.isFinite(storeys) || storeys < 1) return undefined;
    const n = Math.round(storeys);
    const st = DIMENSION_RANGES.storeyHeight, gs = DIMENSION_RANGES.groundStoreyHeight, pp = DIMENSION_RANGES.parapetHeight;
    // the total the storeys span: lowest = every storey at its least; highest = a tall ground storey, the rest at their most, and a parapet
    const typical: [number, number] = [n * st.typical[0], gs.typical[1] + (n - 1) * st.typical[1] + pp.typical[1]];
    const possible: [number, number] = [n * st.possible[0], gs.possible[1] + (n - 1) * st.possible[1] + pp.possible[1]];
    if (heightM >= typical[0] && heightM <= typical[1]) return undefined;
    const implausible = heightM < possible[0] || heightM > possible[1];
    const label = opts.label ?? 'building height';
    const mean = heightM / n;
    const message = `${label} ${fmt(heightM)} m for ${n} storey${n === 1 ? '' : 's'} (${fmt(mean)} m a storey) is outside ${span(typical)}: `
        + (implausible ? `probable ${opts.cause ?? 'height or storey count'} error` : `unusual, though still built; check the ${opts.cause ?? 'height or storey count'}`);
    return {
        dimension: 'buildingHeight', label: `${label} for ${n} storey${n === 1 ? '' : 's'}`, valueM: Math.round(heightM * 1000) / 1000,
        typicalRangeM: [Math.round(typical[0] * 100) / 100, Math.round(typical[1] * 100) / 100], possibleRangeM: [Math.round(possible[0] * 100) / 100, Math.round(possible[1] * 100) / 100],
        severity: implausible ? 'implausible' : 'unusual', message
    };
}

/** A one-line mention of the flags for a summary ("" when there are none). */
export function plausibilitySummary(flags: readonly PlausibilityFlag[], max = 3): string {
    if (!flags.length) return '';
    const shown = flags.slice(0, max).map(f => f.message).join('; ');
    return `plausibility: ${flags.length} warning${flags.length === 1 ? '' : 's'} (${shown}${flags.length > max ? `; and ${flags.length - max} more` : ''})`;
}
