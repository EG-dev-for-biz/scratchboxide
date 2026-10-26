/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import { spawn } from 'child_process';
import { AdaptiveMaterialPbrService } from '../../3d-engine/adaptive-material-pbr-service';
import type { CameraIntrinsics } from '../../spatial/SpatialPoseEstimatorService';
import { VanishingPointHorizonEstimator } from '../../spatial/VanishingPointHorizonEstimator';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * Single-photo camera horizon / vanishing-point estimation. Decodes an arbitrary photo to
 * grayscale, extracts architectural line segments (scan-line luminance gradients), and solves the
 * analytical 3-point vanishing point problem (VanishingPointHorizonEstimator) to recover camera
 * pitch/roll and the optical horizon line from image geometry alone. A cheap precursor to full
 * PnP/resection camera calibration when no known 3D correspondences are available yet.
 */

/** Probes image dimensions via ffprobe when header parsing can't read them (formats other than JPEG/PNG). */
async function probeImageDimensionsViaFfprobe(buf: Buffer): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=s=x:p=0',
            'pipe:0'
        ]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('close', code => {
            if (code === 0 && out.trim()) {
                const parts = out.trim().split('x').map(Number);
                if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
                    resolve({ width: parts[0], height: parts[1] });
                    return;
                }
            }
            reject(new Error(`image_estimate_camera_horizon: could not read the image dimensions (ffprobe exited ${code})`));
        });
        proc.on('error', err => reject(new Error(`image_estimate_camera_horizon: could not read the image dimensions (ffprobe: ${err.message})`)));
        proc.stdin.write(buf);
        proc.stdin.end();
    });
}

/** Luminance-weighted RGBA -> grayscale conversion (ITU-R BT.709 coefficients). */
function rgbaToGrayscale(rgba: Buffer, width: number, height: number): Float32Array {
    const out = new Float32Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
        out[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    }
    return out;
}

export const VANISHING_POINT_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'image_estimate_camera_horizon',
        description:
            'Estimates camera pitch/roll and the optical horizon line from a single photo, purely from its architectural line geometry (vanishing points of vertical and horizontal facade lines) — no known 3D correspondences needed. Decodes the photo to grayscale, extracts line segments from luminance gradients, and analytically solves for the zenith and horizontal vanishing points, signed pitch (looking up vs down), roll, the horizon line in image space, and a rough altitude bound relative to a visible landmark. Useful as a cheap single-photo camera-calibration precursor to full PnP/resection, or to sanity-check a claimed camera angle.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input photo (JPEG, PNG, or any format ffmpeg/ffprobe can decode).'
                },
                minLineLengthPx: {
                    type: 'NUMBER',
                    description: 'Minimum pixel length for an extracted line segment to be kept (default: 4% of min(width, height)).'
                },
                gradientThreshold: {
                    type: 'NUMBER',
                    description: 'Minimum luminance gradient magnitude (0-255 scale) for a pixel to be treated as an edge while tracing line segments (default: 25.0).'
                },
                maxLines: {
                    type: 'NUMBER',
                    description: 'Maximum number of line segments to keep, ranked by weight (default: 150).'
                },
                fovYDeg: {
                    type: 'NUMBER',
                    description: 'Assumed vertical field of view in degrees, used to build the camera intrinsics the solver needs when none are known (default: 40).'
                },
                landmarkBaseElevationMeters: {
                    type: 'NUMBER',
                    description: 'Optional known ground elevation (meters) of a visible landmark, used to tighten the returned altitude bounds.'
                },
                landmarkHeightMeters: {
                    type: 'NUMBER',
                    description: 'Optional known height (meters) of a visible landmark, used to tighten the returned altitude bounds (default: 70).'
                }
            },
            required: ['imagePath']
        }
    }
];

interface EstimateCameraHorizonRequest {
    imagePath: string;
    minLineLengthPx?: number;
    gradientThreshold?: number;
    maxLines?: number;
    fovYDeg?: number;
    landmarkBaseElevationMeters?: number;
    landmarkHeightMeters?: number;
}

async function estimateCameraHorizonHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as EstimateCameraHorizonRequest;
    try {
        const { imagePath } = request;
        if (!imagePath || typeof imagePath !== 'string') {
            return { status: 'failed', resultPayload: { error: 'imagePath is required' } };
        }
        if (!fs.existsSync(imagePath)) {
            return { status: 'failed', resultPayload: { error: `Image file not found: ${imagePath}` } };
        }

        const imageBuf = fs.readFileSync(imagePath);

        let dims = AdaptiveMaterialPbrService.parseImageDimensions(imageBuf);
        if (!dims) {
            dims = await probeImageDimensionsViaFfprobe(imageBuf);
        }
        const { width, height } = dims;

        const rgba = await AdaptiveMaterialPbrService.decodeToRgba(imageBuf);
        if (rgba.length < width * height * 4) {
            return {
                status: 'failed',
                resultPayload: { error: `Failed to decode image to RGBA (got ${rgba.length} bytes, expected ${width * height * 4} for ${width}x${height}). Is ffmpeg installed?` }
            };
        }

        const grayscale = rgbaToGrayscale(rgba, width, height);

        const lines = VanishingPointHorizonEstimator.extractLineSegments(grayscale, width, height, {
            minLineLengthPx: typeof request.minLineLengthPx === 'number' ? request.minLineLengthPx : undefined,
            gradientThreshold: typeof request.gradientThreshold === 'number' ? request.gradientThreshold : undefined,
            maxLines: typeof request.maxLines === 'number' ? request.maxLines : undefined
        });

        const fovYDeg = typeof request.fovYDeg === 'number' ? request.fovYDeg : 40.0;
        const fy = (height / 2.0) / Math.tan((fovYDeg / 2.0) * (Math.PI / 180.0));
        const intrinsics: CameraIntrinsics = { fx: fy, fy, cx: width / 2.0, cy: height / 2.0, width, height };

        const result = VanishingPointHorizonEstimator.solveFromLines(lines, intrinsics, {
            landmarkBaseElevationMeters: typeof request.landmarkBaseElevationMeters === 'number' ? request.landmarkBaseElevationMeters : undefined,
            landmarkHeightMeters: typeof request.landmarkHeightMeters === 'number' ? request.landmarkHeightMeters : undefined
        });

        return {
            status: 'completed',
            resultPayload: {
                imagePath,
                imageWidth: width,
                imageHeight: height,
                lineSegmentCount: lines.length,
                ...result
            },
            summaryResult: `Camera horizon: pitch ${result.pitchDeg.toFixed(1)}°, roll ${result.rollDeg.toFixed(1)}° (${result.classification}), ${lines.length} line segments (confidence ${result.metrics.confidence.toFixed(2)}).`
        };
    } catch (e) {
        return { status: 'failed', resultPayload: { error: String(e instanceof Error ? e.message : e) } };
    }
}

export const vanishingPointHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [VANISHING_POINT_TOOL_DECLARATIONS[0], estimateCameraHorizonHandler]
];
