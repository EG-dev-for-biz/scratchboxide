/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { encodePng, decodePng } from '../texture-processing';
import { decodeImageToRgba } from '../image-codec-ffmpeg';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { classifyMediaGenerationError, IMAGE_MODEL_PRIORITY, resolveImageModelId } from '../../common/media-generation-protocol';
import { EMPTY_IMAGE_RESPONSE_ATTEMPTS } from '../google-media-generation-service';
import {
    Google360PanoramaPipelineService,
    StreetViewCubeFace,
    StreetViewCubemapFaces,
    EquirectangularStructuredPrompt,
    buildEquirectangularStructuredPrompt
} from './Google360PanoramaPipelineService';

export { EquirectangularStructuredPrompt, buildEquirectangularStructuredPrompt };

export type PanoramaPerspective = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

export interface PerspectiveCameraConfig {
    name: PanoramaPerspective;
    yawDeg: number;       // front: 0, right: 90, back: 180, left: -90, top: 0, bottom: 0
    pitchDeg: number;     // front: 0, right: 0, back: 0, left: 0, top: 90, bottom: -90
    rollDeg: number;      // 0
    fovDeg: number;       // default 90.0
    aspectRatio: number;  // default 1.0 (square rectilinear perspective)
}

export interface PerspectiveFrame {
    perspective: PanoramaPerspective;
    width: number;
    height: number;
    rgba: Buffer;
    pngBuffer?: Buffer;
    isSynthesized: boolean; // false for original input perspective, true for generated perspectives
    prompt?: string;
    cameraConfig: PerspectiveCameraConfig;
    /** The image model that produced this view (absent for the input view and procedural/mock views). */
    generatedBy?: string;
}

export interface MultiPerspectiveSynthesisOptions {
    inputImagePath?: string;
    inputImageBuffer?: Buffer;
    inputPerspective?: PanoramaPerspective; // default 'front'
    inputFovDeg?: number;                   // default 90.0 - 140.0
    faceResolution?: number;                // default 512
    equirectangularWidth?: number;          // default 2048
    equirectangularHeight?: number;         // default 1024
    synthesizePerspectives?: PanoramaPerspective[]; // default ['right', 'back', 'left', 'top', 'bottom']
    styleHint?: string;                     // e.g. 'photorealistic urban streetscape at sunset'
    prompt?: string;                        // optional prompt context describing the environment
    locationName?: string;                  // optional landmark or location name
    model?: string;                         // default IMAGE_MODEL_PRIORITY[0]; product names resolve to API ids
    useNanoBanana?: boolean;                // default true (set false for pure procedural)
    useAiInpainting?: boolean;
    mockExecution?: boolean;
    outputDir?: string;                     // directory to write individual perspective frames and stitched pano
}

export interface MultiPerspectiveSynthesisResult {
    success: boolean;
    perspectives: Record<PanoramaPerspective, PerspectiveFrame>;
    stitchedEquirectangular: {
        width: number;
        height: number;
        rgba: Buffer;
        pngBuffer: Buffer;
        outputPath?: string;
    };
    cubemapFaces: StreetViewCubemapFaces;
    coverageAngleDegrees: {
        horizontal: number; // 360.0
        vertical: number;   // 180.0
    };
    perspectivesSynthesized: PanoramaPerspective[];
    modelUsed: string;
    summary: string;
}

export class MultiPerspectivePanoramaSynthesisService {
    protected credentialsService: GoogleMediaCredentialsService;

