/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { stationToPinhole, cameraBasis, type PinholeIntrinsics } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, StationBeautifyMetrics } from '../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import { getSolarPosition } from '../../common/coordinate/solarPosition';

/**
 * getSolarPosition() treats the Date's machine-local wall clock as the destination's local solar
 * time (a time-of-day slider convention). This wrapper takes a true UTC instant instead: it
 * constructs the Date whose wall clock the algorithm will map back onto that instant.
 */
export function solarAtUtcInstant(utc: Date, lat: number, lng: number): { azimuthDegrees: number; elevationDegrees: number } {
    const lngMs = (lng / 15) * 3600000;
    let t = utc.getTime() + lngMs;
    for (let i = 0; i < 2; i++) { // converge on the DST offset at t
        const d = new Date(t);
        t = utc.getTime() + lngMs + d.getTimezoneOffset() * 60000;
    }
    const s = getSolarPosition(new Date(t), lat, lng);
    return { azimuthDegrees: (s.azimuth * 180) / Math.PI, elevationDegrees: (s.altitude * 180) / Math.PI };
}

export interface StationBlockoutRenderOptions {
    width?: number;            // default 1920
    height?: number;           // default 1080
    clayColor?: [number, number, number];
    bgColor?: [number, number, number, number];
    lightDir?: [number, number, number];
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

    async loadMesh(glb: string | Buffer): Promise<void> {
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
