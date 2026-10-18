/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measured sun / ambient shading for solar de-lighting.
 *
 * Shading model of a texel lit by a known sun: I = rho * s * (max(0, N.L) + k * A(N)), with rho the albedo, s the sun
 * irradiance, A(N) the relative angular shape of the sky light (1 when no sky radiance is known) and k the
 * ambient-to-sun irradiance ratio. Only k matters for de-lighting (s is an overall scale), and k is read from the image:
 * texels are grouped into cells by chart (the albedo is assumed piecewise constant per chart) and by N.L bin, and k is
 * the value whose model makes the de-lit albedo of each chart the same in every bin it covers (least squares on the
 * cells' median log luminance, the chart albedos profiled out). The fit is refused, with the reason, when the data do
 * not pin k down: too few shaded or lit texels on charts that see both, a best fit at the search limit, or a k
 * uncertain by more than `maxLogSigma`.
 */

export interface SolarShadingFitInput {
    /** Linear luminance of each sample. */
    luminance: ArrayLike<number>;
    /** max(0, N . L) of each sample's geometry normal with the sun. */
    cosSun: ArrayLike<number>;
    /** Relative sky irradiance of each sample's normal (1 everywhere when omitted). */
    ambientShape?: ArrayLike<number>;
    /** Chart of each sample; samples of one chart are assumed to share an albedo distribution. Negative = not used in the fit. */
    group: ArrayLike<number>;
}

export interface SolarShadingFitOptions {
    /** Samples per (chart, N.L bin) cell needed for the cell to enter the fit (default 16). */
    minCellSamples?: number;
    /** Shaded and lit samples each needed on charts that contain both (default 64). */
    minSamplesPerSide?: number;
    /** Largest accepted standard error of ln k (default 0.3, about +-35 %). */
    maxLogSigma?: number;
}

export interface SolarShadingFitDiagnostics {
    /** Cells (chart x N.L bin) with enough samples. */
    cells: number;
    /** Charts with cells in at least two N.L bins (the only ones that constrain k). */
    charts: number;
    /** Samples in the shaded bin (N.L <= 0.02) on charts that also have a lit cell. */
    shadedSamples: number;
    /** Samples in lit bins (mean N.L >= 0.3) on charts that also have a shaded cell. */
    litSamples: number;
}

export interface SolarShadingFit extends SolarShadingFitDiagnostics {
    status: 'fitted';
    /** Measured ambient-to-sun irradiance ratio k. */
    ambientToSun: number;
    /** Standard error of ln k from the curvature of the fit. */
    logSigma: number;
    /** RMS of the cell residuals in ln luminance. */
    rmsLogResidual: number;
    /** Mean of E = N.L+ + k A over all samples: de-lit = observed * meanIrradiance / E keeps the overall brightness. */
    meanIrradiance: number;
    /**
     * Largest gain the data support: the largest gain any fitted cell needs to reach its chart's albedo, times
     * exp(2 * rmsLogResidual). Texels whose model gain is larger are capped there.
     */
    gainCap: number;
}

export interface SolarShadingSkip extends SolarShadingFitDiagnostics {
    status: 'skipped';
    reason: string;
}

export type SolarShadingFitResult = SolarShadingFit | SolarShadingSkip;

const SHADED_COS = 0.02;
const LIT_BINS = 8;
const LIT_COS = 0.3;

function binOf(c: number): number {
    if (!(c > SHADED_COS)) return 0;
    return 1 + Math.min(LIT_BINS - 1, Math.floor(((c - SHADED_COS) / (1 - SHADED_COS)) * LIT_BINS));
}

/** Fits the ambient-to-sun ratio k of the shading model to the samples (see the module comment). */
export function fitSolarShading(input: SolarShadingFitInput, options: SolarShadingFitOptions = {}): SolarShadingFitResult {
    const minCell = options.minCellSamples ?? 16;
    const minSide = options.minSamplesPerSide ?? 64;
    const maxLogSigma = options.maxLogSigma ?? 0.3;
    const n = input.luminance.length;
    const A = input.ambientShape;

    // Cells keyed by chart and bin
    const cellOf = new Int32Array(n).fill(-1);
    const keyToCell = new Map<number, number>();
    const cellChart: number[] = [];
    const cellBin: number[] = [];
    const cellCount: number[] = [];
    let eSum = 0, eN = 0;
    for (let i = 0; i < n; i++) {
        const g = input.group[i];
        if (!(g >= 0)) continue;
        const b = binOf(input.cosSun[i]);
        const key = g * (LIT_BINS + 1) + b;
        let c = keyToCell.get(key);
        if (c === undefined) {
            c = cellChart.length;
            keyToCell.set(key, c);
            cellChart.push(g); cellBin.push(b); cellCount.push(0);
        }
        cellOf[i] = c;
        cellCount[c]++;
    }
    const nCells = cellChart.length;
    const start = new Int32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) start[c + 1] = start[c] + cellCount[c];
    const fill = start.slice(0, nCells);
    const logY = new Float64Array(start[nCells]);
    const cosSum = new Float64Array(nCells);
    const ambSum = new Float64Array(nCells);
    for (let i = 0; i < n; i++) {
        const c = cellOf[i];
        if (c < 0) continue;
        logY[fill[c]++] = Math.log(Math.max(1e-4, input.luminance[i]));
        cosSum[c] += Math.max(0, input.cosSun[i]);
        ambSum[c] += A ? A[i] : 1;
    }

    // Cells with enough samples, on charts spanning at least two bins
    const used: number[] = [];
    const binsOfChart = new Map<number, Set<number>>();
    for (let c = 0; c < nCells; c++) {
        if (cellCount[c] < minCell) continue;
        if (!binsOfChart.has(cellChart[c])) binsOfChart.set(cellChart[c], new Set());
        binsOfChart.get(cellChart[c])!.add(cellBin[c]);
    }
    const lit = (c: number) => cellBin[c] > 0 && cosSum[c] / cellCount[c] >= LIT_COS;
    const hasShaded = new Set<number>(), hasLit = new Set<number>();
    for (let c = 0; c < nCells; c++) {
        if (cellCount[c] < minCell) continue;
        if (cellBin[c] === 0) hasShaded.add(cellChart[c]);
        else if (lit(c)) hasLit.add(cellChart[c]);
    }
    const chartsBoth = new Set([...hasShaded].filter(g => hasLit.has(g)));
    let shadedSamples = 0, litSamples = 0;
    const median = new Float64Array(nCells);
    for (let c = 0; c < nCells; c++) {
        if (cellCount[c] < minCell || (binsOfChart.get(cellChart[c])?.size ?? 0) < 2) continue;
        used.push(c);
        const s = logY.subarray(start[c], start[c + 1]).sort();
        const m = s.length >> 1;
        median[c] = s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
        if (chartsBoth.has(cellChart[c])) {
            if (cellBin[c] === 0) shadedSamples += cellCount[c];
            else if (lit(c)) litSamples += cellCount[c];
        }
    }
    const charts = new Set(used.map(c => cellChart[c])).size;
    const diag: SolarShadingFitDiagnostics = { cells: used.length, charts, shadedSamples, litSamples };
    if (shadedSamples < minSide || litSamples < minSide) {
        return { status: 'skipped', ...diag, reason: `too few texels on charts that are seen both facing the sun and turned away from it (${shadedSamples} shaded, ${litSamples} lit; ${minSide} of each needed), so the ambient-to-sun ratio cannot be measured` };
    }

    const chartIdx = new Map<number, number>();
    for (const c of used) if (!chartIdx.has(cellChart[c])) chartIdx.set(cellChart[c], chartIdx.size);
    const G = chartIdx.size;
    const cg = used.map(c => chartIdx.get(cellChart[c])!);
    const cbar = used.map(c => cosSum[c] / cellCount[c]);
    const abar = used.map(c => ambSum[c] / cellCount[c]);
    const l = used.map(c => median[c]);
    const rho = new Float64Array(G);
    const cnt = new Float64Array(G);
    const ss = (logK: number): number => {
        const k = Math.exp(logK);
        rho.fill(0); cnt.fill(0);
        for (let j = 0; j < used.length; j++) { rho[cg[j]] += l[j] - Math.log(cbar[j] + k * abar[j]); cnt[cg[j]]++; }
        for (let g = 0; g < G; g++) rho[g] /= cnt[g];
        let s = 0;
        for (let j = 0; j < used.length; j++) { const r = l[j] - Math.log(cbar[j] + k * abar[j]) - rho[cg[j]]; s += r * r; }
        return s;
    };

    // Grid then golden-section search over ln k
    const LO = Math.log(0.005), HI = Math.log(20), STEPS = 240;
    let best = 0, bestSs = Infinity;
    for (let s = 0; s <= STEPS; s++) {
        const v = ss(LO + ((HI - LO) * s) / STEPS);
        if (v < bestSs) { bestSs = v; best = s; }
    }
    if (best === 0 || best === STEPS) {
        return { status: 'skipped', ...diag, reason: `the shading fit is best at the ${best === 0 ? 'lower' : 'upper'} search limit of the ambient-to-sun ratio (${Math.exp(best === 0 ? LO : HI).toFixed(3)}), so the data do not bound it` };
    }
    let a = LO + ((HI - LO) * (best - 1)) / STEPS, b = LO + ((HI - LO) * (best + 1)) / STEPS;
    const phi = (Math.sqrt(5) - 1) / 2;
    let x1 = b - phi * (b - a), x2 = a + phi * (b - a), f1 = ss(x1), f2 = ss(x2);
    for (let it = 0; it < 60; it++) {
        if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - phi * (b - a); f1 = ss(x1); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + phi * (b - a); f2 = ss(x2); }
    }
    const logK = 0.5 * (a + b);
    const ssMin = ss(logK);
    const dof = used.length - G - 1;
    if (dof < 1) {
        return { status: 'skipped', ...diag, reason: `${used.length} cells over ${G} charts leave no degree of freedom to measure the ambient-to-sun ratio` };
    }
    const sigma2 = ssMin / dof;
    const h = 0.05;
    const curvature = (ss(logK + h) - 2 * ssMin + ss(logK - h)) / (h * h);
    const logSigma = curvature > 0 ? Math.sqrt((2 * sigma2) / curvature) : Infinity;
    if (!(logSigma <= maxLogSigma)) {
        return { status: 'skipped', ...diag, reason: `the ambient-to-sun ratio is poorly determined (k = ${Math.exp(logK).toFixed(3)}, standard error of ln k ${Number.isFinite(logSigma) ? logSigma.toFixed(2) : 'unbounded'} > ${maxLogSigma})` };
    }
    const k = Math.exp(logK);
    ss(logK); // leaves rho at the fitted value
    const rms = Math.sqrt(ssMin / used.length);

    for (let i = 0; i < n; i++) {
        if (!(input.group[i] >= 0)) continue;
        eSum += Math.max(0, input.cosSun[i]) + k * (A ? A[i] : 1);
        eN++;
    }
    const meanIrradiance = eN ? eSum / eN : 1;
    let maxCellGain = 0;
    for (let j = 0; j < used.length; j++) maxCellGain = Math.max(maxCellGain, Math.exp(rho[cg[j]] - l[j]) * meanIrradiance);
    return {
        status: 'fitted', ...diag,
        ambientToSun: k, logSigma, rmsLogResidual: rms, meanIrradiance,
        gainCap: maxCellGain * Math.exp(2 * rms)
    };
}

/**
 * Labels the 4-connected components of the texels with a geometry normal (`has[i]`), the charts of the shading fit.
 * Returns -1 for texels without a normal.
 */
export function labelTexelCharts(has: ArrayLike<boolean | number>, width: number, height: number): Int32Array {
    const label = new Int32Array(width * height).fill(-1);
    const stack: number[] = [];
    let next = 0;
    for (let s = 0; s < width * height; s++) {
        if (!has[s] || label[s] >= 0) continue;
        label[s] = next;
        stack.push(s);
        while (stack.length) {
            const t = stack.pop()!;
            const x = t % width, y = (t - x) / width;
            const visit = (u: number) => { if (has[u] && label[u] < 0) { label[u] = next; stack.push(u); } };
            if (x > 0) visit(t - 1);
            if (x < width - 1) visit(t + 1);
            if (y > 0) visit(t - width);
            if (y < height - 1) visit(t + width);
        }
        next++;
    }
    return label;
}