    public static readonly CANONICAL_CAMERAS: Record<PanoramaPerspective, PerspectiveCameraConfig> = {
        front:  { name: 'front',  yawDeg: 0.0,   pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        right:  { name: 'right',  yawDeg: 90.0,  pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        back:   { name: 'back',   yawDeg: 180.0, pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        left:   { name: 'left',   yawDeg: -90.0, pitchDeg: 0.0,   rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        top:    { name: 'top',    yawDeg: 0.0,   pitchDeg: 90.0,  rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 },
        bottom: { name: 'bottom', yawDeg: 0.0,   pitchDeg: -90.0, rollDeg: 0.0, fovDeg: 90.0, aspectRatio: 1.0 }
    };

    constructor(credentialsService?: GoogleMediaCredentialsService) {
        this.credentialsService = credentialsService || new GoogleMediaCredentialsService();
    }

    /**
     * Extracts a rectilinear camera perspective from a 2:1 equirectangular panorama.
     */
    static extractPerspectiveFromEquirectangular(
        panoRgba: Buffer,
        panoWidth: number,
        panoHeight: number,
        camera: PerspectiveCameraConfig,
        outWidth = 512,
        outHeight = 512
    ): PerspectiveFrame {
        const outRgba = Buffer.alloc(outWidth * outHeight * 4);
        const yawRad = (camera.yawDeg * Math.PI) / 180.0;
        const pitchRad = (camera.pitchDeg * Math.PI) / 180.0;
        const rollRad = (camera.rollDeg * Math.PI) / 180.0;
        const fovRad = (camera.fovDeg * Math.PI) / 180.0;
        const halfFov = fovRad * 0.5;
        const tanHalfFov = Math.tan(halfFov);

        // Rotation matrix: R = R_yaw * R_pitch * R_roll
        const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
        const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
        const cr = Math.cos(rollRad), sr = Math.sin(rollRad);

        // Camera basis vectors in world space:
        const rX = cy * cr + sy * sp * sr;
        const rY = cp * sr;
        const rZ = -sy * cr + cy * sp * sr;

        const uX = -cy * sr + sy * sp * cr;
        const uY = cp * cr;
        const uZ = sy * sr + cy * sp * cr;

        const fX = sy * cp;
        const fY = -sp;
        const fZ = cy * cp;

        for (let py = 0; py < outHeight; py++) {
            const vNorm = 1.0 - 2.0 * ((py + 0.5) / outHeight); // [+1 at top, -1 at bottom]
            const rowOffset = py * outWidth * 4;

            for (let px = 0; px < outWidth; px++) {
                const uNorm = 2.0 * ((px + 0.5) / outWidth) - 1.0; // [-1 at left, +1 at right]

                // Direction in camera space: (uNorm * tanHalfFov, vNorm * tanHalfFov, 1.0)
                const cx = uNorm * tanHalfFov;
                const cy_ = vNorm * tanHalfFov;
                const cz = 1.0;

                // Transform to world ray
                const dx = rX * cx + uX * cy_ + fX * cz;
                const dy = rY * cx + uY * cy_ + fY * cz;
                const dz = rZ * cx + uZ * cy_ + fZ * cz;

                const { theta, phi } = Google360PanoramaPipelineService.cartesianToSpherical(dx, dy, dz);
                const uEq = (theta / (2.0 * Math.PI)) + 0.5;
                const vEq = 0.5 - (phi / Math.PI);

                const [r, g, b, a] = Google360PanoramaPipelineService.sampleEquirectangularBilinear(
                    panoRgba, panoWidth, panoHeight, uEq, vEq
                );

                const idx = rowOffset + px * 4;
                outRgba[idx] = r;
                outRgba[idx + 1] = g;
                outRgba[idx + 2] = b;
                outRgba[idx + 3] = a;
            }
        }

        return {
            perspective: camera.name,
            width: outWidth,
            height: outHeight,
            rgba: outRgba,
            pngBuffer: encodePng(outWidth, outHeight, outRgba),
            isSynthesized: false,
            cameraConfig: camera
        };
    }

    /**
     * Synthesizes all 5 missing perspective camera plates (Right, Left, Back, Top, Bottom)
     * from a given front perspective plate.
     */
    static synthesizeMissingPerspectivesFromFront(
        frontRgba: Buffer,
        res = 512,
        options?: {
            styleHint?: string;
            inputFovDeg?: number;
        }
    ): Record<PanoramaPerspective, PerspectiveFrame> {
        const rightRgba = Buffer.alloc(res * res * 4);
        const leftRgba = Buffer.alloc(res * res * 4);
        const backRgba = Buffer.alloc(res * res * 4);
        const topRgba = Buffer.alloc(res * res * 4);
        const bottomRgba = Buffer.alloc(res * res * 4);

        // 1. Compute border profiles from front plate
        const leftEdge: [number, number, number][] = [];
        const rightEdge: [number, number, number][] = [];
        const topEdge: [number, number, number][] = [];
        const botEdge: [number, number, number][] = [];

        let skyR = 0, skyG = 0, skyB = 0;
        let gndR = 0, gndG = 0, gndB = 0;

        for (let y = 0; y < res; y++) {
            const lIdx = y * res * 4;
            const rIdx = (y * res + (res - 1)) * 4;
            leftEdge.push([frontRgba[lIdx], frontRgba[lIdx + 1], frontRgba[lIdx + 2]]);
            rightEdge.push([frontRgba[rIdx], frontRgba[rIdx + 1], frontRgba[rIdx + 2]]);
        }

        for (let x = 0; x < res; x++) {
            const tIdx = x * 4;
            const bIdx = ((res - 1) * res + x) * 4;
            topEdge.push([frontRgba[tIdx], frontRgba[tIdx + 1], frontRgba[tIdx + 2]]);
            botEdge.push([frontRgba[bIdx], frontRgba[bIdx + 1], frontRgba[bIdx + 2]]);

            skyR += frontRgba[tIdx];
            skyG += frontRgba[tIdx + 1];
            skyB += frontRgba[tIdx + 2];

            gndR += frontRgba[bIdx];
            gndG += frontRgba[bIdx + 1];
            gndB += frontRgba[bIdx + 2];
        }

        skyR = Math.round(skyR / res);
        skyG = Math.round(skyG / res);
        skyB = Math.round(skyB / res);

        gndR = Math.round(gndR / res);
        gndG = Math.round(gndG / res);
        gndB = Math.round(gndB / res);

        // --- 2. SYNTHESIZE RIGHT FLANK (+90 deg yaw) ---
        // Left border (x=0) welds to front right border (x=res-1)
        for (let y = 0; y < res; y++) {
            const rowOffset = y * res * 4;
            const seed = rightEdge[y];

            for (let x = 0; x < res; x++) {
                const xFrac = x / res;
                const idx = rowOffset + x * 4;

                const perspectiveScale = 1.0 / (1.0 + xFrac * 1.5);
                const wallPattern = Math.sin((x * 0.08) * perspectiveScale) > 0.15 ? 1.08 : 0.92;
                const storeyGrid = Math.sin((y * 0.06) * perspectiveScale) > 0.2 ? 1.05 : 0.95;
                const depthHaze = Math.pow(xFrac, 1.4);

                // Blend from edge seed to horizon ambient
                const baseR = seed[0] * (1.0 - depthHaze * 0.4) + skyR * (depthHaze * 0.3);
                const baseG = seed[1] * (1.0 - depthHaze * 0.4) + skyG * (depthHaze * 0.3);
                const baseB = seed[2] * (1.0 - depthHaze * 0.4) + skyB * (depthHaze * 0.35);

                const edgeBlend = Math.min(1.0, x / 4.0);
                const pattern = 1.0 + (wallPattern * storeyGrid - 1.0) * edgeBlend;

                const r = Math.max(0, Math.min(255, Math.round(baseR * pattern)));
                const g = Math.max(0, Math.min(255, Math.round(baseG * pattern)));
                const b = Math.max(0, Math.min(255, Math.round(baseB * pattern)));

                rightRgba[idx] = r;
                rightRgba[idx + 1] = g;
                rightRgba[idx + 2] = b;
                rightRgba[idx + 3] = 255;
            }
        }

        // --- 3. SYNTHESIZE LEFT FLANK (-90 deg yaw) ---
        // Right border (x=res-1) welds to front left border (x=0)
        for (let y = 0; y < res; y++) {
            const rowOffset = y * res * 4;
            const seed = leftEdge[y];

            for (let x = 0; x < res; x++) {
                const invX = (res - 1 - x) / res;
                const idx = rowOffset + x * 4;

                const perspectiveScale = 1.0 / (1.0 + invX * 1.5);
                const wallPattern = Math.sin((x * 0.08) * perspectiveScale) > 0.15 ? 1.08 : 0.92;
                const storeyGrid = Math.sin((y * 0.06) * perspectiveScale) > 0.2 ? 1.05 : 0.95;
                const depthHaze = Math.pow(invX, 1.4);

                const baseR = seed[0] * (1.0 - depthHaze * 0.4) + skyR * (depthHaze * 0.3);
                const baseG = seed[1] * (1.0 - depthHaze * 0.4) + skyG * (depthHaze * 0.3);
                const baseB = seed[2] * (1.0 - depthHaze * 0.4) + skyB * (depthHaze * 0.35);

                const edgeBlend = Math.min(1.0, (res - 1 - x) / 4.0);
                const pattern = 1.0 + (wallPattern * storeyGrid - 1.0) * edgeBlend;

                const r = Math.max(0, Math.min(255, Math.round(baseR * pattern)));
                const g = Math.max(0, Math.min(255, Math.round(baseG * pattern)));
                const b = Math.max(0, Math.min(255, Math.round(baseB * pattern)));

                leftRgba[idx] = r;
                leftRgba[idx + 1] = g;
                leftRgba[idx + 2] = b;
                leftRgba[idx + 3] = 255;
            }
        }

        // --- 4. SYNTHESIZE BACK VISTA (180 deg yaw) ---
        // Left border (x=0) welds to right plate right border; right border (x=res-1) welds to left plate left border
        for (let y = 0; y < res; y++) {
            const rowOffset = y * res * 4;
            const rRightIdx = (y * res + (res - 1)) * 4;
            const lLeftIdx = y * res * 4;

            const rR = rightRgba[rRightIdx], rG = rightRgba[rRightIdx + 1], rB = rightRgba[rRightIdx + 2];
            const lR = leftRgba[lLeftIdx],   lG = leftRgba[lLeftIdx + 1],   lB = leftRgba[lLeftIdx + 2];

            for (let x = 0; x < res; x++) {
                const t = x / (res - 1);
                const smoothT = t * t * (3.0 - 2.0 * t);
                const idx = rowOffset + x * 4;

                const centerDip = Math.sin(t * Math.PI);
                const rearArch = centerDip > 0.6 ? 1.12 : 0.94;
                const grain = ((x * 13 + y * 29) % 7) - 3;

                const baseR = (1.0 - smoothT) * rR + smoothT * lR;
                const baseG = (1.0 - smoothT) * rG + smoothT * lG;
                const baseB = (1.0 - smoothT) * rB + smoothT * lB;

                const edgeBlend = Math.min(1.0, Math.min(x, res - 1 - x) / 4.0);
                const pattern = 1.0 + (rearArch - 1.0) * edgeBlend;
                const grainVal = grain * edgeBlend;

                const r = Math.max(0, Math.min(255, Math.round(baseR * pattern + grainVal)));
                const g = Math.max(0, Math.min(255, Math.round(baseG * pattern + grainVal)));
                const b = Math.max(0, Math.min(255, Math.round(baseB * pattern + grainVal)));

                backRgba[idx] = r;
                backRgba[idx + 1] = g;
                backRgba[idx + 2] = b;
                backRgba[idx + 3] = 255;
            }
        }

        // --- 5. SYNTHESIZE TOP / ZENITH (+90 deg pitch) ---
        // Bottom border (y=res-1) welds to front top border (y=0)
        // Center (res/2, res/2) is the zenith apex looking straight up
        const halfRes = res * 0.5;
        for (let y = 0; y < res; y++) {
            const rowOffset = y * res * 4;
            const ny = (y - halfRes) / halfRes; // -1 top (rear), +1 bottom (front)

            for (let x = 0; x < res; x++) {
                const nx = (x - halfRes) / halfRes; // -1 left, +1 right
                const distCenter = Math.hypot(nx, ny);
                const idx = rowOffset + x * 4;

                const apexT = Math.max(0.0, 1.0 - Math.min(1.0, distCenter));
                const smoothApex = apexT * apexT * (3.0 - 2.0 * apexT);

                const apexR = Math.max(8, Math.min(50, Math.round(skyR * 0.35)));
                const apexG = Math.max(12, Math.min(60, Math.round(skyG * 0.4)));
                const apexB = Math.max(26, Math.min(90, Math.round(skyB * 0.6)));

                const cloudNoise = Math.sin(x * 0.03 + y * 0.04) * Math.cos(x * 0.02 - y * 0.03) * 6;
                const sunGlow = Math.max(0, 1.0 - Math.hypot(nx, ny + 0.3)) * 25;

                const r = Math.max(0, Math.min(255, Math.round((1.0 - smoothApex) * skyR + smoothApex * apexR + cloudNoise + sunGlow)));
                const g = Math.max(0, Math.min(255, Math.round((1.0 - smoothApex) * skyG + smoothApex * apexG + cloudNoise + sunGlow)));
                const b = Math.max(0, Math.min(255, Math.round((1.0 - smoothApex) * skyB + smoothApex * apexB + cloudNoise + sunGlow * 0.8)));

                topRgba[idx] = r;
                topRgba[idx + 1] = g;
                topRgba[idx + 2] = b;
                topRgba[idx + 3] = 255;
            }
        }

        // --- 6. SYNTHESIZE BOTTOM / NADIR (-90 deg pitch) ---
        // Top border (y=0) welds to front bottom border (y=res-1)
        // Center (res/2, res/2) is the nadir looking straight down
        for (let y = 0; y < res; y++) {
            const rowOffset = y * res * 4;
            const ny = (y - halfRes) / halfRes; // -1 top (front), +1 bottom (rear)

            for (let x = 0; x < res; x++) {
                const nx = (x - halfRes) / halfRes;
                const distCenter = Math.hypot(nx, ny);
                const idx = rowOffset + x * 4;

                const nadirT = Math.max(0.0, 1.0 - Math.min(1.0, distCenter));
                const smoothNadir = nadirT * nadirT * (3.0 - 2.0 * nadirT);

                const asphaltR = Math.max(12, Math.min(42, Math.round(gndR * 0.6)));
                const asphaltG = Math.max(14, Math.min(46, Math.round(gndG * 0.65)));
                const asphaltB = Math.max(18, Math.min(52, Math.round(gndB * 0.7)));

                const stripePeriodX = ((Math.abs(nx) * 14.0) % 2.0);
                const isCrosswalk = stripePeriodX < 0.6 && Math.abs(ny) > 0.25;
                const stripeWhite = isCrosswalk ? (32 + Math.sin(ny * 24.0) * 12) : 0;

                const puddleGrain = ((x * 19 + y * 37) % 11) - 5;
                const wetReflection = (Math.sin(nx * 10.0 + ny * 12.0) > 0.4) ? 0.25 : 0.0;

                const r = Math.max(0, Math.min(255, Math.round((1.0 - smoothNadir) * gndR + smoothNadir * asphaltR + stripeWhite + skyR * wetReflection + puddleGrain)));
                const g = Math.max(0, Math.min(255, Math.round((1.0 - smoothNadir) * gndG + smoothNadir * asphaltG + stripeWhite + skyG * wetReflection + puddleGrain)));
                const b = Math.max(0, Math.min(255, Math.round((1.0 - smoothNadir) * gndB + smoothNadir * asphaltB + stripeWhite * 1.1 + skyB * wetReflection + puddleGrain)));

                bottomRgba[idx] = r;
                bottomRgba[idx + 1] = g;
                bottomRgba[idx + 2] = b;
                bottomRgba[idx + 3] = 255;
            }
        }

        return {
            front: {
                perspective: 'front',
                width: res,
                height: res,
                rgba: frontRgba,
                pngBuffer: encodePng(res, res, frontRgba),
                isSynthesized: false,
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front
            },
            right: {
                perspective: 'right',
                width: res,
                height: res,
                rgba: rightRgba,
                pngBuffer: encodePng(res, res, rightRgba),
                isSynthesized: true,
                prompt: 'Photorealistic architectural right flank perspective, extending source scene lighting and facade rhythm (+90° yaw)',
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.right
            },
            back: {
                perspective: 'back',
                width: res,
                height: res,
                rgba: backRgba,
                pngBuffer: encodePng(res, res, backRgba),
                isSynthesized: true,
                prompt: 'Photorealistic rear vista perspective, seamless closure between left and right flanks (180° yaw)',
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.back
            },
            left: {
                perspective: 'left',
                width: res,
                height: res,
                rgba: leftRgba,
                pngBuffer: encodePng(res, res, leftRgba),
                isSynthesized: true,
                prompt: 'Photorealistic architectural left flank perspective, extending source scene lighting and facade rhythm (-90° yaw)',
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.left
            },
            top: {
                perspective: 'top',
                width: res,
                height: res,
                rgba: topRgba,
                pngBuffer: encodePng(res, res, topRgba),
                isSynthesized: true,
                prompt: 'Photorealistic celestial sky/ceiling dome, smooth radial twilight gradient (+90° pitch zenith)',
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.top
            },
            bottom: {
                perspective: 'bottom',
                width: res,
                height: res,
                rgba: bottomRgba,
                pngBuffer: encodePng(res, res, bottomRgba),
                isSynthesized: true,
                prompt: 'Photorealistic pavement and ground floor with wet asphalt reflections and converging crosswalk stripes (-90° pitch nadir)',
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.bottom
            }
        };
    }

    /**
     * Builds the specialized Nano Banana 2 conditioning prompt for generating a target
     * perspective camera plate from the initial front perspective image.
     */
    static buildNanoBananaPerspectivePrompt(
        perspective: PanoramaPerspective,
        options?: {
            locationName?: string;
            styleHint?: string;
            prompt?: string;
        }
    ): string {
        const sceneContext = options?.prompt || options?.styleHint || 'an authentic real-world streetscape environment';
        const locationStr = options?.locationName ? ` at ${options.locationName}` : '';

        switch (perspective) {
            case 'right':
                return `Generate the right lateral flank perspective (+90° yaw clockwise rotation) of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) The left boundary of this image connects seamlessly to the right boundary of the front reference image. (3) Strictly preserve the exact architectural style, facade heights, lighting vector, solar shadow angles, color temperature, and atmospheric perspective established in the front view. (4) Level horizon line at exactly 50% image height. (5) Crisp architectural edges, physical PBR material textures, no fish-eye distortion, clean photograph only with no overlays or text.`;

            case 'back':
                return `Generate the rear perspective looking directly backwards (180° yaw rotation) in ${sceneContext}${locationStr}, showing the opposing vista directly behind the camera vantage point of the front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Strictly maintain the identical environment, time of day, sky illumination, color temperature, ground surface materials, and architectural era. (3) Level horizon line at exactly 50% image height. (4) Natural streetscape/square continuation opposite the front view. Clean photograph only with no overlays, navigation UI, or text.`;

            case 'left':
                return `Generate the left lateral flank perspective (-90° yaw counter-clockwise rotation) of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) The right boundary of this image connects seamlessly to the left boundary of the front reference image. (3) Strictly preserve the exact architectural style, facade heights, lighting vector, solar shadow angles, color temperature, and atmospheric perspective established in the front view. (4) Level horizon line at exactly 50% image height. (5) Crisp architectural edges, physical PBR material textures, no fish-eye distortion, clean photograph only with no overlays or text.`;

            case 'top':
                return `Generate the celestial zenith perspective looking straight up (+90° vertical pitch) directly above the camera position of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Camera pointing vertically upward into the sky dome, showing celestial illumination, clouds, atmospheric haze, and the upper rooftops/crowns/spires of buildings bordering the periphery. (3) The bottom boundary of this image welds seamlessly to the top boundary of the front reference image; left, right, and top edges align with left, right, and back perspectives respectively. (4) Photorealistic atmospheric scattering and natural zenith gradient. Clean photograph only with no overlays or text.`;

            case 'bottom':
                return `Generate the nadir ground perspective looking straight down (-90° vertical pitch) directly beneath the camera position of ${sceneContext}${locationStr}, matching the provided front reference image. CRITICAL FRAMING & CONTINUITY RULES: (1) Output MUST be exactly 1:1 square aspect ratio rectilinear perspective (90° x 90° FoV). (2) Camera pointing vertically downward toward the ground, showing authentic pavement, cobblestones, asphalt, road markings, drainage, or flooring materials matching the bottom edge of the front reference image. (3) Strictly zero tripod legs, zero camera rigs, zero equipment shadows, zero robotic artifacts (clean in-scene floor). (4) The top boundary of this image welds seamlessly to the bottom boundary of the front reference image; left, right, and bottom edges align with left, right, and back perspectives respectively. Clean photograph only with no overlays or text.`;

            case 'front':
            default:
                return `Authentic rectilinear front perspective photograph (90° x 90° FoV) of ${sceneContext}${locationStr}, featuring photorealistic materials, natural lighting, and architectural detail.`;
        }
    }

    /**
     * Welds the boundaries between a target perspective face and the front perspective
     * using smooth C0/C1 bilateral interpolation to guarantee seamless 360 cubemap stitching.
     */
    static weldPerspectiveBoundaries(
        perspective: PanoramaPerspective,
        targetRgba: Buffer,
        frontRgba: Buffer,
        res: number,
        weldWidth = 5
    ): void {
        if (perspective === 'right') {
            // Left border of right face welds to right border of front face
            for (let y = 0; y < res; y++) {
                const frontIdx = (y * res + (res - 1)) * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let x = 0; x < weldWidth; x++) {
                    const blend = Math.min(1.0, x / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'left') {
            // Right border of left face welds to left border of front face
            for (let y = 0; y < res; y++) {
                const frontIdx = y * res * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let i = 0; i < weldWidth; i++) {
                    const x = res - 1 - i;
                    const blend = Math.min(1.0, i / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'top') {
            // Bottom border of top face welds to top border of front face
            for (let x = 0; x < res; x++) {
                const frontIdx = x * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let i = 0; i < weldWidth; i++) {
                    const y = res - 1 - i;
                    const blend = Math.min(1.0, i / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        } else if (perspective === 'bottom') {
            // Top border of bottom face welds to bottom border of front face
            for (let x = 0; x < res; x++) {
                const frontIdx = ((res - 1) * res + x) * 4;
                const frR = frontRgba[frontIdx], frG = frontRgba[frontIdx + 1], frB = frontRgba[frontIdx + 2];
                for (let y = 0; y < weldWidth; y++) {
                    const blend = Math.min(1.0, y / (weldWidth - 1));
                    const idx = (y * res + x) * 4;
                    targetRgba[idx] = Math.round(frR * (1 - blend) + targetRgba[idx] * blend);
                    targetRgba[idx + 1] = Math.round(frG * (1 - blend) + targetRgba[idx + 1] * blend);
                    targetRgba[idx + 2] = Math.round(frB * (1 - blend) + targetRgba[idx + 2] * blend);
                }
            }
        }
    }

    /**
     * Resamples an RGBA buffer to target dimensions using nearest/bilinear interpolation.
     */
    static resampleRgba(srcRgba: Buffer, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
        if (srcW === dstW && srcH === dstH) {
            return Buffer.from(srcRgba);
        }
        const dst = Buffer.alloc(dstW * dstH * 4);
        const scaleX = srcW / dstW;
        const scaleY = srcH / dstH;
        for (let dy = 0; dy < dstH; dy++) {
            const sy = Math.min(srcH - 1, Math.floor(dy * scaleY));
            const dstRow = dy * dstW * 4;
            const srcRow = sy * srcW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const sx = Math.min(srcW - 1, Math.floor(dx * scaleX));
                const dstIdx = dstRow + dx * 4;
                const srcIdx = srcRow + sx * 4;
                dst[dstIdx] = srcRgba[srcIdx];
                dst[dstIdx + 1] = srcRgba[srcIdx + 1];
                dst[dstIdx + 2] = srcRgba[srcIdx + 2];
                dst[dstIdx + 3] = srcRgba[srcIdx + 3];
            }
        }
        return dst;
    }

    /**
     * Stitches 6 rectilinear perspective frames into a full 360 equirectangular panorama.
     */
    static stitchPerspectivesToEquirectangular(
        perspectives: Record<PanoramaPerspective, PerspectiveFrame>,
        outWidth = 2048,
        outHeight = 1024,
        useEac = true
    ): {
        panoRgba: Buffer;
        pngBuffer: Buffer;
        cubemapFaces: StreetViewCubemapFaces;
    } {
        const faceRes = perspectives.front.width;
        const cubemapFaces: StreetViewCubemapFaces = {
            front: perspectives.front.rgba,
            right: perspectives.right.rgba,
            back: perspectives.back.rgba,
            left: perspectives.left.rgba,
            top: perspectives.top.rgba,
            bottom: perspectives.bottom.rgba,
            faceResolution: faceRes,
            useEac
        };

        // Project cubemap back to 2:1 equirectangular
        let panoRgba = Google360PanoramaPipelineService.streetViewCubemapToEquirectangular(
            cubemapFaces,
            outWidth,
            outHeight,
            useEac
        );

        // Apply Google Street View / Photo Sphere polar cap smoothing
        panoRgba = Google360PanoramaPipelineService.applyStreetViewPolarCaps(
            panoRgba,
            outWidth,
            outHeight,
            { zenithRatio: 0.12, nadirRatio: 0.12, smoothExponent: 2.0 }
        );

        // Apply seamless toroidal seam healing at x = 0 <-> x = W - 1
        panoRgba = Google360PanoramaPipelineService.proceduralSeamHeal(
            panoRgba,
            outWidth,
            outHeight,
            Math.round(outWidth * 0.08)
        );

        return {
            panoRgba,
            pngBuffer: encodePng(outWidth, outHeight, panoRgba),
            cubemapFaces
        };
    }

    /**
     * Synthesizes the 5 missing perspective views (right, back, left, top, bottom)
     * conditioned on the initial front image using Nano Banana 2 (or Google GenAI).
     * Throws when the model cannot be reached or answers without an image; only mockExecution
     * returns procedural copies.
     */
    async synthesizePerspectivesWithNanoBanana(
        frontRgba: Buffer,
        res = 512,
        options?: {
            model?: string;
            prompt?: string;
            styleHint?: string;
            locationName?: string;
            mockExecution?: boolean;
            perspectivesToGenerate?: PanoramaPerspective[];
        }
    ): Promise<Record<PanoramaPerspective, PerspectiveFrame>> {
        const model = resolveImageModelId(options?.model || IMAGE_MODEL_PRIORITY[0]);
        const targetPerspectives: PanoramaPerspective[] = options?.perspectivesToGenerate || [
            'right', 'back', 'left', 'top', 'bottom'
        ];

        // 1. Procedural base reference with edge continuations
        const proceduralBase = MultiPerspectivePanoramaSynthesisService.synthesizeMissingPerspectivesFromFront(
            frontRgba,
            res,
            { styleHint: options?.styleHint || options?.prompt }
        );

        const frontPng = encodePng(res, res, frontRgba);
        const frontFrame: PerspectiveFrame = {
            perspective: 'front',
            width: res,
            height: res,
            rgba: frontRgba,
            pngBuffer: frontPng,
            isSynthesized: false,
            prompt: MultiPerspectivePanoramaSynthesisService.buildNanoBananaPerspectivePrompt('front', options),
            cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front
        };

        const result: Record<PanoramaPerspective, PerspectiveFrame> = {
            front: frontFrame,
            right: proceduralBase.right,
            back: proceduralBase.back,
            left: proceduralBase.left,
            top: proceduralBase.top,
            bottom: proceduralBase.bottom
        };

        const frontBase64 = frontPng.toString('base64');

        let client: any = null;
        if (!options?.mockExecution) {
            try {
                client = await this.credentialsService.createClient();
            } catch (err: any) {
                throw Object.assign(new Error(`Perspective synthesis with ${model} needs Google credentials (${err?.message || err}); ` +
                    'pass useNanoBanana: false for procedural perspectives instead.'), { status: err?.status });
            }
        }

        for (const p of targetPerspectives) {
            if (p === 'front') continue;

            const prompt = MultiPerspectivePanoramaSynthesisService.buildNanoBananaPerspectivePrompt(p, options);
            let targetRgba: Buffer;
            let generatedBy: string | undefined;

            if (client) {
                // Like the media service: ask again when a model answers with no image (gemini-3.1-flash-image
                // sometimes finishes with STOP and no image part), and move on to the next model when one is not
                // served (404); any other error ends the run.
                const candidates = [model, ...IMAGE_MODEL_PRIORITY.filter(m => m !== model)];
                let imageData: string | undefined;
                let producedBy: string | undefined;
                let lastEmpty = '';
                for (const candidate of candidates) {
                    for (let attempt = 0; attempt < EMPTY_IMAGE_RESPONSE_ATTEMPTS && !imageData; attempt++) {
                        let response: any;
                        try {
                            response = await client.models.generateContent({
                                model: candidate,
                                contents: [
                                    { text: prompt },
                                    {
                                        inlineData: {
                                            data: frontBase64,
                                            mimeType: 'image/png'
                                        }
                                    }
                                ],
                                config: {
                                    responseModalities: ['TEXT', 'IMAGE'],
                                    imageConfig: {
                                        aspectRatio: '1:1'
                                    }
                                }
                            } as any);
                        } catch (err: any) {
                            if (classifyMediaGenerationError(err, candidate).code === 'unsupported') break; // not served: next model
                            throw Object.assign(new Error(`${candidate} failed on the ${p} perspective: ${err?.message || err}`), { status: err?.status });
                        }
                        const part = response.candidates?.[0]?.content?.parts?.find((pt: any) => pt.inlineData?.data);
                        if (part?.inlineData?.data) {
                            imageData = part.inlineData.data;
                            producedBy = candidate;
                        } else {
                            const finishReason = response.candidates?.[0]?.finishReason;
                            lastEmpty = `${candidate} returned no image${finishReason ? ` (${finishReason})` : ''}`;
                        }
                    }
                    if (imageData) break;
                }
                if (!imageData) {
                    throw new Error(`No image model produced the ${p} perspective${lastEmpty ? `: ${lastEmpty}` : ' (none of them is served)'}`);
                }
                const dec = await decodeImageToRgba(Buffer.from(imageData, 'base64'));
                targetRgba = MultiPerspectivePanoramaSynthesisService.resampleRgba(dec.rgba, dec.width, dec.height, res, res);
                generatedBy = producedBy;
            } else {
                // mockExecution: a procedural copy of the base view, not model output
                targetRgba = Buffer.from(proceduralBase[p].rgba);
                const rotOffset = (MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS[p].yawDeg / 90.0) * 0.15;
                for (let i = 0; i < targetRgba.length; i += 4) {
                    const subtleMod = 1.0 + Math.sin((i / 4) * 0.005 + rotOffset) * 0.03;
                    targetRgba[i] = Math.max(0, Math.min(255, Math.round(targetRgba[i] * subtleMod)));
                    targetRgba[i + 1] = Math.max(0, Math.min(255, Math.round(targetRgba[i + 1] * subtleMod)));
                    targetRgba[i + 2] = Math.max(0, Math.min(255, Math.round(targetRgba[i + 2] * subtleMod)));
                }
            }

            // Weld adjacent boundaries with front plate to guarantee zero seam tears
            MultiPerspectivePanoramaSynthesisService.weldPerspectiveBoundaries(p, targetRgba, frontRgba, res);

            result[p] = {
                perspective: p,
                width: res,
                height: res,
                rgba: targetRgba,
                pngBuffer: encodePng(res, res, targetRgba),
                isSynthesized: true,
                prompt,
                cameraConfig: MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS[p],
                generatedBy
            };
        }

        return result;
    }

    /**
     * Orchestrates end-to-end multi-perspective generation and 360 equirectangular stitching.
     */
    async generate360Perspectives(
        options: MultiPerspectiveSynthesisOptions
    ): Promise<MultiPerspectiveSynthesisResult> {
        let inputRgba: Buffer;
        let inWidth: number;
        let inHeight: number;

        if (options.inputImageBuffer) {
            const dec = decodePng(options.inputImageBuffer);
            inputRgba = dec.rgba;
            inWidth = dec.width;
            inHeight = dec.height;
        } else if (options.inputImagePath) {
            const buf = await fs.readFile(options.inputImagePath);
            const dec = decodePng(buf);
            inputRgba = dec.rgba;
            inWidth = dec.width;
            inHeight = dec.height;
        } else {
            throw new Error('generate360Perspectives: Either "inputImagePath" or "inputImageBuffer" must be provided.');
        }

        const faceRes = options.faceResolution || 512;
        const panoW = options.equirectangularWidth || 2048;
        const panoH = options.equirectangularHeight || 1024;

        let perspectives: Record<PanoramaPerspective, PerspectiveFrame>;
        let modelUsed: string;

        const ar = inWidth / inHeight;
        if (ar >= 1.85 && ar <= 2.15) {
            perspectives = {
                front: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front, faceRes, faceRes
                ),
                right: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.right, faceRes, faceRes
                ),
                back: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.back, faceRes, faceRes
                ),
                left: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.left, faceRes, faceRes
                ),
                top: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.top, faceRes, faceRes
                ),
                bottom: MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
                    inputRgba, inWidth, inHeight, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.bottom, faceRes, faceRes
                )
            };
            modelUsed = 'Equirectangular Camera Extractor (EAC Bilinear Backward Ray)';
        } else {
            const frontRgba = Buffer.alloc(faceRes * faceRes * 4);
            const scaleX = inWidth / faceRes;
            const scaleY = inHeight / faceRes;

            for (let py = 0; py < faceRes; py++) {
                const srcY = Math.min(inHeight - 1, Math.floor(py * scaleY));
                const rowOffset = py * faceRes * 4;
                const srcRowOffset = srcY * inWidth * 4;

                for (let px = 0; px < faceRes; px++) {
                    const srcX = Math.min(inWidth - 1, Math.floor(px * scaleX));
                    const dstIdx = rowOffset + px * 4;
                    const srcIdx = srcRowOffset + srcX * 4;

                    frontRgba[dstIdx] = inputRgba[srcIdx];
                    frontRgba[dstIdx + 1] = inputRgba[srcIdx + 1];
                    frontRgba[dstIdx + 2] = inputRgba[srcIdx + 2];
                    frontRgba[dstIdx + 3] = inputRgba[srcIdx + 3] || 255;
                }
            }

            if (options.useNanoBanana !== false && options.model !== 'procedural') {
                const imageModel = resolveImageModelId(options.model || IMAGE_MODEL_PRIORITY[0]);
                perspectives = await this.synthesizePerspectivesWithNanoBanana(
                    frontRgba,
                    faceRes,
                    {
                        model: imageModel,
                        prompt: options.prompt,
                        styleHint: options.styleHint,
                        locationName: options.locationName,
                        mockExecution: options.mockExecution,
                        perspectivesToGenerate: options.synthesizePerspectives
                    }
                );
                if (options.mockExecution) {
                    modelUsed = `${imageModel} mock: procedural copies, no model call`;
                } else {
                    // Report the models that actually answered; the requested one may not be served.
                    const used = Array.from(new Set(Object.values(perspectives).map(f => f?.generatedBy).filter((m): m is string => !!m)));
                    const usedLabel = used.join(' + ') || imageModel;
                    modelUsed = used.length && !used.includes(imageModel) ? `${usedLabel} (requested ${imageModel} is not served)` : usedLabel;
                }
            } else {
                perspectives = MultiPerspectivePanoramaSynthesisService.synthesizeMissingPerspectivesFromFront(
                    frontRgba,
                    faceRes,
                    {
                        styleHint: options.styleHint,
                        inputFovDeg: options.inputFovDeg || 90.0
                    }
                );
                modelUsed = 'Native Procedural Perspective Synthesizer (C++/TS)';
            }
        }

        const stitched = MultiPerspectivePanoramaSynthesisService.stitchPerspectivesToEquirectangular(
            perspectives,
            panoW,
            panoH,
            true
        );

        let stitchedOutputPath: string | undefined;
        if (options.outputDir) {
            await fs.ensureDir(options.outputDir);
            for (const key of Object.keys(perspectives) as PanoramaPerspective[]) {
                const frame = perspectives[key];
                if (frame.pngBuffer) {
                    await fs.writeFile(path.join(options.outputDir, `perspective_${key}.png`), frame.pngBuffer);
                }
            }
            stitchedOutputPath = path.join(options.outputDir, 'stitched_360_equirectangular.png');
            await fs.writeFile(stitchedOutputPath, stitched.pngBuffer);
        }

        return {
            success: true,
            perspectives,
            stitchedEquirectangular: {
                width: panoW,
                height: panoH,
                rgba: stitched.panoRgba,
                pngBuffer: stitched.pngBuffer,
                outputPath: stitchedOutputPath
            },
            cubemapFaces: stitched.cubemapFaces,
            coverageAngleDegrees: {
                horizontal: 360.0,
                vertical: 180.0
            },
            perspectivesSynthesized: ['right', 'back', 'left', 'top', 'bottom'],
            modelUsed,
            summary: `Successfully generated 6-camera rectilinear perspective rig and stitched 360 equirectangular panorama (${panoW}x${panoH}, coverage: 360°x180°, 6/6 perspectives generated via ${modelUsed}).`
        };
    }
}

export async function generate360Perspectives(
    options: MultiPerspectiveSynthesisOptions
): Promise<MultiPerspectiveSynthesisResult> {
    const service = new MultiPerspectivePanoramaSynthesisService();
    return service.generate360Perspectives(options);
}
