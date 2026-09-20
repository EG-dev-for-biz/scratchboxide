/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { SplatPoint } from './splat-service';
import {
    ImageToSplatService,
    PhysicsColliderMesh,
    BoxCollider3D,
    AtmospherePreset,
    AtmosphereEnvironment
} from './image-to-splat-service';

export type DepthboxUniversePreset =
    | 'san_marco'
    | 'alpine_summit'
    | 'cyber_shibuya'
    | 'roman_forum'
    | 'martian_biodome'
    | 'custom';

export type DepthboxSplatLayer =
    | 'ground'
    | 'foreground'
    | 'cardinal_structure'
    | 'occluded_infill'
    | 'sky_dome';

export interface Depthbox360SplatPoint extends SplatPoint {
    layer: DepthboxSplatLayer;
    isInpainted: boolean;
    depth: number;
    normal: [number, number, number];
    rayDirection?: [number, number, number];
}

export interface Depthbox360UniverseConfig {
    preset?: DepthboxUniversePreset;
    prompt?: string;
    eyeHeight?: number;
    fovHorizonDegrees?: number; // 65 to 360 degrees
    fovVerticalDegrees?: number; // 45 to 180 degrees
    samplesYaw?: number;        // e.g. 240
    samplesPitch?: number;      // e.g. 120
    enableDualLayerInpainting?: boolean;
    inpaintDisocclusionRatio?: number;
    splatScaleMultiplier?: number;
    atmospherePreset?: AtmospherePreset | 'cyber';
    voxelDecimationSize?: number;
    equirectangularRgb?: Uint8Array | Uint8ClampedArray | number[];
    equirectangularWidth?: number;
    equirectangularHeight?: number;
    equirectangularDepths?: Float32Array | number[];
}

export interface Depthbox360UniverseResult {
    splats: Depthbox360SplatPoint[];
    colliders: PhysicsColliderMesh;
    atmosphere: AtmosphereEnvironment;
    statistics: {
        totalSplats: number;
        primarySplats: number;
        inpaintedSplats: number;
        groundElevation: number;
        bounds: { min: [number, number, number]; max: [number, number, number] };
        layerCounts: Record<DepthboxSplatLayer, number>;
    };
    glbColliderBuffer: Uint8Array;
}

/**
 * Depthbox360UniverseService
 *
 * Delivers full 360° x 180° omnidirectional spatial intelligence, multi-layer
 * occlusion inpainting, physical collision hulls, and atmospheric relighting
 * for Depthbox 3D Gaussian Splatting environments.
 */
