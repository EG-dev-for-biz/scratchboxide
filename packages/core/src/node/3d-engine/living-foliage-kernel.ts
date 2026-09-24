/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Context provided for each vegetation texel in the Living Foliage synthesis kernel.
 */
export interface LivingFoliageContext {
    r: number;             // Original photogrammetry Red [0..255]
    g: number;             // Original photogrammetry Green [0..255]
    b: number;             // Original photogrammetry Blue [0..255]
    wx: number;            // 3D continuous world x coordinate (meters)
    wy: number;            // 3D continuous world y coordinate (meters)
    wz: number;            // 3D continuous world z coordinate (meters)
    fnx: number;           // Surface normal x
    fny: number;           // Surface normal y (gravity axis)
    fnz: number;           // Surface normal z
    isLeafMask?: boolean;  // Boolean indicating perforated foliage leaf tip/edge
    treeCentroid?: [number, number, number]; // [cx, cy, cz] Tree canopy centroid in world space (meters)
    canopyRadius?: number; // Metric canopy radius (meters)
    options?: LivingFoliageOptions;
}

/**
 * Output produced by the Living Foliage kernel for a single vegetation texel.
 */
export interface LivingFoliageOutput {
    albedo: [number, number, number]; // [R, G, B] in [0..255]
    normalDelta: [number, number, number]; // [dx, dy, dz] tangent offset
    orm: [number, number, number];    // [AO, Roughness, Metalness] in [0..255]
    telemetry: {
        isUnderside: boolean;
        isWaxyBlade: boolean;
        isBacklitRim: boolean;
        isDeepVoid: boolean;
        leafTiltX: number;
        leafTiltZ: number;
        wrapIntensity?: number;
        transmittanceFactor?: number;
        radialDepthRho?: number;
    };
}

/**
 * Configuration options for the Living Foliage kernel.
 */
export interface LivingFoliageOptions {
    cellScaleMeters?: number;       // Default ~0.05m (5cm Voronoi leaf cells -> 20.0 cells/m)
    leafTiltAmplitude?: number;     // Default ~0.70 radians (+/- 35 deg planar deviation)
    undersideNyThreshold?: number;  // Default -0.20
    waxyBladeRatio?: number;        // Default 0.25 (25% waxy cuticle vs 75% matte stem)
    waxyRoughness?: number;         // Default 0.32 (0.28 - 0.35)
    matteRoughness?: number;        // Default 0.88 (0.85 - 0.92)
    backlitRimBoost?: { r: number; g: number; b: number }; // Default { r: 24, g: 48, b: -12 }
    voidAoFloor?: number;           // Default 0.20 (0.15 - 0.25)
    normalAoCeiling?: number;       // Default 0.95
    // Sleight 3: Half-Lambert Wrap & Translucency
    sunDirection?: [number, number, number]; // Default normalized [0.585, 0.683, 0.439]
    wrapFactor?: number;            // Default 0.35
    transmittanceBoost?: { r: number; g: number; b: number }; // Default { r: 10, g: 18, b: -8 }
    // Sleight 4: Inverted Volumetric Core Depth Gradient
    enableVolumetricCoreAo?: boolean; // Default true
    coreInnerRadiusRatio?: number;   // Default 0.45 (rho < 0.45 -> inner core)
    coreOuterRadiusRatio?: number;   // Default 0.75 (rho >= 0.75 -> outer envelope)
    coreAoFloor?: [number, number];  // Default [0.15, 0.25]
    midAoRange?: [number, number];   // Default [0.50, 0.85]
    outerAoCeiling?: [number, number]; // Default [0.88, 1.00]
}

/**
 * Fast 3D procedural hash returning a uniform float in [0..1).
 */
export function hash3D(x: number, y: number, z: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
    return n - Math.floor(n);
}

/**
 * 3D value noise with cubic Hermite smoothstep interpolation.
 */
export function valueNoise3D(x: number, y: number, z: number): number {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);
    const uz = fz * fz * (3.0 - 2.0 * fz);

    const d000 = hash3D(ix, iy, iz);
    const d100 = hash3D(ix + 1, iy, iz);
    const d010 = hash3D(ix, iy + 1, iz);
    const d110 = hash3D(ix + 1, iy + 1, iz);
    const d001 = hash3D(ix, iy, iz + 1);
    const d101 = hash3D(ix + 1, iy, iz + 1);
    const d011 = hash3D(ix, iy + 1, iz + 1);
    const d111 = hash3D(ix + 1, iy + 1, iz + 1);

    const x0 = d000 * (1 - ux) + d100 * ux;
    const x1 = d010 * (1 - ux) + d110 * ux;
    const x2 = d001 * (1 - ux) + d101 * ux;
    const x3 = d011 * (1 - ux) + d111 * ux;

    const y0 = x0 * (1 - uy) + x1 * uy;
    const y1 = x2 * (1 - uy) + x3 * uy;

    return y0 * (1 - uz) + y1 * uz;
}

