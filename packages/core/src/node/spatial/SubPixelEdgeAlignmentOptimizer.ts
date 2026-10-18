/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface CameraPose6DOF {
    x: number;
    y: number;
    z: number;
    targetX: number;
    targetY: number;
    targetZ: number;
    fov: number; // horizontal or vertical FOV in degrees
    k1?: number; // Brown-Conrady radial distortion
    /** Optional camera up hint (world space); defaults to +Y. Lets callers express roll. */
    up?: [number, number, number];
}

export interface SobelEdgeField {
    width: number;
    height: number;
    magnitudes: Float32Array;
    gradX: Float32Array;
    gradY: Float32Array;
    meanMagnitude: number;
}

export interface EdgeOverlapEvaluation {
    overlapScorePercent: number;
    /** Mean distance in pixels from the render's edges to the nearest strong reference edge (see meanEdgeDistancePx). */
    residualPx: number;
    edgeCount: number;
}

export interface EdgeAlignmentMetrics {
    overlapScorePercent: number; // 0.0 to 100.0%: normalized cross-correlation of the edge magnitudes
    /** Measured: mean distance in pixels from the best render's edges to the nearest strong reference edge (chamfer). */
    subpixelResidualPx: number;
    /** That mean edge distance projected to the camera-to-target distance, in millimetres (a size, not a guarantee). */
    metrologicalErrorMm: number;
    edgePointCount: number;
    converged: boolean;
    iterations: number;
    finalPose: CameraPose6DOF;
}

export interface OptimizationOptions {
    maxIterations?: number;
    targetOverlapScore?: number; // defaults to 99.9%
    subpixelTolerancePx?: number; // defaults to 0.10 px
    learningRate?: number;
    optimizeK1?: boolean;
    stepSizes?: {
        pos?: number;
        target?: number;
        fov?: number;
        k1?: number;
    };
}

/**
 * Computes 2D horizontal (Gx) and vertical (Gy) Sobel spatial gradients from grayscale luminance data.
 */
export function computeSobelField(
    width: number,
    height: number,
    grayscale: Uint8Array | Uint8ClampedArray | Float32Array
): SobelEdgeField {
    const size = width * height;
    const gradX = new Float32Array(size);
    const gradY = new Float32Array(size);
    const magnitudes = new Float32Array(size);
    let totalMag = 0.0;

    for (let y = 1; y < height - 1; y++) {
        const rowOffset = y * width;
        const prevRow = (y - 1) * width;
        const nextRow = (y + 1) * width;

        for (let x = 1; x < width - 1; x++) {
            // Sobel 3x3 Kernels
            // Kx = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]
            // Ky = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]]
            const p00 = grayscale[prevRow + x - 1];
            const p01 = grayscale[prevRow + x];
            const p02 = grayscale[prevRow + x + 1];
            const p10 = grayscale[rowOffset + x - 1];
            const p12 = grayscale[rowOffset + x + 1];
            const p20 = grayscale[nextRow + x - 1];
            const p21 = grayscale[nextRow + x];
            const p22 = grayscale[nextRow + x + 1];

            const gx = (p02 + 2.0 * p12 + p22) - (p00 + 2.0 * p10 + p20);
            const gy = (p20 + 2.0 * p21 + p22) - (p00 + 2.0 * p01 + p02);

            const mag = Math.sqrt(gx * gx + gy * gy);
            const idx = rowOffset + x;
            gradX[idx] = gx;
            gradY[idx] = gy;
            magnitudes[idx] = mag;
            totalMag += mag;
        }
    }

    return {
        width,
        height,
        magnitudes,
        gradX,
        gradY,
        meanMagnitude: totalMag / size
    };
}

/** Distance maps to each reference field's strong edges, computed once per field. */
const strongEdgeDistanceCache = new WeakMap<SobelEdgeField, Float32Array>();

/**
 * Chamfer distance (pixels) from every pixel to the nearest strong edge of `field`: a pixel in the top 10% of the
 * field's non-zero gradient magnitudes or at least a quarter of its largest one (the rule model edges use, so a
 * field measured against itself is at distance 0). Two-pass 3x3 distance transform; cached per field.
 */