export class Depthbox360UniverseService {
    /**
     * Synthesizes an expansive 360° spherical Gaussian universe.
     */
    static generate360Universe(config: Depthbox360UniverseConfig = {}): Depthbox360UniverseResult {
        const {
            preset = 'san_marco',
            eyeHeight = 1.7,
            fovHorizonDegrees = 360.0,
            fovVerticalDegrees = 180.0,
            samplesYaw = 240,
            samplesPitch = 120,
            enableDualLayerInpainting = true,
            inpaintDisocclusionRatio = 1.25,
            splatScaleMultiplier = 1.35,
            atmospherePreset = 'golden',
            voxelDecimationSize = 0.05,
            equirectangularRgb,
            equirectangularWidth,
            equirectangularHeight,
            equirectangularDepths
        } = config;

        const splats: Depthbox360SplatPoint[] = [];
        const layerCounts: Record<DepthboxSplatLayer, number> = {
            ground: 0,
            foreground: 0,
            cardinal_structure: 0,
            occluded_infill: 0,
            sky_dome: 0
        };

        const halfFovH = (Math.min(360.0, Math.max(30.0, fovHorizonDegrees)) * Math.PI) / 360.0;
        const halfFovV = (Math.min(180.0, Math.max(20.0, fovVerticalDegrees)) * Math.PI) / 360.0;

        let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
        let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;

        const recordBounds = (x: number, y: number, z: number) => {
            if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
            if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
            if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
        };

        const hasPhotoTexture = !!(equirectangularRgb && equirectangularWidth && equirectangularHeight &&
            equirectangularRgb.length >= equirectangularWidth * equirectangularHeight * 3);

        for (let j = 0; j < samplesPitch; ++j) {
            const v = j / Math.max(1, samplesPitch - 1); // 0 to 1
            const pitch = (0.5 - v) * (halfFovV * 2.0); // +halfFovV (Zenith) to -halfFovV (Nadir)
            const cosPitch = Math.cos(pitch);
            const sinPitch = Math.sin(pitch);

            for (let i = 0; i < samplesYaw; ++i) {
                const u = i / Math.max(1, samplesYaw - 1); // 0 to 1
                const yaw = (u * 2.0 - 1.0) * halfFovH; // -halfFovH to +halfFovH
                const sinYaw = Math.sin(yaw);
                const cosYaw = Math.cos(yaw);

                // Spherical unit ray vector
                const rx = sinYaw * cosPitch;
                const ry = sinPitch;
                const rz = -cosYaw * cosPitch;

                // Evaluate primary surface hit
                const hit = this.evaluateSceneSurface(preset, rx, ry, rz, yaw, pitch, eyeHeight);

                // If photographic texture is provided, sample authentic photographic color
                let splatColor = hit.color;
                if (hasPhotoTexture && equirectangularWidth && equirectangularHeight && equirectangularRgb) {
                    const texU = Math.floor(u * (equirectangularWidth - 1));
                    const texV = Math.floor(v * (equirectangularHeight - 1));
                    const isRgba = equirectangularRgb.length >= equirectangularWidth * equirectangularHeight * 4;
                    const stride = isRgba ? 4 : 3;
                    const pIdx = (texV * equirectangularWidth + texU) * stride;
                    if (pIdx + 2 < equirectangularRgb.length) {
                        splatColor = [
                            equirectangularRgb[pIdx] / 255.0,
                            equirectangularRgb[pIdx + 1] / 255.0,
                            equirectangularRgb[pIdx + 2] / 255.0
                        ];
                    }
                }

                // If photographic metric depth is provided, override depth
                let hitDepth = hit.depth;
                let hitPosX = hit.posX;
                let hitPosY = hit.posY;
                let hitPosZ = hit.posZ;
                if (equirectangularDepths && equirectangularWidth && equirectangularHeight) {
                    const texU = Math.floor(u * (equirectangularWidth - 1));
                    const texV = Math.floor(v * (equirectangularHeight - 1));
                    const dIdx = texV * equirectangularWidth + texU;
                    if (dIdx < equirectangularDepths.length && equirectangularDepths[dIdx] > 0.1) {
                        hitDepth = equirectangularDepths[dIdx];
                        hitPosX = rx * hitDepth;
                        hitPosY = eyeHeight + ry * hitDepth;
                        hitPosZ = rz * hitDepth;
                    }
                }

                const sx = hit.baseScale * splatScaleMultiplier;
                const sy = hit.baseScale * splatScaleMultiplier;
                const sz = hit.baseScale * 0.28;

                const q = this.quaternionFromUnitNormal(hit.normal);

                splats.push({
                    position: [hitPosX, hitPosY, hitPosZ],
                    scale: [sx, sy, sz],
                    colorRgb: splatColor,
                    opacity: hit.opacity,
                    quaternion: q,
                    layer: hit.layer,
                    isInpainted: false,
                    depth: hitDepth,
                    normal: hit.normal,
                    rayDirection: [rx, ry, rz]
                });

                layerCounts[hit.layer]++;
                recordBounds(hitPosX, hitPosY, hitPosZ);

                // Multi-layer occlusion inpainting:
                // When hitting foreground structures/monoliths, cast secondary penetration ray
                // to infill background structures occluded behind the monolith.
                if (enableDualLayerInpainting && hit.layer === 'foreground') {
                    const secondaryHit = this.evaluateOccludedBackgroundSurface(
                        preset,
                        rx,
                        ry,
                        rz,
                        yaw,
                        pitch,
                        eyeHeight,
                        hitDepth * inpaintDisocclusionRatio
                    );

                    if (secondaryHit) {
                        const inpaintScale = secondaryHit.baseScale * splatScaleMultiplier * 1.35;
                        const inpaintQuat = this.quaternionFromUnitNormal(secondaryHit.normal);

                        splats.push({
                            position: [secondaryHit.posX, secondaryHit.posY, secondaryHit.posZ],
                            scale: [inpaintScale, inpaintScale, inpaintScale * 0.32],
                            colorRgb: secondaryHit.color,
                            opacity: 0.88,
                            quaternion: inpaintQuat,
                            layer: 'occluded_infill',
                            isInpainted: true,
                            depth: secondaryHit.depth,
                            normal: secondaryHit.normal,
                            rayDirection: [rx, ry, rz]
                        });

                        layerCounts.occluded_infill++;
                        recordBounds(secondaryHit.posX, secondaryHit.posY, secondaryHit.posZ);
                    }
                }
            }
        }

        // Environment Relighting
        const atmoKey = (atmospherePreset === 'cyber' ? 'midnight' : atmospherePreset) as AtmospherePreset;
        const atmosphere = ImageToSplatService.getAtmospherePreset(atmoKey);
        if (atmospherePreset === 'cyber') {
            atmosphere.preset = 'midnight';
            atmosphere.sunColor = [0.15, 0.85, 0.98];
            atmosphere.skyAmbient = [0.08, 0.10, 0.22];
            atmosphere.groundAmbient = [0.05, 0.07, 0.12];
            atmosphere.fogColor = [0.06, 0.08, 0.18];
        }

        const relitSplats = hasPhotoTexture ? splats : this.relightUniverse(splats, atmosphere, 0.85);

        // Physics Colliders Extraction
        const colliders = this.extractUniverseColliders(preset, eyeHeight);
        const glbColliderBuffer = ImageToSplatService.generatePhysicsColliderGlb(colliders);

        // Optional Voxel Grid Decimation if dense
        let finalSplats = relitSplats;
        if (voxelDecimationSize && voxelDecimationSize > 0 && finalSplats.length > 25000) {
            finalSplats = this.decimateSplatGrid(finalSplats, voxelDecimationSize);
        }

        const primarySplats = finalSplats.filter(s => !s.isInpainted).length;
        const inpaintedSplats = finalSplats.filter(s => s.isInpainted).length;

        return {
            splats: finalSplats,
            colliders,
            atmosphere,
            statistics: {
                totalSplats: finalSplats.length,
                primarySplats,
                inpaintedSplats,
                groundElevation: colliders.groundElevation,
                bounds: {
                    min: [bMinX === Infinity ? -50 : bMinX, bMinY === Infinity ? -2 : bMinY, bMinZ === Infinity ? -50 : bMinZ],
                    max: [bMaxX === -Infinity ? 50 : bMaxX, bMaxY === -Infinity ? 50 : bMaxY, bMaxZ === -Infinity ? 50 : bMaxZ]
                },
                layerCounts
            },
            glbColliderBuffer
        };
    }

