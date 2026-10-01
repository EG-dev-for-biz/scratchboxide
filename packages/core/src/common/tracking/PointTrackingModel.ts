/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    NormalizedPoint2D,
    PointTracks,
    SamplingConfig,
    TrackingConfig,
    VideoFrameData
} from './tapir-tracking-protocol';

/**
 * Base abstract interface for point trackers.
 */
export interface IPointTracker {
    trackPoints(
        frames: VideoFrameData[],
        queryPoints: NormalizedPoint2D[],
        queryFrames?: number[]
    ): Promise<PointTracks> | PointTracks;
}

/**
 * Point sampling algorithms for seeding dense trajectories.
 */
export class PointSamplers {
    /**
     * Converts RGB/RGBA buffer to Float32Array grayscale luminance in [0.0, 1.0].
     */
    public static rgbToGrayscale(
        data: Uint8Array | Buffer,
        width: number,
        height: number,
        channels: number = 3
    ): Float32Array {
        const gray = new Float32Array(width * height);
        const step = channels;
        for (let i = 0, p = 0; i < gray.length; i++, p += step) {
            const r = data[p];
            const g = data[p + 1];
            const b = data[p + 2];
            // Rec. 709 luminance
            gray[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
        }
        return gray;
    }

    /**
     * Uniform spatial grid point sampler.
     */
    public static sampleGrid(
        width: number,
        height: number,
        options: { stride?: number; margin?: number; maxPoints?: number } = {}
    ): NormalizedPoint2D[] {
        const stride = options.stride ?? 16;
        const margin = options.margin ?? 8;
        const maxPoints = options.maxPoints ?? 512;

        const pts: NormalizedPoint2D[] = [];
        const maxX = width - margin;
        const maxY = height - margin;

        for (let y = margin; y <= maxY; y += stride) {
            for (let x = margin; x <= maxX; x += stride) {
                pts.push([
                    x / Math.max(width - 1, 1),
                    y / Math.max(height - 1, 1)
                ]);
            }
        }

        if (pts.length > maxPoints) {
            // Subsample evenly across sequence
            const step = (pts.length - 1) / (maxPoints - 1);
            const subsampled: NormalizedPoint2D[] = [];
            for (let i = 0; i < maxPoints; i++) {
                subsampled.push(pts[Math.round(i * step)]);
            }
            return subsampled;
        }

        return pts;
    }

    /**
     * Harris / Shi-Tomasi corner saliency sampler with sub-pixel parabolic peak localization.
     */
    public static sampleSaliency(
        frame: VideoFrameData,
        options: {
            qualityLevel?: number;
            minDistance?: number;
            maxPoints?: number;
        } = {}
    ): NormalizedPoint2D[] {
        const { width, height, data } = frame;
        const channels = frame.channels ?? 3;
        const qualityLevel = options.qualityLevel ?? 0.01;
        const minDistance = options.minDistance ?? 10;
        const maxPoints = options.maxPoints ?? 512;

        const gray = this.rgbToGrayscale(data, width, height, channels);

        // 1. Calculate image spatial gradients Ix, Iy using Sobel operators
        const ix = new Float32Array(width * height);
        const iy = new Float32Array(width * height);

        for (let y = 1; y < height - 1; y++) {
            const rowPrev = (y - 1) * width;
            const rowCurr = y * width;
            const rowNext = (y + 1) * width;

            for (let x = 1; x < width - 1; x++) {
                const idx = rowCurr + x;
                // Sobel X: [-1 0 1; -2 0 2; -1 0 1]
                const gx =
                    (gray[rowNext + x + 1] + 2 * gray[rowCurr + x + 1] + gray[rowPrev + x + 1]) -
                    (gray[rowNext + x - 1] + 2 * gray[rowCurr + x - 1] + gray[rowPrev + x - 1]);
                // Sobel Y: [-1 -2 -1; 0 0 0; 1 2 1]
                const gy =
                    (gray[rowNext + x - 1] + 2 * gray[rowNext + x] + gray[rowNext + x + 1]) -
                    (gray[rowPrev + x - 1] + 2 * gray[rowPrev + x] + gray[rowPrev + x + 1]);

                ix[idx] = gx * 0.125;
                iy[idx] = gy * 0.125;
            }
        }

        // 2. Compute Structure Tensor elements (Ix^2, Iy^2, Ix*Iy) smoothed with box/Gaussian filter
        const radius = 2; // 5x5 window
        const response = new Float32Array(width * height);
        let maxResponse = 0.0;

        for (let y = radius + 1; y < height - radius - 1; y++) {
            for (let x = radius + 1; x < width - radius - 1; x++) {
                let sxx = 0;
                let syy = 0;
                let sxy = 0;

                for (let dy = -radius; dy <= radius; dy++) {
                    const rOffset = (y + dy) * width;
                    for (let dx = -radius; dx <= radius; dx++) {
                        const pIdx = rOffset + (x + dx);
                        const gx = ix[pIdx];
                        const gy = iy[pIdx];
                        sxx += gx * gx;
                        syy += gy * gy;
                        sxy += gx * gy;
                    }
                }

                // Shi-Tomasi minimum eigenvalue: lambda_min = (tr - sqrt(tr^2 - 4*det)) / 2
                const tr = sxx + syy;
                const det = sxx * syy - sxy * sxy;
                const disc = Math.max(0, tr * tr - 4 * det);
                const lambdaMin = (tr - Math.sqrt(disc)) * 0.5;

                response[y * width + x] = lambdaMin;
                if (lambdaMin > maxResponse) {
                    maxResponse = lambdaMin;
                }
            }
        }

        if (maxResponse <= 1e-6) {
            // Flat frame fallback to uniform grid
            return this.sampleGrid(width, height, { maxPoints });
        }

        // 3. Threshold and find local maxima with minimum spatial distance
        const threshold = maxResponse * qualityLevel;
        interface CornerCandidate {
            x: number;
            y: number;
            score: number;
        }
        const candidates: CornerCandidate[] = [];

        for (let y = radius + 2; y < height - radius - 2; y++) {
            const rowOffset = y * width;
            for (let x = radius + 2; x < width - radius - 2; x++) {
                const score = response[rowOffset + x];
                if (score < threshold) continue;

                // 3x3 local non-maximum suppression
                if (
                    score > response[rowOffset - width + x] &&
                    score > response[rowOffset + width + x] &&
                    score > response[rowOffset + x - 1] &&
                    score > response[rowOffset + x + 1] &&
                    score >= response[rowOffset - width + x - 1] &&
                    score >= response[rowOffset - width + x + 1] &&
                    score >= response[rowOffset + width + x - 1] &&
                    score >= response[rowOffset + width + x + 1]
                ) {
                    // Subpixel quadratic peak refinement
                    const sL = response[rowOffset + x - 1];
                    const sR = response[rowOffset + x + 1];
                    const sT = response[rowOffset - width + x];
                    const sB = response[rowOffset + width + x];

                    const denomX = 2 * (sL - 2 * score + sR);
                    const denomY = 2 * (sT - 2 * score + sB);

                    const subX = Math.abs(denomX) > 1e-6 ? (sL - sR) / denomX : 0;
                    const subY = Math.abs(denomY) > 1e-6 ? (sT - sB) / denomY : 0;

                    candidates.push({
                        x: Math.max(0, Math.min(width - 1, x + subX)),
                        y: Math.max(0, Math.min(height - 1, y + subY)),
                        score
                    });
                }
            }
        }

        // Sort descending by score
        candidates.sort((a, b) => b.score - a.score);

        // Spatial exclusion grid for minDistance
        const minDstSq = minDistance * minDistance;
        const selected: NormalizedPoint2D[] = [];

        for (const c of candidates) {
            let conflict = false;
            for (let i = 0; i < selected.length; i++) {
                const sx = selected[i][0] * (width - 1);
                const sy = selected[i][1] * (height - 1);
                const dx = c.x - sx;
                const dy = c.y - sy;
                if (dx * dx + dy * dy < minDstSq) {
                    conflict = true;
                    break;
                }
            }
            if (!conflict) {
                selected.push([
                    c.x / Math.max(width - 1, 1),
                    c.y / Math.max(height - 1, 1)
                ]);
                if (selected.length >= maxPoints) break;
            }
        }

        return selected.length > 0 ? selected : this.sampleGrid(width, height, { maxPoints });
    }

    /**
     * Hybrid cellular sampler: partitions frame into grid cells and picks the strongest corner per cell.
     */
    public static sampleHybrid(
        frame: VideoFrameData,
        options: {
            cellSize?: number;
            qualityLevel?: number;
            maxPoints?: number;
        } = {}
    ): NormalizedPoint2D[] {
        const cellSize = options.cellSize ?? 20;
        const maxPoints = options.maxPoints ?? 512;
        const { width, height } = frame;

        const saliencyPoints = this.sampleSaliency(frame, {
            qualityLevel: options.qualityLevel ?? 0.005,
            minDistance: cellSize * 0.5,
            maxPoints: maxPoints * 2
        });

        const gridX = Math.ceil(width / cellSize);
        const gridY = Math.ceil(height / cellSize);
        const cellOccupied = new Uint8Array(gridX * gridY);
        const result: NormalizedPoint2D[] = [];

        // Add detected salient points first
        for (const p of saliencyPoints) {
            const px = p[0] * (width - 1);
            const py = p[1] * (height - 1);
            const cx = Math.floor(px / cellSize);
            const cy = Math.floor(py / cellSize);
            if (cx >= 0 && cx < gridX && cy >= 0 && cy < gridY) {
                const cellIdx = cy * gridX + cx;
                if (!cellOccupied[cellIdx]) {
                    cellOccupied[cellIdx] = 1;
                    result.push(p);
                    if (result.length >= maxPoints) return result;
                }
            }
        }

        // Fill remaining empty cells with cell center
        for (let cy = 0; cy < gridY && result.length < maxPoints; cy++) {
            for (let cx = 0; cx < gridX && result.length < maxPoints; cx++) {
                const cellIdx = cy * gridX + cx;
                if (!cellOccupied[cellIdx]) {
                    const cxMid = Math.min((cx + 0.5) * cellSize, width - 1);
                    const cyMid = Math.min((cy + 0.5) * cellSize, height - 1);
                    result.push([
                        cxMid / Math.max(width - 1, 1),
                        cyMid / Math.max(height - 1, 1)
                    ]);
                }
            }
        }

        return result;
    }
}

/**
 * High-performance pure-TypeScript multi-scale pyramidal Lucas-Kanade optical flow tracker
 * with bidirectional forward-backward cycle consistency checks and temporal recovery.
 */
export class LucasKanadeFlowTracker implements IPointTracker {
    private winSize: [number, number];
    private maxLevel: number;
    private fbThreshold: number;