export function strongEdgeDistanceMap(field: SobelEdgeField): Float32Array {
    const cached = strongEdgeDistanceCache.get(field);
    if (cached) return cached;
    const { width, height, magnitudes } = field;
    const nonZero = Array.from(magnitudes).filter(v => v > 0).sort((a, b) => a - b);
    const threshold = nonZero.length ? Math.min(nonZero[Math.floor(nonZero.length * 0.9)], nonZero[nonZero.length - 1] * 0.25) : Infinity;
    const INF = 1e9;
    const dist = new Float32Array(width * height);
    for (let i = 0; i < dist.length; i++) dist[i] = magnitudes[i] >= threshold && magnitudes[i] > 0 ? 0 : INF;
    const D = Math.SQRT2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
        if (y > 0) {
            dist[i] = Math.min(dist[i], dist[i - width] + 1);
            if (x > 0) dist[i] = Math.min(dist[i], dist[i - width - 1] + D);
            if (x < width - 1) dist[i] = Math.min(dist[i], dist[i - width + 1] + D);
        }
    }
    for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
        if (y < height - 1) {
            dist[i] = Math.min(dist[i], dist[i + width] + 1);
            if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + width + 1] + D);
            if (x > 0) dist[i] = Math.min(dist[i], dist[i + width - 1] + D);
        }
    }
    strongEdgeDistanceCache.set(field, dist);
    return dist;
}

/**
 * Mean distance in pixels from each edge pixel of `model` (at least a quarter of its largest gradient: silhouette and
 * depth steps, not gentle shading) to the nearest strong edge of `reference`. NaN when the model has no edge pixel
 * or the reference no strong edge: nothing was measured.
 */
export function meanEdgeDistancePx(reference: SobelEdgeField, model: SobelEdgeField): { meanPx: number; modelEdgePixels: number } {
    if (reference.width !== model.width || reference.height !== model.height) {
        throw new Error(`Dimension mismatch: reference ${reference.width}x${reference.height} vs model ${model.width}x${model.height}`);
    }
    const dist = strongEdgeDistanceMap(reference);
    let modelMax = 0;
    for (let i = 0; i < model.magnitudes.length; i++) modelMax = Math.max(modelMax, model.magnitudes[i]);
    const modelThreshold = modelMax * 0.25;
    let sum = 0, count = 0;
    for (let i = 0; i < model.magnitudes.length; i++) {
        const m = model.magnitudes[i];
        if (m > 0 && m >= modelThreshold && dist[i] < 1e9) { sum += dist[i]; count++; }
    }
    return { meanPx: count ? sum / count : NaN, modelEdgePixels: count };
}

/**
 * The edge correlation (normalized cross-correlation of the salient edge magnitudes, as a percentage) between two
 * edge fields (e.g. a reference photograph and a 3D render), and the measured mean distance from the render's edges
 * to the nearest strong reference edge. With no edges to compare, the overlap is 0 and the residual NaN (unmeasured).
 */
export function evaluateEdgeOverlap(
    queryField: SobelEdgeField,
    renderField: SobelEdgeField,
    thresholdRatio: number = 0.25
): { overlapScorePercent: number; residualPx: number; edgeCount: number } {
    const c = edgeCorrelation(queryField, renderField, thresholdRatio);
    return c.edgeCount === 0
        ? { overlapScorePercent: 0.0, residualPx: NaN, edgeCount: 0 }
        : { overlapScorePercent: c.overlapScorePercent, residualPx: meanEdgeDistancePx(queryField, renderField).meanPx, edgeCount: c.edgeCount };
}

/** The correlation half of evaluateEdgeOverlap (edgeCount 0: nothing to compare). The pose search reads the edge
 * distance only for poses it keeps or that reach the target. */
function edgeCorrelation(
    queryField: SobelEdgeField,
    renderField: SobelEdgeField,
    thresholdRatio: number = 0.25
): { overlapScorePercent: number; edgeCount: number } {
    if (queryField.width !== renderField.width || queryField.height !== renderField.height) {
        throw new Error(`Dimension mismatch: Query ${queryField.width}x${queryField.height} vs Render ${renderField.width}x${renderField.height}`);
    }

    const size = queryField.width * queryField.height;
    const thresholdQ = queryField.meanMagnitude * thresholdRatio;
    const thresholdR = renderField.meanMagnitude * thresholdRatio;

    let dotProduct = 0.0;
    let normQ = 0.0;
    let normR = 0.0;
    let edgeCount = 0;

    for (let i = 0; i < size; i++) {
        const magQ = queryField.magnitudes[i];
        const magR = renderField.magnitudes[i];

        // Focus on salient architectural edge features
        if (magQ > thresholdQ || magR > thresholdR) {
            dotProduct += magQ * magR;
            normQ += magQ * magQ;
            normR += magR * magR;
            edgeCount++;
        }
    }

    if (normQ === 0 || normR === 0 || edgeCount === 0) {
        return { overlapScorePercent: 0.0, edgeCount: 0 };
    }

    const ncc = Math.max(0.0, Math.min(1.0, dotProduct / (Math.sqrt(normQ) * Math.sqrt(normR))));
    return { overlapScorePercent: ncc * 100.0, edgeCount };
}