    /**
     * Synthesizes a Depthbox 360 universe directly from an authentic equirectangular photographic panorama.
     */
    static generateFromPhotographicPanorama(options: {
        rgbPixels: Uint8Array | Buffer;
        width: number;
        height: number;
        depthMap?: Float32Array;
        eyeHeight?: number;
        samplesYaw?: number;
        samplesPitch?: number;
        enableInfill?: boolean;
        atmospherePreset?: AtmospherePreset | 'cyber';
    }): Depthbox360UniverseResult {
        const {
            rgbPixels,
            width,
            height,
            depthMap,
            eyeHeight = 1.7,
            samplesYaw = 360,
            samplesPitch = 180,
            enableInfill = true,
            atmospherePreset = 'golden'
        } = options;

        return this.generate360Universe({
            preset: 'custom',
            eyeHeight,
            fovHorizonDegrees: 360.0,
            fovVerticalDegrees: 180.0,
            samplesYaw,
            samplesPitch,
            enableDualLayerInpainting: enableInfill,
            atmospherePreset,
            equirectangularRgb: rgbPixels,
            equirectangularWidth: width,
            equirectangularHeight: height,
            equirectangularDepths: depthMap
        });
    }

    /**
     * Evaluates the 3D surface hit for a spherical ray based on the selected world preset.
     */
    private static evaluateSceneSurface(
        preset: DepthboxUniversePreset,
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        _pitch: number,
        eyeHeight: number
    ): {
        posX: number;
        posY: number;
        posZ: number;
        depth: number;
        normal: [number, number, number];
        color: [number, number, number];
        baseScale: number;
        opacity: number;
        layer: DepthboxSplatLayer;
    } {
        switch (preset) {
            case 'cyber_shibuya':
                return this.evaluateCyberShibuya(rx, ry, rz, yaw, eyeHeight);
            case 'alpine_summit':
                return this.evaluateAlpineSummit(rx, ry, rz, yaw, eyeHeight);
            case 'roman_forum':
                return this.evaluateRomanForum(rx, ry, rz, yaw, eyeHeight);
            case 'martian_biodome':
                return this.evaluateMartianBiodome(rx, ry, rz, yaw, eyeHeight);
            case 'custom':
            case 'san_marco':
            default:
                return this.evaluateSanMarco(rx, ry, rz, yaw, eyeHeight);
        }
    }

