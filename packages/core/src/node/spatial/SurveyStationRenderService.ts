/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { stationToPinhole, cameraBasis, type PinholeIntrinsics } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, StationBeautifyMetrics } from '../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import { getSolarPosition } from '../../common/coordinate/solarPosition';
import { NativeTilePathTracerService, type TileSunSpec } from '../3d-engine/native-tile-path-tracer-service';
import { calibrateStoneAlbedoRgba, type StoneAlbedoPreset, decodePng } from '../texture-processing';

/** Sun azimuth/elevation (degrees) at a UTC instant. */
export function solarAtUtcInstant(utc: Date, lat: number, lng: number): { azimuthDegrees: number; elevationDegrees: number } {
    const s = getSolarPosition(utc, lat, lng);
    return { azimuthDegrees: (s.azimuth * 180) / Math.PI, elevationDegrees: (s.altitude * 180) / Math.PI };
}

export interface StationBlockoutRenderOptions {
    width?: number;            // default 1920
    height?: number;           // default 1080
    clayColor?: [number, number, number];
    bgColor?: [number, number, number, number];
    lightDir?: [number, number, number];
    minGroundClearance?: number;
}

export interface StationRenderOptions extends StationBlockoutRenderOptions {
    renderMode?: 'clay' | 'pathtraced' | 'albedo';
    glbPath?: string;
    sun?: TileSunSpec;
    isoDate?: string;
    samplesPerPixel?: number;
    exposureEv?: number | 'auto';
    stoneType?: StoneAlbedoPreset;
    workDir?: string;
}

export interface StationBlockoutRender {
    stationId: number;
    width: number;
    height: number;
    /** 8-bit RGBA, row-major, top row first. */
    rgba: Buffer;
    /** PNG encoding of rgba. */
    png: Buffer;
    /** Metric depth per pixel. `depthKind` tells consumers how to unproject it. Empty pixels hold `EMPTY_DEPTH`. */
    depth: Float32Array;
    depthKind: 'camera-z';
    silhouette: Uint8Array;
    intrinsics: PinholeIntrinsics;
    cameraPose: CameraPose6DOF;
}

export interface StationEnrichOptions {
    width?: number;            // probe render size (default 320 x 180; enrichment does not need full res)
    height?: number;
    isoDate?: string;          // for the solar ephemeris; default now
}

export const EMPTY_DEPTH = 1e9;

/**
 * Renders pose-exact clay blockouts and derives beautify metrics for survey stations, using the
 * pure-Node software rasterizer against a GLB (Google 3D Tiles extraction or any mesh).
 *
 * Camera convention: the station's horizontal fov is authoritative; the renderer takes a vertical
 * fov, derived for the requested aspect so the pinhole intrinsics returned here match the pixels.
 */
export class SurveyStationRenderService {
    private mesh: RenderMesh3D | null = null;
    private meshBounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
    private glbPath: string | null = null;
    private pathTracer: NativeTilePathTracerService | null = null;

