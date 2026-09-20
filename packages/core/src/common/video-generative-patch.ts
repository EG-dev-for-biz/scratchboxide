/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type GenerativePatchMode = 'remove' | 'insert' | 'harmonize_3d';
export type ApiAspectRatio = '16:9' | '9:16';
export type ApiResolutionTier = '720p' | '1080p' | '4k';

export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface GenerativePatchConfig {
    enabled: boolean;
    mode: GenerativePatchMode;
    targetBox: BoundingBox; // The exact bounding region of the defect or object
    prompt: string;
    aspectRatio?: ApiAspectRatio | 'auto';
    resolutionTier?: ApiResolutionTier | 'auto';
    featherRadius?: number; // In pixels, default 8
    matchGrain?: boolean; // Default true
    grainIntensity?: number; // FFmpeg noise filter intensity (1 to 100), default 12
    deltaThreshold?: number; // Inpainting delta threshold for object insertion (0.01 - 0.50), default 0.08
    patchAssetId?: string; // MediaAsset ID of the generated video patch
    patchUrl?: string; // Physical or staged path to the patch video file
    status?: 'idle' | 'generating' | 'ready' | 'error';
    error?: string;
}

export interface AspectRatioDecision {
    aspectRatio: ApiAspectRatio;
    cropBox: BoundingBox;
    area: number;
    faceCollisions: number;
    reason: string;
}

export interface ResolutionDecision {
    tier: ApiResolutionTier;
    dimensions: { width: number; height: number };
    nativeLongEdge: number;
    samplingRatio: number; // API long edge / native crop long edge
    isSupersampled: boolean;
    reason: string;
}

export interface TileSegment {
    tileIndex: number;
    cropBox: BoundingBox;
    overlapPixels: number;
}

export interface MultiTilePlan {
    isMultiTile: boolean;
    tiles: TileSegment[];
}

/**
 * Checks whether two 2D bounding boxes overlap.
 */
export function doBoxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
    return (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
    );
}

/**
 * Centers a box of given width and height over a target centroid and clamps to frame boundaries.
 */
export function createCenteredClampedBox(
    centerX: number,
    centerY: number,
    width: number,
    height: number,
    frame: { width: number; height: number }
): BoundingBox {
    let x = Math.round(centerX - width / 2);
    let y = Math.round(centerY - height / 2);

    // Clamp coordinates within frame boundaries
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > frame.width) {
        x = Math.max(0, frame.width - width);
    }
    if (y + height > frame.height) {
        y = Math.max(0, frame.height - height);
    }

    return {
        x,
        y,
        width: Math.min(width, frame.width),
        height: Math.min(height, frame.height)
    };
}

/**
 * Logically deduces whether a 16:9 (horizontal) or 9:16 (vertical) crop envelope
 * is optimal for the given target defect/object.
 *
 * Minimizes total modified canvas area, ensures boundary compliance,
 * and penalizes overlap with human faces to dodge likeness safety filters.
 */
export function deduceOptimalAspectRatio(
    targetBox: BoundingBox,
    frame: { width: number; height: number },
    faceObstacles: BoundingBox[] = [],
    paddingPixels: number = 16
): AspectRatioDecision {
    const rawW = Math.max(4, targetBox.width + paddingPixels * 2);
    const rawH = Math.max(4, targetBox.height + paddingPixels * 2);

    const centerX = targetBox.x + targetBox.width / 2;
    const centerY = targetBox.y + targetBox.height / 2;

    // 1. Calculate minimal enclosing dimensions for 16:9
    const h_16_9 = Math.max(rawH, Math.round(rawW * (9 / 16)));
    const w_16_9 = Math.round(h_16_9 * (16 / 9));
    const box_16_9 = createCenteredClampedBox(centerX, centerY, w_16_9, h_16_9, frame);
    const area_16_9 = box_16_9.width * box_16_9.height;

    // 2. Calculate minimal enclosing dimensions for 9:16
    const w_9_16 = Math.max(rawW, Math.round(rawH * (9 / 16)));
    const h_9_16 = Math.round(w_9_16 * (16 / 9));
    const box_9_16 = createCenteredClampedBox(centerX, centerY, w_9_16, h_9_16, frame);
    const area_9_16 = box_9_16.width * box_9_16.height;

    // 3. Evaluate face obstacles (safety filter avoidance)
    const faceHits16 = faceObstacles.filter(f => doBoxesIntersect(box_16_9, f)).length;
    const faceHits9 = faceObstacles.filter(f => doBoxesIntersect(box_9_16, f)).length;

    // Cost function: Base area scaled by a severe penalty for face collisions
    const facePenaltyMultiplier = 25.0;
    const score16 = area_16_9 * (1.0 + faceHits16 * facePenaltyMultiplier);
    const score9 = area_9_16 * (1.0 + faceHits9 * facePenaltyMultiplier);

    if (score9 < score16) {
        const reason = faceHits16 > 0 && faceHits9 === 0
            ? '9:16 selected: avoids face collision detected in 16:9 crop'
            : `9:16 selected: minimal enclosing area (${area_9_16.toLocaleString()}px² vs ${area_16_9.toLocaleString()}px²)`;
        return {
            aspectRatio: '9:16',
            cropBox: box_9_16,
            area: area_9_16,
            faceCollisions: faceHits9,
            reason
        };
    } else {
        const reason = faceHits9 > 0 && faceHits16 === 0
            ? '16:9 selected: avoids face collision detected in 9:16 crop'
            : `16:9 selected: minimal enclosing area (${area_16_9.toLocaleString()}px² vs ${area_9_16.toLocaleString()}px²)`;
        return {
            aspectRatio: '16:9',
            cropBox: box_16_9,
            area: area_16_9,
            faceCollisions: faceHits16,
            reason
        };
    }
}

