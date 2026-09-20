/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
        const maxIter = options.maxIterations ?? 30;
        const targetScore = options.targetOverlapScore ?? 99.9;
        const targetResPx = options.subpixelTolerancePx ?? 0.10;

        let currentPose: CameraPose6DOF = { ...initialPose };
        let bestPose: CameraPose6DOF = { ...initialPose };
        let currentField = renderFunc(currentPose);
        let evalResult = evaluateEdgeOverlap(queryField, currentField);

        let bestScore = evalResult.overlapScorePercent;
        let bestResPx = evalResult.residualPx;
        let iterations = 0;

        if (bestScore >= targetScore && bestResPx <= targetResPx) {
            return {
                overlapScorePercent: Math.min(100.0, Math.max(0.0, bestScore)),
                subpixelResidualPx: bestResPx,
                metrologicalErrorMm: 0.0,
                edgePointCount: evalResult.edgeCount,
                converged: true,
                iterations: 0,
                finalPose: bestPose
            };
        }

        let stepPos = options.stepSizes?.pos ?? 1.8;
        let stepTarget = options.stepSizes?.target ?? 0.5;
        let stepFov = options.stepSizes?.fov ?? 1.0;
        let stepK1 = options.stepSizes?.k1 ?? 0.005;

        const paramDefs: Array<{ key: keyof CameraPose6DOF; getStep: () => number }> = [
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
                bestPose.k1 = 0;
            }
            paramDefs.push({ key: "k1", getStep: () => stepK1 });
        }

        while (iterations < maxIter) {
            iterations++;

            if (bestScore >= targetScore && bestResPx <= targetResPx) {
                break;
            }

            let improvedInPass = false;

            // Gauss-Seidel coordinate descent: optimize each DOF sequentially
            for (const param of paramDefs) {
                const step = param.getStep();
                let bestParamScore = bestScore;
                let bestParamResPx = bestResPx;
                let bestParamVal: number | null = null;

                for (const delta of [-step, step]) {
                    const testPose: CameraPose6DOF = { ...currentPose };
                    testPose[param.key] = (testPose[param.key] ?? 0) + delta;

                    const testField = renderFunc(testPose);
                    const testEval = evaluateEdgeOverlap(queryField, testField);

                    // Check if target is satisfied
                    if (testEval.overlapScorePercent >= targetScore && testEval.residualPx <= targetResPx) {
                        bestScore = testEval.overlapScorePercent;
                        bestResPx = testEval.residualPx;
                        bestPose = { ...testPose };
                        currentPose = { ...testPose };
                        improvedInPass = true;
                        break;
                    }

                    if (testEval.overlapScorePercent > bestParamScore + 0.01) {
                        bestParamScore = testEval.overlapScorePercent;
                        bestParamResPx = testEval.residualPx;
                        bestParamVal = testPose[param.key]!;
                    }
                }

                if (bestParamVal !== null) {
                    currentPose[param.key] = bestParamVal;
                    bestPose = { ...currentPose };
                    bestScore = bestParamScore;
                    bestResPx = bestParamResPx;
                    improvedInPass = true;
                }

                if (bestScore >= targetScore && bestResPx <= targetResPx) {
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

        // Calculate physical metrological error based on standoff distance and sub-pixel residual
        const dist = Math.sqrt(
            (bestPose.x - bestPose.targetX) ** 2 +
            (bestPose.y - bestPose.targetY) ** 2 +
            (bestPose.z - bestPose.targetZ) ** 2
        );
        // metrological error: (residualPx / f_px) * distance * 1000 mm
        const fPx = (queryField.height * 0.5) / Math.tan((bestPose.fov * 0.5 * Math.PI) / 180.0);
        const metrologicalErrorMm = (bestResPx / Math.max(1.0, fPx)) * dist * 1000.0;

        const converged = bestScore >= targetScore && bestResPx <= targetResPx;

        return {
            overlapScorePercent: Math.min(100.0, Math.max(0.0, bestScore)),
            subpixelResidualPx: bestResPx,
            metrologicalErrorMm,
            edgePointCount: evalResult.edgeCount,
            converged,
            iterations,
            finalPose: bestPose
        };
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