/**
 * Universal "Living Foliage" Texture Synthesis Kernel.
 * Turns photogrammetric green tree blobs into dynamic, translucent, airy canopies.
 * 
 * 1. Under-canopy Bark & Branch Inversion (The Skeletal Illusion)
 * 2. Leaf Flutter Micro-Normal (Randomized planar facets ~5cm scale, +/- 35 deg)
 * 3. Backlit Chlorophyll Rim Baking (Subsurface glow along leaf edges)
 * 4. Dual-Roughness Cuticle Stippling (Waxy Blades 0.32 vs Matte Stems 0.88)
 * 5. Deep Interior Hollows in Cavity AO (Turns solid boulder into airy sponge)
 */
export function synthesizeLivingFoliage({
    r, g, b,
    wx, wy, wz,
    fnx, fny, fnz,
    isLeafMask = false,
    treeCentroid,
    canopyRadius,
    options = {}
}: LivingFoliageContext): LivingFoliageOutput {
    const nyThreshold = options.undersideNyThreshold ?? -0.20;
    const isUnderside = fny < nyThreshold;

    // 1. Under-Canopy Bark & Branch Inversion (The Skeletal Illusion)
    if (isUnderside) {
        const underFactor = Math.min(1.0, (-fny - Math.abs(nyThreshold)) / 0.50);
        // Shift green blob into weathered charcoal-umber bark: RGB [65, 52, 42]
        const outR = Math.round(r * (1.0 - underFactor * 0.5) + 65 * underFactor * 0.5);
        const outG = Math.round(g * (1.0 - underFactor * 0.7) + 52 * underFactor * 0.3);
        const outB = Math.round(b * (1.0 - underFactor * 0.6) + 42 * underFactor * 0.4);

        // Vertical furrow striations along gravity vector
        const barkFurrow = Math.sin(wx * 80.0) * 0.20;

        return {
            albedo: [Math.min(255, Math.max(0, outR)), Math.min(255, Math.max(0, outG)), Math.min(255, Math.max(0, outB))],
            normalDelta: [0, barkFurrow, 0],
            orm: [55, 235, 0], // Deep under-canopy AO (0.22), high matte bark roughness (0.92), strict 0.0 dielectric metal
            telemetry: {
                isUnderside: true,
                isWaxyBlade: false,
                isBacklitRim: false,
                isDeepVoid: true,
                leafTiltX: 0,
                leafTiltZ: 0,
                wrapIntensity: 0,
                transmittanceFactor: 0,
                radialDepthRho: 0
            }
        };
    }

    // Centroid and radial canopy vector N_cloud
    const cx = treeCentroid ? treeCentroid[0] : wx;
    const cy = treeCentroid ? treeCentroid[1] : (wy - 2.0);
    const cz = treeCentroid ? treeCentroid[2] : wz;
    const rx = wx - cx;
    const ry = (wy - cy) * 0.45; // Subtle upward curvature on canopy dome
    const rz = wz - cz;
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
    const nCloudX = rx / rLen;
    const nCloudY = ry / rLen;
    const nCloudZ = rz / rLen;

    // 2. Leaf Flutter Micro-Normal (Randomized planar facets ~5cm scale, +/- 35 deg)
    const cellScale = options.cellScaleMeters ? (1.0 / options.cellScaleMeters) : 20.0; // 20 cells/m = 5cm
    const tiltAmp = options.leafTiltAmplitude ?? 0.70; // ~0.70 rad = 40 deg, +/- 35 deg amplitude
    const cellX = Math.floor(wx * cellScale);
    const cellY = Math.floor(wy * cellScale);
    const cellZ = Math.floor(wz * cellScale);

    const leafTiltX = (hash3D(cellX, cellY, cellZ) - 0.5) * tiltAmp;
    const leafTiltZ = (hash3D(cellX + 17, cellY + 31, cellZ + 71) - 0.5) * tiltAmp;

    // 3. Backlit Chlorophyll Rim Baking & Sleight 3: Subsurface Chlorophyll Wrap Lighting
    const rimBoost = options.backlitRimBoost ?? { r: 24, g: 48, b: -12 };
    let outR = r;
    let outG = g;
    let outB = b;

    if (isLeafMask) {
        // Boost luminous lime-gold on thin foliage tips and perforated fringes
        outR = Math.min(255, r + rimBoost.r);
        outG = Math.min(255, g + rimBoost.g);
        outB = Math.max(0, b + rimBoost.b);
    }

    // Sleight 3: Half-Lambert Wrap Approximation & Chlorophyll Transmittance Shift
    const [lx, ly, lz] = options.sunDirection || [0.585, 0.683, 0.439];
    const nCloudDotL = nCloudX * lx + nCloudY * ly + nCloudZ * lz;
    const wrap = options.wrapFactor ?? 0.35;
    const wrapIntensity = Math.max(0.0, Math.min(1.0, (nCloudDotL + wrap) / (1.0 + wrap)));

    // Transmittance factor peaks in the penumbra / shadow-wrap boundary (nCloudDotL ~ -0.05)
    const transFactor = Math.max(0.0, Math.min(1.0, 1.0 - Math.abs(nCloudDotL + 0.05) / 0.30));
    const transBoost = options.transmittanceBoost ?? { r: 10, g: 18, b: -8 };
    outR = Math.min(255, Math.max(0, outR + transBoost.r * transFactor));
    outG = Math.min(255, Math.max(0, outG + transBoost.g * transFactor));
    outB = Math.min(255, Math.max(0, outB + transBoost.b * transFactor));

    // 4. Dual-Roughness Cuticle Stippling: Waxy Blade (0.32) vs Matte Stem (0.88)
    const waxyCutoff = 1.0 - (options.waxyBladeRatio ?? 0.25); // Default 0.75 cutoff -> 25% waxy
    const stippleNoise = hash3D(wx * 60.0, wy * 60.0, wz * 60.0);
    const isWaxyBlade = stippleNoise > waxyCutoff;
    const roughness = isWaxyBlade
        ? (options.waxyRoughness ?? 0.32)
        : (options.matteRoughness ?? 0.88);

    // 5. Sleight 4: Inverted Volumetric Core Depth Gradient (Canopy AO)
    const R = canopyRadius ?? 3.5;
    const distToCenter = Math.sqrt((wx - cx) * (wx - cx) + (wy - cy) * (wy - cy) + (wz - cz) * (wz - cz));
    const rho = Math.min(1.0, Math.max(0.0, distToCenter / R));

    let ao: number;
    let isDeepVoid = false;

    if (options.enableVolumetricCoreAo !== false) {
        const innerR = options.coreInnerRadiusRatio ?? 0.45;
        const outerR = options.coreOuterRadiusRatio ?? 0.75;
        if (rho < innerR) {
            // Inner Core: deep, cavernous interior core (0.15 - 0.25)
            const t = rho / innerR;
            ao = 0.15 + 0.10 * t;
            isDeepVoid = true;
        } else if (rho < outerR) {
            // Mid-Canopy: branch scaffolding (0.50 - 0.85)
            const t = (rho - innerR) / (outerR - innerR);
            ao = 0.50 + 0.35 * t;
        } else {
            // Outer Envelope: pure sunlit canopy (0.88 - 1.00)
            const t = (rho - outerR) / (1.0 - outerR);
            ao = 0.88 + 0.12 * t;
        }
    } else {
        // Fallback: procedural noise void
        const macroVoid = valueNoise3D(wx * 2.5, wy * 2.5, wz * 2.5);
        isDeepVoid = macroVoid < 0.30;
        ao = isDeepVoid
            ? (options.voidAoFloor ?? 0.20)
            : (options.normalAoCeiling ?? 0.95);
    }

    return {
        albedo: [Math.round(outR), Math.round(outG), Math.round(outB)],
        normalDelta: [leafTiltX, 0, leafTiltZ],
        orm: [
            Math.round(Math.max(0, Math.min(255, ao * 255))),
            Math.round(Math.max(0, Math.min(255, roughness * 255))),
            0 // Strict 0.0 Dielectric Metalness
        ],
        telemetry: {
            isUnderside: false,
            isWaxyBlade,
            isBacklitRim: isLeafMask,
            isDeepVoid,
            leafTiltX,
            leafTiltZ,
            wrapIntensity,
            transmittanceFactor: transFactor,
            radialDepthRho: rho
        }
    };
}