/**
 * Logically deduces the optimal API resolution tier (720p, 1080p, or 4K)
 * based on the physical pixel density of the crop on the native plate.
 *
 * Enforces the VFX Nyquist invariant: ALWAYS OVERSAMPLE, NEVER UPSAMPLE.
 * If working with 4K, 6K, or 8K plates, crops exceeding standard tiers
 * automatically escalate to 4K to guarantee zero softening when composited back.
 */
export function deduceOptimalResolution(
    cropBox: BoundingBox,
    aspectRatio: ApiAspectRatio,
    deliveryTarget: '1080p' | '4k' | '8k' = '4k',
    fidelityMode: 'mastering' | 'draft' = 'mastering'
): ResolutionDecision {
    const nativeLongEdge = Math.max(cropBox.width, cropBox.height);

    let tier: ApiResolutionTier = '720p';

    if (fidelityMode === 'draft') {
        tier = '720p';
    } else {
        // Mastering Mode: Ensure zero upsampling whenever possible
        if (nativeLongEdge <= 1280) {
            tier = '720p';
        } else if (nativeLongEdge <= 1920) {
            tier = '1080p';
        } else {
            tier = '4k';
        }

        // Delivery constraint ceiling:
        // If master delivery target is only 1080p, 4k is unnecessary overhead
        if (deliveryTarget === '1080p' && tier === '4k') {
            tier = '1080p';
        }
    }

    // Resolve exact pixel dimensions based on chosen orientation
    const dimensionMap: Record<ApiResolutionTier, Record<ApiAspectRatio, { width: number; height: number }>> = {
        '720p': {
            '16:9': { width: 1280, height: 720 },
            '9:16': { width: 720, height: 1280 }
        },
        '1080p': {
            '16:9': { width: 1920, height: 1080 },
            '9:16': { width: 1080, height: 1920 }
        },
        '4k': {
            '16:9': { width: 3840, height: 2160 },
            '9:16': { width: 2160, height: 3840 }
        }
    };

    const dimensions = dimensionMap[tier][aspectRatio];
    const apiLongEdge = Math.max(dimensions.width, dimensions.height);
    const samplingRatio = Number((apiLongEdge / nativeLongEdge).toFixed(3));
    const isSupersampled = samplingRatio >= 1.0;

    let reason = '';
    if (fidelityMode === 'draft') {
        reason = '720p selected for fast draft preview';
    } else if (tier === '4k') {
        reason = `4K selected: crop long edge (${nativeLongEdge}px) exceeds 1080p raster; preserves 6K/8K negative acuity (sampling ratio ${samplingRatio}x)`;
    } else if (tier === '1080p') {
        reason = `1080p selected: crop long edge (${nativeLongEdge}px) exceeds 720p raster (sampling ratio ${samplingRatio}x)`;
    } else {
        reason = `720p selected: native crop (${nativeLongEdge}px) fully covered without upsampling (sampling ratio ${samplingRatio}x)`;
    }

    return {
        tier,
        dimensions,
        nativeLongEdge,
        samplingRatio,
        isSupersampled,
        reason
    };
}

/**
 * Evaluates whether an extreme crop span (e.g. on an 8K plate or wide defect)
 * exceeds single-pass API resolution limits (> 3840px) or requires dual-tile decomposition.
 * Splits the region into adjacent overlapping tiles with a feathered blending margin.
 */
export function calculateMultiTilePlan(
    cropBox: BoundingBox,
    maxTileDimension: number = 3840,
    overlapRatio: number = 0.15
): MultiTilePlan {
    const isWide = cropBox.width > maxTileDimension;
    const isTall = cropBox.height > maxTileDimension;

    if (!isWide && !isTall) {
        return {
            isMultiTile: false,
            tiles: [
                {
                    tileIndex: 0,
                    cropBox: { ...cropBox },
                    overlapPixels: 0
                }
            ]
        };
    }

    const tiles: TileSegment[] = [];

    if (isWide) {
        // Horizontal split into 2 overlapping tiles
        const halfWidth = Math.round(cropBox.width / 2);
        const overlapPx = Math.round(halfWidth * overlapRatio);

        // Tile 0: Left tile spanning from 0 to halfWidth + overlap
        tiles.push({
            tileIndex: 0,
            cropBox: {
                x: cropBox.x,
                y: cropBox.y,
                width: halfWidth + overlapPx,
                height: cropBox.height
            },
            overlapPixels: overlapPx
        });

        // Tile 1: Right tile spanning from halfWidth - overlap to end
        tiles.push({
            tileIndex: 1,
            cropBox: {
                x: cropBox.x + halfWidth - overlapPx,
                y: cropBox.y,
                width: cropBox.width - (halfWidth - overlapPx),
                height: cropBox.height
            },
            overlapPixels: overlapPx
        });
    } else {
        // Vertical split into 2 overlapping tiles
        const halfHeight = Math.round(cropBox.height / 2);
        const overlapPx = Math.round(halfHeight * overlapRatio);

        tiles.push({
            tileIndex: 0,
            cropBox: {
                x: cropBox.x,
                y: cropBox.y,
                width: cropBox.width,
                height: halfHeight + overlapPx
            },
            overlapPixels: overlapPx
        });

        tiles.push({
            tileIndex: 1,
            cropBox: {
                x: cropBox.x + halfHeight - overlapPx,
                y: cropBox.y,
                width: cropBox.width,
                height: cropBox.height - (halfHeight - overlapPx)
            },
            overlapPixels: overlapPx
        });
    }

    return {
        isMultiTile: true,
        tiles
    };
}