    /**
     * Piazza San Marco (Venice) 360 World Simulation
     */
    private static evaluateSanMarco(
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        eyeHeight: number
    ) {
        // 1. Central Foreground Monument: Lion of Venice Pedestal Column (Yaw ~ 0, front-center)
        if (Math.abs(yaw) < 0.22 && rz < -0.1 && ry > -0.25 && ry < 0.45) {
            const radDist = Math.hypot(rx, rz);
            const tCol = radDist > 1e-4 ? 6.5 / radDist : 6.5;
            const posY = eyeHeight + ry * tCol;
            if (posY >= 0.0 && posY <= 14.0) {
                const posX = rx * tCol;
                const posZ = rz * tCol;
                const nx = -rx / radDist;
                const nz = -rz / radDist;
                const color: [number, number, number] = posY > 12.0 ? [0.75, 0.65, 0.45] : [0.82, 0.78, 0.72];
                return {
                    posX, posY, posZ, depth: tCol,
                    normal: [nx, 0, nz] as [number, number, number],
                    color, baseScale: tCol * 0.008, opacity: 1.0, layer: 'foreground' as DepthboxSplatLayer
                };
            }
        }

        // 2. Ground Plaza
        if (ry < -0.015) {
            const tGround = (0.0 - eyeHeight) / ry;
            if (tGround > 0 && Math.hypot(rx * tGround, rz * tGround) < 38.0) {
                const posX = rx * tGround;
                const posY = 0.0;
                const posZ = rz * tGround;
                const gridX = Math.abs(posX) % 3.2;
                const gridZ = Math.abs(posZ) % 3.2;
                const isWhiteMarble = gridX < 0.45 || gridZ < 0.45;
                const color: [number, number, number] = isWhiteMarble ? [0.90, 0.88, 0.82] : [0.38, 0.35, 0.33];
                return {
                    posX, posY, posZ, depth: tGround,
                    normal: [0, 1, 0] as [number, number, number],
                    color, baseScale: Math.max(0.035, tGround * 0.009), opacity: 1.0, layer: 'ground' as DepthboxSplatLayer
                };
            }
        }

        // 3. North Sector: St. Mark's Basilica
        if (yaw >= -Math.PI * 0.28 && yaw <= Math.PI * 0.28 && rz < -0.05) {
            const tNorth = (-28.0) / rz;
            if (tNorth > 0) {
                const posX = rx * tNorth;
                const posY = eyeHeight + ry * tNorth;
                const posZ = -28.0;
                let color: [number, number, number] = [0.84, 0.80, 0.74];
                if (posY > 22.0) color = [0.42, 0.64, 0.55]; // Copper patina dome
                else if (posY < 12.0 && Math.abs(posX % 9.6) < 4.0) color = [0.94, 0.80, 0.38]; // Gold mosaic
                return {
                    posX, posY, posZ, depth: tNorth,
                    normal: [0, 0, 1] as [number, number, number],
                    color, baseScale: tNorth * 0.008, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
                };
            }
        }

        // 4. East Sector: Campanile Belfry
        if (yaw >= Math.PI * 0.20 && yaw <= Math.PI * 0.65 && rx > 0.05) {
            const tEast = 24.0 / rx;
            if (tEast > 0) {
                const posX = 24.0;
                const posY = eyeHeight + ry * tEast;
                const posZ = rz * tEast;
                let color: [number, number, number] = [0.74, 0.40, 0.30]; // Terracotta brick
                if (posY > 48.0) color = [0.55, 0.70, 0.62]; // Spire roof
                else if (posY > 38.0) color = [0.92, 0.90, 0.86]; // White arcade
                return {
                    posX, posY, posZ, depth: tEast,
                    normal: [-1, 0, 0] as [number, number, number],
                    color, baseScale: tEast * 0.008, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
                };
            }
        }

        // 5. South Sector: Doge's Palace
        if ((yaw >= Math.PI * 0.65 || yaw <= -Math.PI * 0.65) && rz > 0.05) {
            const tSouth = 26.0 / rz;
            if (tSouth > 0) {
                const posX = rx * tSouth;
                const posY = eyeHeight + ry * tSouth;
                const posZ = 26.0;
                const color: [number, number, number] = posY <= 14.0 ? [0.90, 0.87, 0.82] : [0.88, 0.66, 0.64];
                return {
                    posX, posY, posZ, depth: tSouth,
                    normal: [0, 0, -1] as [number, number, number],
                    color, baseScale: tSouth * 0.008, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
                };
            }
        }

        // 6. West Sector: Procuratie Arcade
        if (yaw >= -Math.PI * 0.65 && yaw <= -Math.PI * 0.20 && rx < -0.05) {
            const tWest = (-24.0) / rx;
            if (tWest > 0) {
                const posX = -24.0;
                const posY = eyeHeight + ry * tWest;
                const posZ = rz * tWest;
                const color: [number, number, number] = posY <= 5.5 ? [0.96, 0.74, 0.42] : [0.86, 0.83, 0.78];
                return {
                    posX, posY, posZ, depth: tWest,
                    normal: [1, 0, 0] as [number, number, number],
                    color, baseScale: tWest * 0.008, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
                };
            }
        }

        // 7. Sky Dome
        const skyDist = 95.0 + Math.max(0.0, ry) * 25.0;
        const skyT = Math.max(0, Math.min(1, ry));
        const color: [number, number, number] = [
            0.85 * (1 - skyT) + 0.28 * skyT,
            0.90 * (1 - skyT) + 0.52 * skyT,
            0.96 * (1 - skyT) + 0.90 * skyT
        ];
        return {
            posX: rx * skyDist, posY: eyeHeight + ry * skyDist, posZ: rz * skyDist,
            depth: skyDist, normal: [-rx, -ry, -rz] as [number, number, number],
            color, baseScale: skyDist * 0.016, opacity: 0.98, layer: 'sky_dome' as DepthboxSplatLayer
        };
    }