/** Running state of one pose search: the best pose so far and how it scored. */
interface PoseSearchState {
    bestPose: CameraPose6DOF;
    bestScore: number;
    bestResPx: number;
    /** The rendered edge field of bestPose. */
    bestField?: SobelEdgeField;
    iterations: number;
    edgeCount: number;
    /** The initial pose already met the target, so no search ran. */
    convergedAtStart: boolean;
}

/** Options for the cooperative (async) search; see {@link SubPixelEdgeAlignmentOptimizer.optimizePoseAsync}. */
export interface AsyncOptimizationOptions extends OptimizationOptions {
    /** Checked before every render; an aborted signal ends the search with an AbortError. */
    signal?: AbortSignal;
    /** Wall-clock budget in ms. When it runs out the search stops and returns the best pose so far (stoppedBy). */
    timeBudgetMs?: number;
    /** Called after every render batch with the number of renders so far and the best correlation. */
    onRender?: (renders: number, bestScorePercent: number) => void;
    /**
     * Renders several poses at once (e.g. HeadlessEdgeRenderPool.render). The search then renders both trial steps
     * of a parameter together; the poses it picks are the same as one render at a time.
     */
    renderBatch?: (poses: CameraPose6DOF[]) => Promise<SobelEdgeField[]>;
    /** The caller's own render of initialPose, used instead of rendering it again (it counts as a render). */
    initialField?: SobelEdgeField;
}

export interface AsyncEdgeAlignmentMetrics extends EdgeAlignmentMetrics {
    /** Why the search ended. */
    stoppedBy: 'target reached' | 'no further improvement' | 'iteration limit' | 'time budget';
    /** Renders made, the initial one included. */
    renders: number;
    /** The rendered edge field of finalPose. */
    finalField: SobelEdgeField;
}

/**
 * The coordinate-descent pose search as a generator: it yields each pose to render and receives that pose's edge
 * field, so the same search runs synchronously or cooperatively. It updates `state` as it goes.
 */