    async loadMesh(glb: string | Buffer): Promise<void> {
        if (typeof glb === 'string') {
            this.glbPath = glb;
        }
        this.mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glb);
        const v = this.mesh.vertices;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 3) {
            for (let k = 0; k < 3; k++) { const x = v[i + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
        }
        this.meshBounds = { min, max };
    }

    setMesh(mesh: RenderMesh3D): void {
        this.mesh = mesh;
        const v = mesh.vertices;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { const x = v[i + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
        this.meshBounds = { min, max };
    }

    getMeshBounds() { return this.meshBounds; }

    /** Station -> renderer pose. The renderer's fov parameter is vertical. */
    static stationToCameraPose6DOF(station: ColmapCameraPose, width: number, height: number): { pose: CameraPose6DOF; intrinsics: PinholeIntrinsics } {
        const intrinsics = stationToPinhole(station, width, height);
        const p = station.positionLocalENU, f = station.forwardVector;
        const { up } = cameraBasis(f, station.upVector || [0, 1, 0]);
        let upVec: [number, number, number] = up;
        if (station.rollDegrees) {
            // Roll about the forward axis (Rodrigues)
            const a = (station.rollDegrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
            const k = f;
            const kxu = [k[1] * up[2] - k[2] * up[1], k[2] * up[0] - k[0] * up[2], k[0] * up[1] - k[1] * up[0]];
            const kdu = k[0] * up[0] + k[1] * up[1] + k[2] * up[2];
            upVec = [
                up[0] * c + kxu[0] * s + k[0] * kdu * (1 - c),
                up[1] * c + kxu[1] * s + k[1] * kdu * (1 - c),
                up[2] * c + kxu[2] * s + k[2] * kdu * (1 - c)
            ];
        }
        const pose: CameraPose6DOF = {
            x: p[0], y: p[1], z: p[2],
            targetX: p[0] + f[0] * 10, targetY: p[1] + f[1] * 10, targetZ: p[2] + f[2] * 10,
            fov: intrinsics.verticalFovDegrees,
            up: upVec
        };
        return { pose, intrinsics };
    }

    renderStationBlockout(station: ColmapCameraPose, options: StationBlockoutRenderOptions = {}): StationBlockoutRender {
        if (!this.mesh) throw new Error('SurveyStationRenderService: call loadMesh() first');
        const minGroundClearance = options.minGroundClearance !== undefined ? options.minGroundClearance : 2.0;
        const localSurfaceY = this.sampleLocalSurfaceHeight(station.positionLocalENU[0], station.positionLocalENU[2], 6.0);
        const groundDatumY = Math.max(
            this.meshBounds ? this.meshBounds.min[1] : 0.0,
            localSurfaceY > -Infinity ? localSurfaceY : 0.0
        );
        if (station.positionLocalENU[1] < groundDatumY + minGroundClearance) {
            const oldY = station.positionLocalENU[1];
            const newY = Number((groundDatumY + minGroundClearance).toFixed(3));
            station.positionLocalENU[1] = newY;
            station.cameraHeightAboveGround = Number((station.positionLocalENU[1] - (station.groundElevationASL ?? 0)).toFixed(3));

            const approxDist = Math.max(30.0, Math.hypot(station.positionLocalENU[0], station.positionLocalENU[2]));
            const targetX = station.positionLocalENU[0] + approxDist * station.forwardVector[0];
            const targetY = oldY + approxDist * station.forwardVector[1];
            const targetZ = station.positionLocalENU[2] + approxDist * station.forwardVector[2];

            const newDx = targetX - station.positionLocalENU[0];
            const newDy = targetY - newY;
            const newDz = targetZ - station.positionLocalENU[2];
            const newLen = Math.hypot(newDx, newDy, newDz);
            if (newLen > 1e-3) {
                station.forwardVector = [newDx / newLen, newDy / newLen, newDz / newLen];
                station.pitchDegrees = Number(((Math.asin(station.forwardVector[1]) * 180) / Math.PI).toFixed(2));
                station.yawDegrees = Number(((Math.atan2(station.forwardVector[0], station.forwardVector[2]) * 180) / Math.PI).toFixed(2));
            }
        }
        const width = options.width ?? 1920;
        const height = options.height ?? Math.round(width / (station.aspectRatio || 16 / 9));
        const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(station, width, height);
        const shaded = HeadlessMeshSilhouetteRenderer.renderShadedMesh(this.mesh, pose, width, height, {
            clayColor: options.clayColor ?? [190, 195, 200],
            bgColor: options.bgColor ?? [118, 150, 190, 255],
            lightDir: options.lightDir,
            clipNearPlane: true
        });
        return {
            stationId: station.id,
            width, height,
            rgba: shaded.rgba,
            png: HeadlessMeshSilhouetteRenderer.encodePng(width, height, shaded.rgba),
            depth: shaded.depthBuffer,
            depthKind: 'camera-z',
            silhouette: shaded.silhouetteBuffer,
            intrinsics,
            cameraPose: pose
        };
    }

    /**
     * Unified multi-modal station rendering provider:
     * - 'clay': Fast software scanline rasterization of untextured mesh.
     * - 'pathtraced' / 'albedo': Full C++20 BVH path tracer with PBR texture decoding,
     *   float32 ray-distance unprojection, and optional stone albedo calibration.
     */
    async renderStation(station: ColmapCameraPose, options: StationRenderOptions = {}): Promise<StationBlockoutRender> {
        const mode = options.renderMode || 'clay';
        if (mode === 'clay') {
            return this.renderStationBlockout(station, options);
        }

        const glb = options.glbPath || this.glbPath;
        if (!glb) {
            // Fall back to software clay if no GLB file path is available
            return this.renderStationBlockout(station, options);
        }

        if (!this.pathTracer) {
            this.pathTracer = new NativeTilePathTracerService();
        }

        const width = options.width ?? 1920;
        const height = options.height ?? Math.round(width / (station.aspectRatio || 16 / 9));
        const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(station, width, height);

        const workDir = options.workDir || path.resolve(process.cwd(), `build/station_pt_${station.id}_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
        await fs.ensureDir(workDir);

        const sun: TileSunSpec = options.sun || (station.coordinatesWGS84 ? {
            latitude: station.coordinatesWGS84.lat,
            longitude: station.coordinatesWGS84.lng,
            isoDate: options.isoDate || new Date().toISOString()
        } : { elevationDeg: 55.0, azimuthDeg: 140.0 });

        const shadingMode = mode === 'albedo' ? 'baked' : 'baked';
        const exposureEv = options.exposureEv !== undefined ? options.exposureEv : 0.0;

        try {
            const ptRes = await this.pathTracer.render({
                glbPath: glb,
                outputDir: workDir,
                width,
                height,
                samplesPerPixel: options.samplesPerPixel || 4,
                shadingMode,
                denoise: false,
                groundPlane: false,
                exposureEv,
                sun,
                camera: {
                    position: [pose.x, pose.y, pose.z],
                    target: [pose.targetX, pose.targetY, pose.targetZ],
                    verticalFovDeg: intrinsics.verticalFovDegrees,
                    up: pose.up
                }
            });

            // Convert ray-distance depth.f32 to perpendicular camera-Z depth
            const rawDistBuf = await fs.readFile(ptRes.depthF32Path);
            const rawDist = new Float32Array(rawDistBuf.buffer, rawDistBuf.byteOffset, rawDistBuf.byteLength / 4);

            const vFovRad = (intrinsics.verticalFovDegrees * Math.PI) / 180.0;
            const fy = (height / 2.0) / Math.tan(vFovRad / 2.0);
            const fx = fy;
            const cx = width / 2.0;
            const cy = height / 2.0;

            const depth = new Float32Array(width * height);
            const silhouette = new Uint8Array(width * height);

            for (let y = 0; y < height; y++) {
                const vOffset = (y + 0.5 - cy) / fy;
                for (let x = 0; x < width; x++) {
                    const idx = y * width + x;
                    const d = rawDist[idx];
                    if (d > 0.05 && d < 4000.0) {
                        const uOffset = (x + 0.5 - cx) / fx;
                        const rayLengthFactor = Math.hypot(1.0, uOffset, vOffset);
                        depth[idx] = d / rayLengthFactor;
                        silhouette[idx] = 255;
                    } else {
                        depth[idx] = EMPTY_DEPTH;
                        silhouette[idx] = 0;
                    }
                }
            }

            // Read the image (albedo.png or beauty.png)
            const targetPngPath = (mode === 'albedo' && ptRes.albedoPngPath) ? ptRes.albedoPngPath : ptRes.beautyPngPath;
            const imgPngBytes = await fs.readFile(targetPngPath);
            const decoded = decodePng(imgPngBytes);
            let finalRgba = decoded.rgba;

            if (options.stoneType) {
                finalRgba = calibrateStoneAlbedoRgba(finalRgba, width, height, { stoneType: options.stoneType });
            }

            const finalPng = HeadlessMeshSilhouetteRenderer.encodePng(width, height, finalRgba);

            return {
                stationId: station.id,
                width,
                height,
                rgba: finalRgba,
                png: finalPng,
                depth,
                depthKind: 'camera-z',
                silhouette,
                intrinsics,
                cameraPose: pose
            };
        } finally {
            if (!options.workDir) {
                await fs.remove(workDir).catch(() => {});
            }
        }
    }

    /**
     * Samples local mesh surface height within a horizontal search radius.
     */
    public sampleLocalSurfaceHeight(x: number, z: number, searchRadius: number = 6.0): number {
        if (!this.mesh) return -Infinity;
        const v = this.mesh.vertices;
        let maxY = -Infinity;
        const r2 = searchRadius * searchRadius;
        for (let i = 0; i < v.length; i += 3) {
            const vx = v[i];
            const vz = v[i + 2];
            const dx = vx - x;
            const dz = vz - z;
            if (dx * dx + dz * dz <= r2) {
                const vy = v[i + 1];
                if (vy > maxY) maxY = vy;
            }
        }
        return maxY;
    }

    /**
     * Fills `station.beautify` with mesh-grounded facts: standoff along the optical axis, horizon
     * row, sky fraction, footprint coverage of the mesh ground extent, and the sun for `isoDate`.
     */
    enrichStations(stations: ColmapCameraPose[], options: StationEnrichOptions = {}): ColmapCameraPose[] {
        if (!this.mesh || !this.meshBounds) throw new Error('SurveyStationRenderService: call loadMesh() first');
        const width = options.width ?? 320;
        const height = options.height ?? 180;
        const date = options.isoDate ? new Date(options.isoDate) : new Date();
        const isoDate = options.isoDate ?? date.toISOString();

        return stations.map(st => {
            // Strict Invariant: Camera perspectives must never fall below the ground truth of the model.
            // Check both global mesh bounds and local surface elevation (terrain / roofs) beneath camera.
            const minGroundClearance = 2.0;
            const localSurfaceY = this.sampleLocalSurfaceHeight(st.positionLocalENU[0], st.positionLocalENU[2], 6.0);
            const groundDatumY = Math.max(
                this.meshBounds ? this.meshBounds.min[1] : 0.0,
                localSurfaceY > -Infinity ? localSurfaceY : 0.0
            );
            if (st.positionLocalENU[1] < groundDatumY + minGroundClearance) {
                const oldY = st.positionLocalENU[1];
                const newY = Number((groundDatumY + minGroundClearance).toFixed(3));
                st.positionLocalENU[1] = newY;
                st.cameraHeightAboveGround = Number((st.positionLocalENU[1] - (st.groundElevationASL ?? 0)).toFixed(3));

                // Preserve gaze target when elevated
                const approxDist = Math.max(30.0, Math.hypot(st.positionLocalENU[0], st.positionLocalENU[2]));
                const targetX = st.positionLocalENU[0] + approxDist * st.forwardVector[0];
                const targetY = oldY + approxDist * st.forwardVector[1];
                const targetZ = st.positionLocalENU[2] + approxDist * st.forwardVector[2];

                const newDx = targetX - st.positionLocalENU[0];
                const newDy = targetY - newY;
                const newDz = targetZ - st.positionLocalENU[2];
                const newLen = Math.hypot(newDx, newDy, newDz);
                if (newLen > 1e-3) {
                    st.forwardVector = [newDx / newLen, newDy / newLen, newDz / newLen];
                    st.pitchDegrees = Number(((Math.asin(st.forwardVector[1]) * 180) / Math.PI).toFixed(2));
                    st.yawDegrees = Number(((Math.atan2(st.forwardVector[0], st.forwardVector[2]) * 180) / Math.PI).toFixed(2));
                }
            }
            const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(st, width, height);
            const { depthBuffer } = HeadlessMeshSilhouetteRenderer.renderMesh(this.mesh!, pose, width, height, { clipNearPlane: true });

            // Standoff: centre pixel, falling back to the nearest filled pixel in a 5x5 window
            let standoff: number | undefined;
            const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
            outer: for (let r = 0; r <= 2; r++) {
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    const d = depthBuffer[(cy + dy) * width + (cx + dx)];
                    if (d < EMPTY_DEPTH * 0.5) { standoff = d; break outer; }
                }
            }

            let empty = 0;
            for (let i = 0; i < depthBuffer.length; i++) if (depthBuffer[i] >= EMPTY_DEPTH * 0.5) empty++;
            const skyFraction = empty / depthBuffer.length;

            // Horizon row: level direction relative to the optical axis, projected with the vertical fov
            const pitchRad = (st.pitchDegrees * Math.PI) / 180;
            const tanHalfV = Math.tan((intrinsics.verticalFovDegrees / 2) * Math.PI / 180);
            const horizonRowFraction = Math.max(0, Math.min(1, 0.5 + Math.tan(pitchRad) / (2 * tanHalfV)));

            const meshCoverageFraction = this.footprintCoverage(st);

            const sun = solarAtUtcInstant(date, st.coordinatesWGS84.lat, st.coordinatesWGS84.lng);
            const metrics: StationBeautifyMetrics = {
                ...(st.beautify || {}),
                standoffMeters: standoff !== undefined ? Number(standoff.toFixed(3)) : undefined,
                horizonRowFraction: Number(horizonRowFraction.toFixed(4)),
                skyFraction: Number(skyFraction.toFixed(4)),
                meshCoverageFraction: Number(meshCoverageFraction.toFixed(4)),
                solar: { azimuthDegrees: Number(sun.azimuthDegrees.toFixed(2)), elevationDegrees: Number(sun.elevationDegrees.toFixed(2)), isoDate }
            };
            return { ...st, beautify: metrics };
        });
    }

    /** Fraction of the station's ground footprint (sampled 8x8) that lies inside the mesh XZ extent. */
    private footprintCoverage(st: ColmapCameraPose): number {
        const b = this.meshBounds!;
        const fp = st.frustumFootprintWGS84;
        if (!fp || fp.length < 4) return 0;
        // Footprint is in WGS84; bring it back to the local frame via the station's own anchor (ground elevation)
        // We do not have the anchor here, so recover local corners from the station geometry directly.
        const ltp = new LocalTangentPlane({ lat: st.coordinatesWGS84.lat, lng: st.coordinatesWGS84.lng, alt: st.coordinatesWGS84.elevation });
        const cornersRel = fp.map(([lng, lat]) => ltp.toLocal({ lat, lng, alt: st.groundElevationASL ?? 0 }));
        const corners = cornersRel.map(c => [c[0] + st.positionLocalENU[0], 0, c[2] + st.positionLocalENU[2]]);
        let inside = 0, total = 0;
        const N = 8;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
            const u = (i + 0.5) / N, v = (j + 0.5) / N;
            // bilinear over the quad TL, TR, BR, BL
            const x = (1 - v) * ((1 - u) * corners[0][0] + u * corners[1][0]) + v * ((1 - u) * corners[3][0] + u * corners[2][0]);
            const z = (1 - v) * ((1 - u) * corners[0][2] + u * corners[1][2]) + v * ((1 - u) * corners[3][2] + u * corners[2][2]);
            total++;
            if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2]) inside++;
        }
        return total ? inside / total : 0;
    }
}