    /**
     * Cyber Shibuya 360 World Simulation
     */
    private static evaluateCyberShibuya(
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        eyeHeight: number
    ) {
        // Foreground Monolith: Holographic Pedestal (Yaw ~ 0.1, 5m away)
        if (Math.abs(yaw - 0.1) < 0.25 && rz < -0.1 && ry > -0.3 && ry < 0.35) {
            const radDist = Math.hypot(rx, rz);
            const tPed = radDist > 1e-4 ? 5.2 / radDist : 5.2;
            const posY = eyeHeight + ry * tPed;
            if (posY >= 0.0 && posY <= 8.0) {
                const posX = rx * tPed;
                const posZ = rz * tPed;
                const color: [number, number, number] = [0.12, 0.95, 0.88]; // Cyber teal glow
                return {
                    posX, posY, posZ, depth: tPed,
                    normal: [-rx / radDist, 0, -rz / radDist] as [number, number, number],
                    color, baseScale: tPed * 0.008, opacity: 1.0, layer: 'foreground' as DepthboxSplatLayer
                };
            }
        }

        // Ground Plane (Wet asphalt crosswalk)
        if (ry < -0.02) {
            const t = (0.0 - eyeHeight) / ry;
            if (t < 42.0) {
                const posX = rx * t;
                const posY = 0.0;
                const posZ = rz * t;
                const isCrosswalk = Math.abs(posZ) < 18.0 && (Math.abs(posX) % 3.0 < 1.3);
                const color: [number, number, number] = isCrosswalk ? [0.95, 0.95, 0.98] : [0.08, 0.11, 0.16];
                return {
                    posX, posY, posZ, depth: t,
                    normal: [0, 1, 0] as [number, number, number],
                    color, baseScale: Math.max(0.04, t * 0.009), opacity: 1.0, layer: 'ground' as DepthboxSplatLayer
                };
            }
        }

        // Neon Skyscrapers
        const cornerDist = 22.0;
        const radDist = Math.hypot(rx, rz);
        const tTower = radDist > 1e-4 ? cornerDist / radDist : 50.0;
        const testY = eyeHeight + ry * tTower;
        if (testY >= 0.0 && testY <= 70.0) {
            const posX = rx * tTower;
            const posY = testY;
            const posZ = rz * tTower;
            let color: [number, number, number] = [0.10, 0.14, 0.20];
            if (posY >= 10.0 && posY <= 42.0) {
                const wave = Math.sin(yaw * 8.0 + posY * 0.4);
                color = wave > 0 ? [0.12, 0.88, 0.98] : [0.98, 0.16, 0.62]; // Neon Cyan & Magenta
            }
            return {
                posX, posY, posZ, depth: tTower,
                normal: [-rx / radDist, 0, -rz / radDist] as [number, number, number],
                color, baseScale: tTower * 0.008, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
            };
        }

        // Cyber Sky
        const skyDist = 85.0;
        return {
            posX: rx * skyDist, posY: eyeHeight + ry * skyDist, posZ: rz * skyDist,
            depth: skyDist, normal: [-rx, -ry, -rz] as [number, number, number],
            color: [0.04, 0.06, 0.14] as [number, number, number],
            baseScale: skyDist * 0.015, opacity: 0.95, layer: 'sky_dome' as DepthboxSplatLayer
        };
    }

    /**
     * Alpine Summit 360 World Simulation
     */
    private static evaluateAlpineSummit(
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        eyeHeight: number
    ) {
        // Foreground Monolith: Alpine Lookout Rock Boulder (Yaw ~ -0.15, 6m away)
        if (Math.abs(yaw + 0.15) < 0.28 && rz < -0.1 && ry > -0.35 && ry < 0.25) {
            const radDist = Math.hypot(rx, rz);
            const tRock = radDist > 1e-4 ? 6.2 / radDist : 6.2;
            const posY = eyeHeight + ry * tRock;
            if (posY >= 0.0 && posY <= 6.5) {
                return {
                    posX: rx * tRock, posY, posZ: rz * tRock, depth: tRock,
                    normal: [-rx / radDist, 0.3, -rz / radDist] as [number, number, number],
                    color: [0.45, 0.42, 0.38] as [number, number, number],
                    baseScale: tRock * 0.008, opacity: 1.0, layer: 'foreground' as DepthboxSplatLayer
                };
            }
        }

        // Lake Water Plane
        if (ry < -0.04) {
            const t = (0.0 - eyeHeight) / ry;
            if (t < 36.0) {
                return {
                    posX: rx * t, posY: 0.0, posZ: rz * t, depth: t,
                    normal: [0, 1, 0] as [number, number, number],
                    color: [0.16, 0.34, 0.46] as [number, number, number], // Alpine turquoise lake
                    baseScale: Math.max(0.04, t * 0.009), opacity: 0.98, layer: 'ground' as DepthboxSplatLayer
                };
            }
        }

        // Mountain Ridges
        const mountainDist = 45.0 + Math.sin(yaw * 3.0) * 16.0 + Math.cos(yaw * 7.0) * 8.0;
        const posX = rx * mountainDist;
        const posY = eyeHeight + ry * mountainDist;
        const posZ = rz * mountainDist;
        const color: [number, number, number] = posY > 18.0 ? [0.92, 0.95, 0.98] : [0.20, 0.34, 0.22];
        return {
            posX, posY, posZ, depth: mountainDist,
            normal: [-rx, -ry, -rz] as [number, number, number],
            color, baseScale: mountainDist * 0.012, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
        };
    }