function* searchPoses(
    initialPose: CameraPose6DOF,
    queryField: SobelEdgeField,
    options: OptimizationOptions,
    state: PoseSearchState,
    /** Ask for both trial steps of a parameter in one batch (the second is rendered even when the first hits the target). */
    pairTrials = false
): Generator<CameraPose6DOF[], void, SobelEdgeField[]> {
    const maxIter = options.maxIterations ?? 30;
    const targetScore = options.targetOverlapScore ?? 99.9;
    const targetResPx = options.subpixelTolerancePx ?? 0.10;

    let currentPose: CameraPose6DOF = { ...initialPose };
    const [initialField] = yield [currentPose];
    const evalResult = evaluateEdgeOverlap(queryField, initialField);
    // The edge distance of a trial pose, read only when the pose is kept or reaches the target correlation.
    const residualOf = (field: SobelEdgeField, edgeCount: number) => (edgeCount === 0 ? NaN : meanEdgeDistancePx(queryField, field).meanPx);
    state.bestPose = { ...initialPose };
    state.bestScore = evalResult.overlapScorePercent;
    state.bestResPx = evalResult.residualPx;
    state.bestField = initialField;
    state.edgeCount = evalResult.edgeCount;

    if (state.bestScore >= targetScore && state.bestResPx <= targetResPx) {
        state.convergedAtStart = true;
        return;
    }

    let stepPos = options.stepSizes?.pos ?? 1.8;
    let stepTarget = options.stepSizes?.target ?? 0.5;
    let stepFov = options.stepSizes?.fov ?? 1.0;
    let stepK1 = options.stepSizes?.k1 ?? 0.005;

    type ScalarPoseKey = 'x' | 'y' | 'z' | 'targetX' | 'targetY' | 'targetZ' | 'fov' | 'k1';
    const paramDefs: Array<{ key: ScalarPoseKey; getStep: () => number }> = [
        { key: "x", getStep: () => stepPos },
        { key: "y", getStep: () => stepPos * 0.7 },
        { key: "z", getStep: () => stepPos },
        { key: "targetX", getStep: () => stepTarget },
        { key: "targetY", getStep: () => stepTarget * 0.7 },
        { key: "targetZ", getStep: () => stepTarget },
        { key: "fov", getStep: () => stepFov }
    ];

    if (initialPose.k1 !== undefined || options.optimizeK1) {
        if (initialPose.k1 === undefined) {
            currentPose.k1 = 0;
            state.bestPose.k1 = 0;
        }
        paramDefs.push({ key: "k1", getStep: () => stepK1 });
    }

    while (state.iterations < maxIter) {
        state.iterations++;

        if (state.bestScore >= targetScore && state.bestResPx <= targetResPx) {
            break;
        }

        let improvedInPass = false;

        // Gauss-Seidel coordinate descent: optimize each DOF sequentially
        for (const param of paramDefs) {
            const step = param.getStep();
            let bestParamScore = state.bestScore;
            let bestParamResPx = state.bestResPx;
            let bestParamVal: number | null = null;
            let bestParamField: SobelEdgeField | undefined;

            const trialPoses = [-step, step].map(delta => {
                const testPose: CameraPose6DOF = { ...currentPose };
                testPose[param.key] = (testPose[param.key] ?? 0) + delta;
                return testPose;
            });
            const pairFields = pairTrials ? yield trialPoses : undefined;

            for (let t = 0; t < trialPoses.length; t++) {
                const testPose = trialPoses[t];
                const testField = pairFields ? pairFields[t] : (yield [testPose])[0];
                const testEval = edgeCorrelation(queryField, testField);
                const testResPx = testEval.overlapScorePercent >= targetScore ? residualOf(testField, testEval.edgeCount) : undefined;

                // Check if target is satisfied
                if (testResPx !== undefined && testResPx <= targetResPx) {
                    state.bestScore = testEval.overlapScorePercent;
                    state.bestResPx = testResPx;
                    state.bestPose = { ...testPose };
                    state.bestField = testField;
                    currentPose = { ...testPose };
                    improvedInPass = true;
                    break;
                }

                if (testEval.overlapScorePercent > bestParamScore + 0.01) {
                    bestParamScore = testEval.overlapScorePercent;
                    bestParamResPx = testResPx ?? residualOf(testField, testEval.edgeCount);
                    bestParamVal = testPose[param.key]!;
                    bestParamField = testField;
                }
            }

            if (bestParamVal !== null) {
                currentPose[param.key] = bestParamVal;
                state.bestPose = { ...currentPose };
                state.bestScore = bestParamScore;
                state.bestResPx = bestParamResPx;
                state.bestField = bestParamField;
                improvedInPass = true;
            }

            if (state.bestScore >= targetScore && state.bestResPx <= targetResPx) {
                break;
            }
        }

        // Decay step size for fine sub-pixel convergence when pass produced no improvement
        if (!improvedInPass) {
            stepPos *= 0.5;
            stepTarget *= 0.5;
            stepFov *= 0.5;
            stepK1 *= 0.5;
        }

        if (stepPos < 0.005 && stepTarget < 0.005 && stepFov < 0.002 && stepK1 < 0.0001) {
            break;
        }
    }
}

function newSearchState(initialPose: CameraPose6DOF): PoseSearchState {
    return { bestPose: { ...initialPose }, bestScore: 0, bestResPx: Infinity, iterations: 0, edgeCount: 0, convergedAtStart: false };
}

/** The metrics of a finished (or stopped) search. */
function searchMetrics(state: PoseSearchState, queryField: SobelEdgeField, options: OptimizationOptions): EdgeAlignmentMetrics {
    const targetScore = options.targetOverlapScore ?? 99.9;
    const targetResPx = options.subpixelTolerancePx ?? 0.10;
    const bestPose = state.bestPose;
    // The measured mean edge distance, projected to the camera-to-target distance: (residualPx / f_px) * distance.
    const dist = Math.sqrt(
        (bestPose.x - bestPose.targetX) ** 2 +
        (bestPose.y - bestPose.targetY) ** 2 +
        (bestPose.z - bestPose.targetZ) ** 2
    );
    const fPx = (queryField.height * 0.5) / Math.tan((bestPose.fov * 0.5 * Math.PI) / 180.0);
    const metrologicalErrorMm = (state.bestResPx / Math.max(1.0, fPx)) * dist * 1000.0;

    return {
        overlapScorePercent: Math.min(100.0, Math.max(0.0, state.bestScore)),
        subpixelResidualPx: state.bestResPx,
        metrologicalErrorMm,
        edgePointCount: state.edgeCount,
        converged: state.convergedAtStart || (state.bestScore >= targetScore && state.bestResPx <= targetResPx),
        iterations: state.iterations,
        finalPose: bestPose
    };
}