    constructor(config: TrackingConfig = {}) {
        this.winSize = config.winSize ?? [15, 15];
        this.maxLevel = config.maxLevel ?? 3;
        this.fbThreshold = config.fbThreshold ?? 2.5; // pixel tolerance
    }

    /**
     * Bilinear interpolation of pixel value and spatial derivatives in Float32 image.
     */
    private sampleBilinear(
        img: Float32Array,
        w: number,
        h: number,
        x: number,
        y: number
    ): number {
        if (x < 0 || x > w - 1 || y < 0 || y > h - 1) return 0;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, w - 1);
        const y1 = Math.min(y0 + 1, h - 1);
        const wx = x - x0;
        const wy = y - y0;

        const i00 = img[y0 * w + x0];
        const i01 = img[y0 * w + x1];
        const i10 = img[y1 * w + x0];
        const i11 = img[y1 * w + x1];

        return (1 - wx) * (1 - wy) * i00 + wx * (1 - wy) * i01 + (1 - wx) * wy * i10 + wx * wy * i11;
    }

    /**
     * Builds Gaussian image pyramid via 2x box downsampling.
     */
    private buildPyramid(
        gray: Float32Array,
        w: number,
        h: number,
        levels: number
    ): Array<{ img: Float32Array; w: number; h: number }> {
        const pyramid: Array<{ img: Float32Array; w: number; h: number }> = [{ img: gray, w, h }];
        let curr = gray;
        let cw = w;
        let ch = h;

        for (let l = 1; l < levels; l++) {
            const nw = Math.max(1, Math.floor(cw / 2));
            const nh = Math.max(1, Math.floor(ch / 2));
            const next = new Float32Array(nw * nh);

            for (let y = 0; y < nh; y++) {
                const srcY = y * 2;
                const srcY1 = Math.min(srcY + 1, ch - 1);
                for (let x = 0; x < nw; x++) {
                    const srcX = x * 2;
                    const srcX1 = Math.min(srcX + 1, cw - 1);

                    const v00 = curr[srcY * cw + srcX];
                    const v01 = curr[srcY * cw + srcX1];
                    const v10 = curr[srcY1 * cw + srcX];
                    const v11 = curr[srcY1 * cw + srcX1];

                    next[y * nw + x] = (v00 + v01 + v10 + v11) * 0.25;
                }
            }

            pyramid.push({ img: next, w: nw, h: nh });
            curr = next;
            cw = nw;
            ch = nh;
        }

        return pyramid;
    }