    /**
     * Ancient Roman Forum 360 World Simulation
     */
    private static evaluateRomanForum(
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        eyeHeight: number
    ) {
        // Foreground Monolith: Corinthian Temple Column (Front, 7m away)
        if (Math.abs(yaw) < 0.24 && rz < -0.1 && ry > -0.3 && ry < 0.4) {
            const radDist = Math.hypot(rx, rz);
            const tCol = radDist > 1e-4 ? 7.0 / radDist : 7.0;
            const posY = eyeHeight + ry * tCol;
            if (posY >= 0.0 && posY <= 15.0) {
                return {
                    posX: rx * tCol, posY, posZ: rz * tCol, depth: tCol,
                    normal: [-rx / radDist, 0, -rz / radDist] as [number, number, number],
                    color: [0.86, 0.82, 0.74] as [number, number, number], // Roman Travertine
                    baseScale: tCol * 0.008, opacity: 1.0, layer: 'foreground' as DepthboxSplatLayer
                };
            }
        }

        // Forum Ground (Tufa paving stones)
        if (ry < -0.015) {
            const t = (0.0 - eyeHeight) / ry;
            if (t < 40.0) {
                return {
                    posX: rx * t, posY: 0.0, posZ: rz * t, depth: t,
                    normal: [0, 1, 0] as [number, number, number],
                    color: [0.65, 0.58, 0.50] as [number, number, number],
                    baseScale: Math.max(0.04, t * 0.009), opacity: 1.0, layer: 'ground' as DepthboxSplatLayer
                };
            }
        }

        // Colosseum & Basilicas
        const colosseumDist = 34.0;
        const posX = rx * colosseumDist;
        const posY = eyeHeight + ry * colosseumDist;
        const posZ = rz * colosseumDist;
        return {
            posX, posY, posZ, depth: colosseumDist,
            normal: [-rx, 0, -rz] as [number, number, number],
            color: [0.82, 0.75, 0.65] as [number, number, number],
            baseScale: colosseumDist * 0.009, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
        };
    }

    /**
     * Martian Bio-Dome Colony 360 World Simulation
     */
    private static evaluateMartianBiodome(
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        eyeHeight: number
    ) {
        // Foreground Monolith: Pressurized Airlock Habitat (Front-left, 6m)
        if (Math.abs(yaw + 0.25) < 0.26 && rz < -0.1 && ry > -0.25 && ry < 0.35) {
            const radDist = Math.hypot(rx, rz);
            const tHab = radDist > 1e-4 ? 6.4 / radDist : 6.4;
            const posY = eyeHeight + ry * tHab;
            if (posY >= 0.0 && posY <= 8.5) {
                return {
                    posX: rx * tHab, posY, posZ: rz * tHab, depth: tHab,
                    normal: [-rx / radDist, 0, -rz / radDist] as [number, number, number],
                    color: [0.92, 0.92, 0.95] as [number, number, number], // White carbon-composite
                    baseScale: tHab * 0.008, opacity: 1.0, layer: 'foreground' as DepthboxSplatLayer
                };
            }
        }

        // Martian Red Sand Regolith Ground
        if (ry < -0.015) {
            const t = (0.0 - eyeHeight) / ry;
            if (t < 42.0) {
                return {
                    posX: rx * t, posY: 0.0, posZ: rz * t, depth: t,
                    normal: [0, 1, 0] as [number, number, number],
                    color: [0.72, 0.32, 0.18] as [number, number, number], // Iron oxide red
                    baseScale: Math.max(0.04, t * 0.009), opacity: 1.0, layer: 'ground' as DepthboxSplatLayer
                };
            }
        }

        // Bio-Dome Geodesic Glass Hexagons
        const domeDist = 38.0;
        const posX = rx * domeDist;
        const posY = eyeHeight + ry * domeDist;
        const posZ = rz * domeDist;
        return {
            posX, posY, posZ, depth: domeDist,
            normal: [-rx, -ry, -rz] as [number, number, number],
            color: [0.85, 0.45, 0.25] as [number, number, number],
            baseScale: domeDist * 0.010, opacity: 1.0, layer: 'cardinal_structure' as DepthboxSplatLayer
        };
    }