/**
 * Living Foliage Kernel Service for batch processing texture buffers and 3D scenes.
 */
export class LivingFoliageKernel {
    /**
     * Processes a foliage texture atlas buffer.
     */
    public static processAtlasBuffer(
        rawRgba: Buffer | Uint8Array,
        width: number,
        height: number,
        spatialContext: {
            worldBounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
            dominantNormal?: [number, number, number];
        } = {},
        options: LivingFoliageOptions = {}
    ): {
        albedoRgba: Uint8Array;
        normalRgb: Uint8Array;
        ormRgba: Uint8Array;
        telemetry: {
            totalTexels: number;
            undersideCount: number;
            waxyBladeCount: number;
            backlitRimCount: number;
            deepVoidCount: number;
        };
    } {
        const totalPixels = width * height;
        const albedoRgba = new Uint8Array(totalPixels * 4);
        const normalRgb = new Uint8Array(totalPixels * 3);
        const ormRgba = new Uint8Array(totalPixels * 4);

        const bounds = spatialContext.worldBounds || {
            minX: -10, maxX: 10,
            minY: 0, maxY: 15,
            minZ: -10, maxZ: 10
        };
        const [fnxDef, fnyDef, fnzDef] = spatialContext.dominantNormal || [0, 1, 0];
        const treeCentroid: [number, number, number] = [
            (bounds.minX + bounds.maxX) * 0.5,
            (bounds.minY + bounds.maxY) * 0.5,
            (bounds.minZ + bounds.maxZ) * 0.5
        ];
        const canopyRadius = Math.max(
            (bounds.maxX - bounds.minX) * 0.5,
            (bounds.maxZ - bounds.minZ) * 0.5,
            2.0
        );

        let undersideCount = 0;
        let waxyCount = 0;
        let rimCount = 0;
        let voidCount = 0;

        for (let y = 0; y < height; y++) {
            const vNorm = y / Math.max(1, height - 1);

            for (let x = 0; x < width; x++) {
                const uNorm = x / Math.max(1, width - 1);
                const idx = y * width + x;

                const r = rawRgba[idx * 4 + 0];
                const g = rawRgba[idx * 4 + 1];
                const b = rawRgba[idx * 4 + 2];
                const a = rawRgba[idx * 4 + 3];

                // Continuous 3D world coordinates
                const wx = bounds.minX + uNorm * (bounds.maxX - bounds.minX);
                const wy = bounds.maxY - vNorm * (bounds.maxY - bounds.minY);
                const wz = bounds.minZ + (uNorm + vNorm) * 0.5 * (bounds.maxZ - bounds.minZ);

                // Leaf mask: thin edges or alpha perforation
                const isLeafMask = a > 50 && a < 200;

                const res = synthesizeLivingFoliage({
                    r, g, b,
                    wx, wy, wz,
                    fnx: fnxDef, fny: fnyDef, fnz: fnzDef,
                    isLeafMask,
                    treeCentroid,
                    canopyRadius,
                    options
                });

                albedoRgba[idx * 4 + 0] = res.albedo[0];
                albedoRgba[idx * 4 + 1] = res.albedo[1];
                albedoRgba[idx * 4 + 2] = res.albedo[2];
                albedoRgba[idx * 4 + 3] = a;

                // Tangent normal with leaf tilt
                const nx = res.normalDelta[0];
                const ny = res.normalDelta[1];
                const nz = 1.0;
                const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);

                normalRgb[idx * 3 + 0] = Math.round(((nx * invLen) * 0.5 + 0.5) * 255);
                normalRgb[idx * 3 + 1] = Math.round(((ny * invLen) * 0.5 + 0.5) * 255);
                normalRgb[idx * 3 + 2] = Math.round(((nz * invLen) * 0.5 + 0.5) * 255);

                ormRgba[idx * 4 + 0] = res.orm[0]; // AO
                ormRgba[idx * 4 + 1] = res.orm[1]; // Roughness
                ormRgba[idx * 4 + 2] = res.orm[2]; // Metalness (0.0)
                ormRgba[idx * 4 + 3] = 255;

                if (res.telemetry.isUnderside) undersideCount++;
                if (res.telemetry.isWaxyBlade) waxyCount++;
                if (res.telemetry.isBacklitRim) rimCount++;
                if (res.telemetry.isDeepVoid) voidCount++;
            }
        }

        return {
            albedoRgba,
            normalRgb,
            ormRgba,
            telemetry: {
                totalTexels: totalPixels,
                undersideCount,
                waxyBladeCount: waxyCount,
                backlitRimCount: rimCount,
                deepVoidCount: voidCount
            }
        };
    }
}