/**
 * Edge alignment optimizer: coordinate descent over the camera pose (position, target, fov, optionally k1) that
 * raises the edge correlation between a reference and renders at each trial pose. It reports the correlation and the
 * measured mean edge distance it reached; convergence means the caller's targets were met, nothing more.
 */
export class SubPixelEdgeAlignmentOptimizer {
    /**
     * Searches the pose toward the target edge correlation and edge distance (the name is historical: it stops at the
     * best pose it finds, which is often below 100%).
     */
    public static optimizePoseTo100Percent(
        initialPose: CameraPose6DOF,
        queryField: SobelEdgeField,
        renderFunc: (pose: CameraPose6DOF) => SobelEdgeField,
        options: OptimizationOptions = {}
    ): EdgeAlignmentMetrics {
        const state = newSearchState(initialPose);
        const search = searchPoses(initialPose, queryField, options, state);
        let step = search.next();
        while (!step.done) {
            step = search.next(step.value.map(renderFunc));
        }
        return searchMetrics(state, queryField, options);
    }

    /**
     * The same search, made cooperative for servers: it yields to the event loop before every render (so timers,
     * Stop and other requests keep being served), ends with an AbortError when `signal` is aborted, and stops with
     * the best pose so far when `timeBudgetMs` runs out. The result says why it stopped and how many renders it made.
     */
    public static async optimizePoseAsync(
        initialPose: CameraPose6DOF,
        queryField: SobelEdgeField,
        renderFunc: (pose: CameraPose6DOF) => SobelEdgeField | Promise<SobelEdgeField>,
        options: AsyncOptimizationOptions = {}
    ): Promise<AsyncEdgeAlignmentMetrics> {
        const started = Date.now();
        const state = newSearchState(initialPose);
        const renderBatch = options.renderBatch;
        const search = searchPoses(initialPose, queryField, options, state, !!renderBatch);
        let renders = 0;
        let outOfTime = false;
        let step = search.next();
        if (options.initialField && !step.done) {
            renders++;
            step = search.next([options.initialField]);
            options.onRender?.(renders, state.bestScore);
        }
        while (!step.done) {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (options.signal?.aborted) {
                throw Object.assign(new Error('Edge alignment stopped before it finished'), { name: 'AbortError' });
            }
            // The initial render always runs, so a result always has a measured pose.
            if (renders > 0 && options.timeBudgetMs !== undefined && Date.now() - started >= options.timeBudgetMs) {
                outOfTime = true;
                break;
            }
            const fields = renderBatch ? await renderBatch(step.value) : await Promise.all(step.value.map(p => renderFunc(p)));
            renders += fields.length;
            step = search.next(fields);
            options.onRender?.(renders, state.bestScore);
        }
        const metrics = searchMetrics(state, queryField, options);
        const maxIter = options.maxIterations ?? 30;
        const stoppedBy: AsyncEdgeAlignmentMetrics['stoppedBy'] = outOfTime ? 'time budget'
            : metrics.converged ? 'target reached'
            : state.iterations >= maxIter ? 'iteration limit' : 'no further improvement';
        return { ...metrics, stoppedBy, renders, finalField: state.bestField! };
    }

    /**
     * Instance wrapper for optimizePoseTo100Percent.
     */
    public optimizePoseTo100Percent(
        initialPose: CameraPose6DOF,
        queryField: SobelEdgeField,
        renderFunc: (pose: CameraPose6DOF) => SobelEdgeField,
        options: OptimizationOptions = {}
    ): EdgeAlignmentMetrics {
        return SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(initialPose, queryField, renderFunc, options);
    }
}

export type OptimizationResult = {
    initialOverlapScorePct: number;
    finalOverlapScorePct: number;
    subPixelResidualPx: number;
    physicalErrorMm: number;
    converged: boolean;
    iterations: number;
    optimizedPose: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
};
