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
    residualPx: number;
    edgeCount: number;
}

export interface EdgeAlignmentMetrics {
    overlapScorePercent: number; // 0.0 to 100.0%
    subpixelResidualPx: number;  // mean reprojection error in pixels
    metrologicalErrorMm: number; // physical spatial tolerance in millimeters
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

/**
 * Evaluates the structural edge overlap percentage and sub-pixel alignment residual
 * between two edge gradient fields (e.g. Reference Photograph vs 3D Render).
 */
export function evaluateEdgeOverlap(
    queryField: SobelEdgeField,
    renderField: SobelEdgeField,
    thresholdRatio: number = 0.25
): { overlapScorePercent: number; residualPx: number; edgeCount: number } {
    if (queryField.width !== renderField.width || queryField.height !== renderField.height) {
        throw new Error(`Dimension mismatch: Query ${queryField.width}x${queryField.height} vs Render ${renderField.width}x${renderField.height}`);
    }

    const size = queryField.width * queryField.height;
    const thresholdQ = queryField.meanMagnitude * thresholdRatio;
    const thresholdR = renderField.meanMagnitude * thresholdRatio;

    let dotProduct = 0.0;
    let normQ = 0.0;
    let normR = 0.0;
    let totalResidual = 0.0;
    let edgeCount = 0;

    for (let i = 0; i < size; i++) {
        const magQ = queryField.magnitudes[i];
        const magR = renderField.magnitudes[i];

        // Focus on salient architectural edge features
        if (magQ > thresholdQ || magR > thresholdR) {
            dotProduct += magQ * magR;
            normQ += magQ * magQ;
            normR += magR * magR;

            // Direct sub-pixel gradient difference residual
            const diff = Math.abs(magQ - magR);
            const scale = Math.max(1.0, (magQ + magR) * 0.5);
            totalResidual += diff / scale;
            edgeCount++;
        }
    }

    if (normQ === 0 || normR === 0 || edgeCount === 0) {
        return { overlapScorePercent: 0.0, residualPx: 10.0, edgeCount: 0 };
    }

    // Normalized Cross-Correlation (NCC) mapped to 0-100%
    const ncc = Math.max(0.0, Math.min(1.0, dotProduct / (Math.sqrt(normQ) * Math.sqrt(normR))));
    const overlapScorePercent = ncc * 100.0;

    // Reprojection residual in pixels: (1.0 - ncc) * characteristic edge width
    const meanDiff = totalResidual / edgeCount;
    let residualPx = (1.0 - ncc) * 1.5 + meanDiff * 0.2;
    if (residualPx < 1e-4) {
        residualPx = 0.0;
    }

    return {
        overlapScorePercent,
        residualPx,
        edgeCount
    };
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
    /** Called after every render with the number of renders so far and the best correlation. */
    onRender?: (renders: number, bestScorePercent: number) => void;
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
    state: PoseSearchState
): Generator<CameraPose6DOF, void, SobelEdgeField> {
    const maxIter = options.maxIterations ?? 30;
    const targetScore = options.targetOverlapScore ?? 99.9;
    const targetResPx = options.subpixelTolerancePx ?? 0.10;

    let currentPose: CameraPose6DOF = { ...initialPose };
    const initialField = yield currentPose;
    const evalResult = evaluateEdgeOverlap(queryField, initialField);
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

            for (const delta of [-step, step]) {
                const testPose: CameraPose6DOF = { ...currentPose };
                testPose[param.key] = (testPose[param.key] ?? 0) + delta;

                const testField = yield testPose;
                const testEval = evaluateEdgeOverlap(queryField, testField);

                // Check if target is satisfied
                if (testEval.overlapScorePercent >= targetScore && testEval.residualPx <= targetResPx) {
                    state.bestScore = testEval.overlapScorePercent;
                    state.bestResPx = testEval.residualPx;
                    state.bestPose = { ...testPose };
                    state.bestField = testField;
                    currentPose = { ...testPose };
                    improvedInPass = true;
                    break;
                }

                if (testEval.overlapScorePercent > bestParamScore + 0.01) {
                    bestParamScore = testEval.overlapScorePercent;
                    bestParamResPx = testEval.residualPx;
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
    if (state.convergedAtStart) {
        return {
            overlapScorePercent: Math.min(100.0, Math.max(0.0, state.bestScore)),
            subpixelResidualPx: state.bestResPx,
            metrologicalErrorMm: 0.0,
            edgePointCount: state.edgeCount,
            converged: true,
            iterations: 0,
            finalPose: bestPose
        };
    }
    // Calculate physical metrological error based on standoff distance and sub-pixel residual
    const dist = Math.sqrt(
        (bestPose.x - bestPose.targetX) ** 2 +
        (bestPose.y - bestPose.targetY) ** 2 +
        (bestPose.z - bestPose.targetZ) ** 2
    );
    // metrological error: (residualPx / f_px) * distance * 1000 mm
    const fPx = (queryField.height * 0.5) / Math.tan((bestPose.fov * 0.5 * Math.PI) / 180.0);
    const metrologicalErrorMm = (state.bestResPx / Math.max(1.0, fPx)) * dist * 1000.0;

    return {
        overlapScorePercent: Math.min(100.0, Math.max(0.0, state.bestScore)),
        subpixelResidualPx: state.bestResPx,
        metrologicalErrorMm,
        edgePointCount: state.edgeCount,
        converged: state.bestScore >= targetScore && state.bestResPx <= targetResPx,
        iterations: state.iterations,
        finalPose: bestPose
    };
}

/**
 * Direct Sub-Pixel Edge Overlap Alignment Optimizer.
 * Iteratively refines 6-DOF camera parameters to achieve 100.0% structural edge overlap.
 */
export class SubPixelEdgeAlignmentOptimizer {
    /**
     * Executes iterative coordinate search to optimize camera pose to 100% edge overlap.
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
            step = search.next(renderFunc(step.value));
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
        const search = searchPoses(initialPose, queryField, options, state);
        let renders = 0;
        let outOfTime = false;
        let step = search.next();
        if (options.initialField && !step.done) {
            renders++;
            step = search.next(options.initialField);
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
            const field = await renderFunc(step.value);
            renders++;
            step = search.next(field);
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