    /**
     * Tracks a single 2D point from pyr1 to pyr2 using pyramidal Lucas-Kanade iteration.
     */
    private trackPointPair(
        pyr1: Array<{ img: Float32Array; w: number; h: number }>,
        pyr2: Array<{ img: Float32Array; w: number; h: number }>,
        startX: number,
        startY: number
    ): { x: number; y: number; status: boolean } {
        const halfWinX = Math.floor(this.winSize[0] / 2);
        const halfWinY = Math.floor(this.winSize[1] / 2);
        const maxIters = 20;
        const eps = 0.03;

        let gX = 0;
        let gY = 0;

        // Iterate through pyramid levels from coarse to fine
        for (let l = this.maxLevel - 1; l >= 0; l--) {
            const scale = Math.pow(2, l);
            const w1 = pyr1[l].w;
            const h1 = pyr1[l].h;
            const img1 = pyr1[l].img;
            const img2 = pyr2[l].img;

            const ptX = startX / scale;
            const ptY = startY / scale;

            // Initial guess at this level
            let uX = gX;
            let uY = gY;

            // Compute spatial gradient matrix G = [sum(Ix^2) sum(Ix*Iy); sum(Ix*Iy) sum(Iy^2)]
            let sxx = 0, syy = 0, sxy = 0;
            const winW = halfWinX * 2 + 1;
            const winH = halfWinY * 2 + 1;
            const numPixels = winW * winH;
            const ix = new Float32Array(numPixels);
            const iy = new Float32Array(numPixels);
            const template = new Float32Array(numPixels);

            let pIdx = 0;
            for (let dy = -halfWinY; dy <= halfWinY; dy++) {
                for (let dx = -halfWinX; dx <= halfWinX; dx++) {
                    const sampleX = ptX + dx;
                    const sampleY = ptY + dy;
                    const val = this.sampleBilinear(img1, w1, h1, sampleX, sampleY);
                    template[pIdx] = val;

                    // Central difference gradient in template image
                    const gx = (this.sampleBilinear(img1, w1, h1, sampleX + 1, sampleY) -
                                this.sampleBilinear(img1, w1, h1, sampleX - 1, sampleY)) * 0.5;
                    const gy = (this.sampleBilinear(img1, w1, h1, sampleX, sampleY + 1) -
                                this.sampleBilinear(img1, w1, h1, sampleX, sampleY - 1)) * 0.5;

                    ix[pIdx] = gx;
                    iy[pIdx] = gy;
                    sxx += gx * gx;
                    syy += gy * gy;
                    sxy += gx * gy;
                    pIdx++;
                }
            }

            const det = sxx * syy - sxy * sxy;
            if (det < 1e-7) {
                // Low texture rank; propagate coarse displacement
                gX *= 2;
                gY *= 2;
                continue;
            }

            const invDet = 1.0 / det;
            const invG00 = syy * invDet;
            const invG01 = -sxy * invDet;
            const invG11 = sxx * invDet;

            // Lucas-Kanade iterations
            for (let iter = 0; iter < maxIters; iter++) {
                let bx = 0;
                let by = 0;
                pIdx = 0;

                for (let dy = -halfWinY; dy <= halfWinY; dy++) {
                    for (let dx = -halfWinX; dx <= halfWinX; dx++) {
                        const targetX = ptX + dx + uX;
                        const targetY = ptY + dy + uY;
                        const val2 = this.sampleBilinear(img2, w1, h1, targetX, targetY);
                        const diff = template[pIdx] - val2;

                        bx += diff * ix[pIdx];
                        by += diff * iy[pIdx];
                        pIdx++;
                    }
                }

                // Solve delta = inv(G) * b
                const deltaX = invG00 * bx + invG01 * by;
                const deltaY = invG01 * bx + invG11 * by;

                uX += deltaX;
                uY += deltaY;

                if (deltaX * deltaX + deltaY * deltaY < eps * eps) {
                    break;
                }
            }

            if (l > 0) {
                gX = uX * 2;
                gY = uY * 2;
            } else {
                gX = uX;
                gY = uY;
            }
        }

        const finalX = startX + gX;
        const finalY = startY + gY;
        const valid = !isNaN(finalX) && !isNaN(finalY);
        return { x: finalX, y: finalY, status: valid };
    }