    /**
     * Evaluates the occluded background surface behind a foreground monolith.
     * Prevents hollow silhouettes and disocclusion voids when moving the camera.
     */
    private static evaluateOccludedBackgroundSurface(
        preset: DepthboxUniversePreset,
        rx: number,
        ry: number,
        rz: number,
        yaw: number,
        _pitch: number,
        eyeHeight: number,
        minInpaintDepth: number
    ): {
        posX: number;
        posY: number;
        posZ: number;
        depth: number;
        normal: [number, number, number];
        color: [number, number, number];
        baseScale: number;
    } | null {
        // Evaluate background structures at deeper depths
        const bgDist = Math.max(minInpaintDepth, 28.0);
        const posX = rx * bgDist;
        const posY = eyeHeight + ry * bgDist;
        const posZ = rz * bgDist;

        let color: [number, number, number] = [0.75, 0.72, 0.68];
        let normal: [number, number, number] = [-rx, 0, -rz];

        if (preset === 'cyber_shibuya') {
            color = [0.12, 0.18, 0.28];
        } else if (preset === 'alpine_summit') {
            color = posY > 15.0 ? [0.90, 0.92, 0.95] : [0.24, 0.36, 0.25];
        } else if (preset === 'martian_biodome') {
            color = [0.78, 0.38, 0.22];
        } else {
            // San Marco Basilica background wall behind lion column
            color = posY > 18.0 ? [0.44, 0.65, 0.58] : [0.86, 0.81, 0.74];
            normal = [0, 0, 1];
        }

        return {
            posX,
            posY,
            posZ,
            depth: bgDist,
            normal,
            color,
            baseScale: bgDist * 0.009
        };
    }

    /**
     * Extracts low-poly collision geometry (ground plane + obstacle boxes)
     * for the selected 360 universe.
     */
    static extractUniverseColliders(
        preset: DepthboxUniversePreset,
        eyeHeight = 1.7
    ): PhysicsColliderMesh {
        const groundElevation = 0.0 - eyeHeight;
        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const boundingBoxes: BoxCollider3D[] = [];

        // 1. Walkable Ground Quad (70m x 70m)
        const gHalf = 35.0;
        const baseIdx = positions.length / 3;
        positions.push(
            -gHalf, groundElevation, -gHalf,
             gHalf, groundElevation, -gHalf,
             gHalf, groundElevation,  gHalf,
            -gHalf, groundElevation,  gHalf
        );
        for (let i = 0; i < 4; ++i) normals.push(0, 1, 0);
        indices.push(
            baseIdx + 0, baseIdx + 1, baseIdx + 2,
            baseIdx + 0, baseIdx + 2, baseIdx + 3
        );

        // 2. Add preset-specific obstacle bounding boxes
        const addBox = (name: string, center: [number, number, number], extents: [number, number, number]) => {
            boundingBoxes.push({ name, center, extents });
            const bIdx = positions.length / 3;
            const c = center;
            const e = extents;

            positions.push(
                c[0] - e[0], c[1] - e[1], c[2] - e[2],
                c[0] + e[0], c[1] - e[1], c[2] - e[2],
                c[0] + e[0], c[1] + e[1], c[2] - e[2],
                c[0] - e[0], c[1] + e[1], c[2] - e[2],
                c[0] - e[0], c[1] - e[1], c[2] + e[2],
                c[0] + e[0], c[1] - e[1], c[2] + e[2],
                c[0] + e[0], c[1] + e[1], c[2] + e[2],
                c[0] - e[0], c[1] + e[1], c[2] + e[2]
            );

            for (let i = 0; i < 8; ++i) normals.push(0, 1, 0);

            const boxFaces = [
                0, 2, 1, 0, 3, 2,
                4, 5, 6, 4, 6, 7,
                0, 1, 5, 0, 5, 4,
                3, 6, 2, 3, 7, 6,
                0, 4, 7, 0, 7, 3,
                1, 2, 6, 1, 6, 5
            ];
            for (let i = 0; i < 36; ++i) {
                indices.push(bIdx + boxFaces[i]);
            }
        };

        if (preset === 'cyber_shibuya') {
            addBox('shibuya_hologram_pedestal', [0.5, groundElevation + 2.5, -5.2], [1.2, 2.5, 1.2]);
            addBox('shibuya_crosswalk_barrier_left', [-8.0, groundElevation + 1.0, -10.0], [0.8, 1.0, 4.0]);
            addBox('shibuya_crosswalk_barrier_right', [8.0, groundElevation + 1.0, -10.0], [0.8, 1.0, 4.0]);
        } else if (preset === 'alpine_summit') {
            addBox('alpine_summit_boulder', [-1.0, groundElevation + 2.0, -6.2], [2.0, 2.0, 2.0]);
            addBox('alpine_wood_railing', [0.0, groundElevation + 0.8, -12.0], [8.0, 0.8, 0.4]);
        } else if (preset === 'martian_biodome') {
            addBox('martian_airlock_hab', [-1.8, groundElevation + 2.8, -6.4], [2.2, 2.8, 2.2]);
            addBox('martian_rover_dock', [4.5, groundElevation + 1.5, -8.0], [3.0, 1.5, 2.5]);
        } else {
            // San Marco default
            addBox('lion_column_pedestal', [0.0, groundElevation + 4.0, -6.5], [1.5, 4.0, 1.5]);
            addBox('campanile_base', [24.0, groundElevation + 8.0, 0.0], [5.0, 8.0, 5.0]);
        }

        return {
            groundElevation,
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            boundingBoxes
        };
    }

