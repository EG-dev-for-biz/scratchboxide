/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface BuildContactSheetRequest {
    /** Absolute paths to input images */
    imagePaths: string[];
    /** Width of each panel in the strip (default: 512) */
    panelWidthPx?: number;
    /** Height of each panel in the strip (default: 512) */
    panelHeightPx?: number;
    /** Number of columns in the strip (default: all images in one row) */
    columns?: number;
    /** Absolute output path for the composited strip */
    outputPath: string;
}

export interface BuildContactSheetResult {
    outputPath: string;
    widthPx: number;
    heightPx: number;
    panelCount: number;
}

export interface NormalizePlatesRequest {
    /** Absolute paths to input images */
    imagePaths: string[];
    /** Target width for all output plates */
    targetWidth: number;
    /** Target height for all output plates */
    targetHeight: number;
    /** Directory to write normalized plates */
    outputDir: string;
    /** Maximum allowed anchor drift in pixels before the check fails (default: 5) */
    maxAnchorDriftPx?: number;
}

export interface AnchorPoint {
    x: number;
    y: number;
}

export interface NormalizePlatesResult {
    outputPaths: string[];
    anchors: AnchorPoint[];
    maxDriftPx: number;
    driftCheckPassed: boolean;
}

/**
 * Builds a borderless multi-panel contact sheet from a list of images.
 * Higher panel counts = higher constraint density when used as a conditioning input.
 * Uses FFmpeg for compositing so no separate image library is required.
 */
export async function buildContactSheet(request: BuildContactSheetRequest): Promise<BuildContactSheetResult> {
    const {
        imagePaths,
        panelWidthPx = 512,
        panelHeightPx = 512,
        outputPath
    } = request;

    const columns = request.columns ?? imagePaths.length;
    const rows = Math.ceil(imagePaths.length / columns);
    const totalWidth = columns * panelWidthPx;
    const totalHeight = rows * panelHeightPx;

    // Build FFmpeg filtergraph to tile images into a contact sheet
    // Each input is scaled to panel dimensions, then all are laid out with xstack
    const inputArgs: string[] = [];
    for (const p of imagePaths) {
        inputArgs.push('-i', p);
    }

    const filterParts: string[] = [];
    // Scale each input to uniform panel size
    for (let i = 0; i < imagePaths.length; i++) {
        filterParts.push(`[${i}:v]scale=${panelWidthPx}:${panelHeightPx}:force_original_aspect_ratio=decrease,pad=${panelWidthPx}:${panelHeightPx}:(ow-iw)/2:(oh-ih)/2[p${i}]`);
    }

    const panelRefs = imagePaths.map((_, i) => `[p${i}]`).join('');
    filterParts.push(`${panelRefs}xstack=inputs=${imagePaths.length}:layout=${
        imagePaths.map((_, i) => `${(i % columns) * panelWidthPx}_${Math.floor(i / columns) * panelHeightPx}`).join('|')
    }[out]`);

    const filterGraph = filterParts.join(';');

    await execFileAsync('ffmpeg', [
        ...inputArgs,
        '-filter_complex', filterGraph,
        '-map', '[out]',
        '-frames:v', '1',
        '-y',
        outputPath
    ]);

    return {
        outputPath,
        widthPx: totalWidth,
        heightPx: totalHeight,
        panelCount: imagePaths.length
    };
}

/**
 * Normalizes conditioning plates to a uniform size and verifies spatial anchor stability.
 *
 * Anchor detection: scans the bottom 25 rows of each image for the lowest non-transparent
 * pixel (alpha > 0) and derives the base center X coordinate. Spread > maxAnchorDriftPx
 * indicates detectable spatial drift between plates.
 *
 * Uses FFmpeg for resizing and raw pixel extraction.
 */
export async function normalizePlates(request: NormalizePlatesRequest): Promise<NormalizePlatesResult> {
    const {
        imagePaths,
        targetWidth,
        targetHeight,
        outputDir,
        maxAnchorDriftPx = 5
    } = request;

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPaths: string[] = [];
    const anchors: AnchorPoint[] = [];

    for (const imgPath of imagePaths) {
        const basename = path.basename(imgPath, path.extname(imgPath));
        const outPath = path.join(outputDir, `${basename}_normalized.png`);

        // Resize to target dimensions preserving aspect ratio with padding
        await execFileAsync('ffmpeg', [
            '-i', imgPath,
            '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
            '-frames:v', '1',
            '-y',
            outPath
        ]);

        outputPaths.push(outPath);

        // Extract raw RGBA pixels for the bottom 25 rows to find base center anchor
        // Use rawvideo pipe: extract bottom strip as raw RGBA
        const scanHeight = 25;
        const rawBuf = await extractRawRgba(outPath, targetWidth, scanHeight, targetHeight - scanHeight);

        const anchorPt = findBaseAnchor(rawBuf, targetWidth, scanHeight, targetHeight - scanHeight);
        anchors.push(anchorPt);
    }

    // Compute max drift across all anchor X coordinates
    const anchorXValues = anchors.map(a => a.x);
    const minX = Math.min(...anchorXValues);
    const maxX = Math.max(...anchorXValues);
    const maxDriftPx = maxX - minX;

    return {
        outputPaths,
        anchors,
        maxDriftPx,
        driftCheckPassed: maxDriftPx <= maxAnchorDriftPx
    };
}

async function extractRawRgba(
    imagePath: string,
    width: number,
    cropHeight: number,
    cropY: number
): Promise<Buffer> {
    const { stdout } = await execFileAsync('ffmpeg', [
        '-i', imagePath,
        '-vf', `crop=${width}:${cropHeight}:0:${cropY}`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-frames:v', '1',
        'pipe:1'
    ], { encoding: 'buffer', maxBuffer: width * cropHeight * 4 * 2 } as any);
    return stdout as unknown as Buffer;
}

function findBaseAnchor(rawRgba: Buffer, width: number, scanHeight: number, yOffset: number): AnchorPoint {
    let lowestY = -1;
    let sumX = 0;
    let count = 0;

    for (let row = 0; row < scanHeight; row++) {
        for (let col = 0; col < width; col++) {
            const idx = (row * width + col) * 4;
            const alpha = rawRgba[idx + 3] ?? 0;
            if (alpha > 0) {
                const absY = yOffset + row;
                if (absY > lowestY) {
                    lowestY = absY;
                    sumX = col;
                    count = 1;
                } else if (absY === lowestY) {
                    sumX += col;
                    count++;
                }
            }
        }
    }

    if (count > 0) {
        return { x: sumX / count, y: lowestY };
    }
    return { x: width / 2, y: yOffset + scanHeight };
}