    /**
     * Tracks points across all video frames with forward-backward cycle consistency.
     */
    public trackPoints(
        frames: VideoFrameData[],
        queryPoints: NormalizedPoint2D[],
        queryFrames?: number[]
    ): PointTracks {
        const T = frames.length;
        const N = queryPoints.length;

        if (T === 0 || N === 0) {
            return {
                coords: [],
                visibilities: [],
                queryPoints,
                queryFrames
            };
        }

        const W = frames[0].width;
        const H = frames[0].height;

        // Build pyramids for all frames
        const pyramids = frames.map(f => {
            const gray = PointSamplers.rgbToGrayscale(f.data, f.width, f.height, f.channels ?? 3);
            return this.buildPyramid(gray, f.width, f.height, this.maxLevel);
        });

        const qFrames = queryFrames ?? new Array(N).fill(0);

        // Pre-allocate trajectories
        const coords: Array<Array<NormalizedPoint2D>> = [];
        const visibilities: Array<Array<number>> = [];

        for (let t = 0; t < T; t++) {
            coords.push(new Array(N));
            visibilities.push(new Array(N).fill(1.0));
        }

        // Initialize positions at query frames
        for (let n = 0; n < N; n++) {
            const startT = Math.max(0, Math.min(qFrames[n], T - 1));
            coords[startT][n] = [queryPoints[n][0], queryPoints[n][1]];
            visibilities[startT][n] = 1.0;

            // Track forward from startT to T - 1
            let currX = queryPoints[n][0] * (W - 1);
            let currY = queryPoints[n][1] * (H - 1);
            let isVisible = true;

            for (let t = startT; t < T - 1; t++) {
                if (!isVisible) {
                    coords[t + 1][n] = [currX / Math.max(W - 1, 1), currY / Math.max(H - 1, 1)];
                    visibilities[t + 1][n] = 0.0;
                    continue;
                }

                // 1. Forward step: t -> t+1
                const fwd = this.trackPointPair(pyramids[t], pyramids[t + 1], currX, currY);
                // 2. Backward step: t+1 -> t (cycle-consistency)
                const bwd = this.trackPointPair(pyramids[t + 1], pyramids[t], fwd.x, fwd.y);

                const cycleErr = Math.sqrt((currX - bwd.x) ** 2 + (currY - bwd.y) ** 2);
                const outOfBounds = fwd.x < -2 || fwd.x > W + 1 || fwd.y < -2 || fwd.y > H + 1;

                if (!fwd.status || outOfBounds || cycleErr > this.fbThreshold) {
                    isVisible = false;
                    visibilities[t + 1][n] = 0.0;
                } else {
                    visibilities[t + 1][n] = Math.max(0.0, Math.min(1.0, 1.0 - (cycleErr / this.fbThreshold) * 0.5));
                }

                currX = Math.max(0, Math.min(W - 1, fwd.x));
                currY = Math.max(0, Math.min(H - 1, fwd.y));
                coords[t + 1][n] = [
                    currX / Math.max(W - 1, 1),
                    currY / Math.max(H - 1, 1)
                ];
            }

            // Track backward from startT down to 0 (if startT > 0)
            currX = queryPoints[n][0] * (W - 1);
            currY = queryPoints[n][1] * (H - 1);
            isVisible = true;

            for (let t = startT; t > 0; t--) {
                if (!isVisible) {
                    coords[t - 1][n] = [currX / Math.max(W - 1, 1), currY / Math.max(H - 1, 1)];
                    visibilities[t - 1][n] = 0.0;
                    continue;
                }

                const bwd = this.trackPointPair(pyramids[t], pyramids[t - 1], currX, currY);
                const fwd = this.trackPointPair(pyramids[t - 1], pyramids[t], bwd.x, bwd.y);

                const cycleErr = Math.sqrt((currX - fwd.x) ** 2 + (currY - fwd.y) ** 2);
                const outOfBounds = bwd.x < -2 || bwd.x > W + 1 || bwd.y < -2 || bwd.y > H + 1;

                if (!bwd.status || outOfBounds || cycleErr > this.fbThreshold) {
                    isVisible = false;
                    visibilities[t - 1][n] = 0.0;
                } else {
                    visibilities[t - 1][n] = Math.max(0.0, Math.min(1.0, 1.0 - (cycleErr / this.fbThreshold) * 0.5));
                }

                currX = Math.max(0, Math.min(W - 1, bwd.x));
                currY = Math.max(0, Math.min(H - 1, bwd.y));
                coords[t - 1][n] = [
                    currX / Math.max(W - 1, 1),
                    currY / Math.max(H - 1, 1)
                ];
            }
        }

        return {
            coords,
            visibilities,
            queryPoints,
            queryFrames: qFrames
        };
    }
}