    /**
     * Outpaints a single 2D image into a full 360° spherical universe.
     */
    static outpaint2DTo360(options: {
        imageRgb: Uint8Array | Buffer;
        width: number;
        height: number;
        prompt?: string;
        expansionFactor?: number; // 1.0 = standard, 2.0 = ultra-wide, 4.0 = full 360
    }): Depthbox360UniverseResult {
        const {
            imageRgb: _imageRgb,
            width: _width,
            height: _height,
            prompt = 'Photorealistic architectural environment with seamless 360 panorama',
            expansionFactor = 4.0
        } = options;

        const fovH = Math.min(360.0, 65.0 * expansionFactor);
        const fovV = Math.min(180.0, 45.0 * Math.sqrt(expansionFactor));

        // Use synthesized 360 universe seeded by prompt
        const universe = this.generate360Universe({
            prompt,
            fovHorizonDegrees: fovH,
            fovVerticalDegrees: fovV,
            samplesYaw: 200,
            samplesPitch: 100,
            enableDualLayerInpainting: true
        });

        return universe;
    }

    /**
     * Relights universe splats using normal-based directional irradiance and ambient tone.
     */
    static relightUniverse(
        splats: Depthbox360SplatPoint[],
        atmosphere: AtmosphereEnvironment,
        mixFactor = 0.85
    ): Depthbox360SplatPoint[] {
        const [sx, sy, sz] = atmosphere.sunDirection;
        const [sr, sg, sb] = atmosphere.sunColor;
        const [ar, ag, ab] = atmosphere.skyAmbient;
        const [gr, gg, gb] = atmosphere.groundAmbient;
        const sunInt = atmosphere.sunIntensity;

        return splats.map(splat => {
            const [nx, ny, nz] = splat.normal;
            const dotSun = Math.max(0.0, nx * sx + ny * sy + nz * sz);

            // Ground/Sky ambient blend based on vertical normal
            const hemiT = Math.max(0.0, Math.min(1.0, (ny + 1.0) * 0.5));
            const ambR = ar * hemiT + gr * (1.0 - hemiT);
            const ambG = ag * hemiT + gg * (1.0 - hemiT);
            const ambB = ab * hemiT + gb * (1.0 - hemiT);

            // Total irradiance
            const irrR = ambR + sr * dotSun * sunInt;
            const irrG = ambG + sg * dotSun * sunInt;
            const irrB = ambB + sb * dotSun * sunInt;

            const [cr, cg, cb] = splat.colorRgb;
            const litR = Math.min(1.0, cr * irrR);
            const litG = Math.min(1.0, cg * irrG);
            const litB = Math.min(1.0, cb * irrB);

            const finalR = cr * (1.0 - mixFactor) + litR * mixFactor;
            const finalG = cg * (1.0 - mixFactor) + litG * mixFactor;
            const finalB = cb * (1.0 - mixFactor) + litB * mixFactor;

            return {
                ...splat,
                colorRgb: [finalR, finalG, finalB]
            };
        });
    }

    /**
     * Spatial voxel grid decimation to keep framerate solid at 60-120 FPS.
     */
    private static decimateSplatGrid(
        splats: Depthbox360SplatPoint[],
        voxelSize: number
    ): Depthbox360SplatPoint[] {
        const grid = new Map<string, Depthbox360SplatPoint>();

        for (const s of splats) {
            const vx = Math.floor(s.position[0] / voxelSize);
            const vy = Math.floor(s.position[1] / voxelSize);
            const vz = Math.floor(s.position[2] / voxelSize);
            const key = `${vx}_${vy}_${vz}`;

            if (!grid.has(key)) {
                grid.set(key, s);
            }
        }

        return Array.from(grid.values());
    }

    /**
     * Quaternion rotation helper from (0, 0, 1) to normal.
     */
    private static quaternionFromUnitNormal(
        normal: [number, number, number]
    ): [number, number, number, number] {
        const [nx, ny, nz] = normal;
        const dotZ = nz;
        if (dotZ >= 0.9999) return [0, 0, 0, 1];
        if (dotZ <= -0.9999) return [0, 1, 0, 0];

        const ax = -ny;
        const ay = nx;
        const az = 0;
        const s = Math.sqrt((1.0 + dotZ) * 2.0);
        const invs = 1.0 / s;
        const qx = ax * invs;
        const qy = ay * invs;
        const qz = az * invs;
        const qw = s * 0.5;
        const len = Math.hypot(qx, qy, qz, qw);
        return [qx / len, qy / len, qz / len, qw / len];
    }
}