/**
 * Deterministic synthetic tracker for testing and verification.
 */
export class SyntheticTracker implements IPointTracker {
    private velocity: [number, number];

    constructor(vxOrVelocity: number | [number, number] = [0.005, 0.002], vy: number = 0.002) {
        if (Array.isArray(vxOrVelocity)) {
            this.velocity = vxOrVelocity;
        } else {
            this.velocity = [vxOrVelocity, vy];
        }
    }

    public trackPoints(
        frames: VideoFrameData[],
        queryPoints: NormalizedPoint2D[],
        queryFrames?: number[]
    ): PointTracks {
        const T = frames.length;
        const N = queryPoints.length;
        const qFrames = queryFrames ?? new Array(N).fill(0);

        const coords: Array<Array<NormalizedPoint2D>> = [];
        const visibilities: Array<Array<number>> = [];

        for (let t = 0; t < T; t++) {
            const frameCoords: NormalizedPoint2D[] = [];
            const frameVis: number[] = [];

            for (let n = 0; n < N; n++) {
                const dt = t - qFrames[n];
                const x = queryPoints[n][0] + dt * this.velocity[0];
                const y = queryPoints[n][1] + dt * this.velocity[1];

                const outOfBounds = x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0;
                frameCoords.push([
                    Math.max(0.0, Math.min(1.0, x)),
                    Math.max(0.0, Math.min(1.0, y))
                ]);
                frameVis.push(outOfBounds ? 0.0 : 1.0);
            }

            coords.push(frameCoords);
            visibilities.push(frameVis);
        }

        return {
            coords,
            visibilities,
            queryPoints,
            queryFrames: qFrames
        };
    }
}
