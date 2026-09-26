/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SurveySynthesisEngine, cameraBasis } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService, EMPTY_DEPTH } from './SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator, hasStationImageCredentials, type StationImageGenerator, type BeautifyStationResult } from './BeautifyStationService';
import type { StationBeautifyContext } from '../../browser/generative-canvas/services/location-beautify-service';
import { Splat3DTilesService } from './Splat3DTilesService';
import { SplatService } from '../3d-engine/splat-service';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import type { BakedGaussian } from '../../common/geospatial-4d-protocol';
import { decodePng } from '../texture-processing';

const execAsync = promisify(exec);

export interface SurveySplatPipelineRequest {
    glbPath: string;
    anchor: GeodeticAnchor;
    /** Stations to process (already enriched or not; they are re-enriched against the GLB). */
    stations: ColmapCameraPose[];
    outDir: string;
    beautify: StationBeautifyContext;
    /** 'chained' warps each accepted image into the next station (consistent materials); 'fanout' beautifies independently. */
    mode?: 'chained' | 'fanout';
    /** Optional ranking cap: keep only the best N stations (uses enrichment metrics). */
    maxStations?: number;
    renderWidth?: number;          // default 1920
    bakeStride?: number;           // default 1
    sigmaScale?: number;           // default 1.15
    /** Drop samples seen more edge-on than this |n.view| (default 0.05); 0 disables the grazing filter. */
    minCosIncidence?: number;
    voxelSizeMeters?: number;
    clean?: boolean;
    isoDate?: string;
    headingDeg?: number;
    maxRerolls?: number;
    /** If true (default), drops organic foliage pixels to avoid lumpy melting mounds. */
    dropFoliage?: boolean;
    /** Semantic foliage handling mode: 'drop' leaves clean clay blockout; 'jitter' spawns spherical volume splats. */
    foliageMode?: 'drop' | 'jitter';
    /** Enable hybrid micro-depth displacement extracting sharp relief directly from photo */
    enableHybridMicroDepth?: boolean;
    /** Extract high-frequency micro-relief directly from 2D photo luminance */
    enablePhotometricMicroDepth?: boolean;
    /** Path to external neural depth map (e.g. Depth Anything V2/V3 or MoGe) */
    neuralDepthPath?: string;
    /** Weight alpha for neural/photometric delta Z */
    neuralDepthWeight?: number;
    /** Maximum depth offset clamp in meters (default 3.5m) */
    maxDeltaZ?: number;
    /** Cavity depth offset in meters (default 3.5m) */
    cavityDepth?: number;
    /** Cavity luminance threshold (default 0.18) */
    cavityLum?: number;
    /** Cosine threshold for multi-view normal consensus pruning (default 0.0) */
    normalPruneCos?: number;
    /** Crop box override for landmark bounds */
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    /** Horizontal radius crop in meters around origin (default 115m) */
    cropRadius?: number;
    /** Silhouette mask erosion pixels (default 2px) to eliminate sky bleed */
    erodeSilhouettePx?: number;
    /** If true, drops multi-view inconsistent splats with large color delta (>40/255) */
    dropInconsistent?: boolean;
    /** Maximum color channel delta across views before voxel is considered inconsistent */
    colorConsistencyThresh?: number;
    tiles?: { maxDepth?: number; leafCapacity?: number; interiorBudget?: number };
    /** Force rebaking of all stations even if valid baked splats already exist on disk */
    forceRebake?: boolean;
    /** If true, uses 2D Gaussian Surface Regularization (squashed normal axis sz = 1e-4) to eliminate raymarching bleeding */
    use2dgs?: boolean;
    /** Surface model choice: 'planar' (2DGS planar surfels) vs 'ellipsoid' (3D ellipsoids) */
    surfaceModel?: 'planar' | 'ellipsoid';
    /** Higher-order spherical harmonics degree (0 = RGB only, 1 = 9 coefficients, 2 = 24, 3 = 45) */
    shDegree?: number;
    /** Multi-station photometric exposure normalization scale */
    exposureScale?: number;
}

export interface SurveySplatStationReport {
    stationId: number;
    accepted: boolean;
    attempts: number;
    usedReference: boolean;
    splatCount: number;
    imagePath: string;
    blockoutPath: string;
    splatPath?: string;
    qc: BeautifyStationResult['qc'];
    prompt: string;
    positionLocalENU?: [number, number, number];
    forwardVector?: [number, number, number];
    name?: string;
}

export interface SurveySplatPipelineResult {
    success: boolean;
    stations: SurveySplatStationReport[];
    fusedSplatPath: string;
    fusedSplatCount: number;
    tilesetPath: string;
    metaPath: string;
    cropBox: { min: [number, number, number]; max: [number, number, number] };
    durationMs: number;
    error?: string;
}

export type ProgressReporter = (progress: number, message?: string) => void;

/**
 * High-throughput orchestration of the Zero-Drift Multi-View Generative 3DGS pipeline:
 * Stations -> beautify -> bake -> fuse -> 3D Tiles.
 *
 * Each accepted station image is unprojected with the mesh's own depth at the QC-aligned pose
 * (scripts/station_to_splats.cpp), the per-station splat sets are fused by voxel hash preferring the
 * station whose view is most normal to the surface, and the result is tiled with a geodetic root
 * transform so it overlays the source Google 3D Tiles. A crop box (union of station frusta clipped
 * to the mesh extent) is written for the viewer's bounding-volume discard.
 */
export class SurveySplatPipelineService {
    private compiler = new NativeCppCompilerService();
    private bakerPath = path.resolve(process.cwd(), 'build/station_to_splats');

    constructor(private deps?: { generator?: StationImageGenerator }) {
        if (!this.deps?.generator && hasStationImageCredentials()) {
            this.deps = { ...this.deps, generator: createDefaultStationImageGenerator() };
        }
    }

    /** QC for a station whose plate was reused from disk: nothing was re-measured. */
    static cachedPlateQc(): BeautifyStationResult['qc'] {
        return {
            passed: false,
            overlapPercent: Number.NaN,
            residualPx: Number.NaN,
            deltaYawDeg: Number.NaN,
            deltaPitchDeg: Number.NaN,
            deltaPositionM: Number.NaN,
            reason: 'cached plate reused; QC not re-run'
        };
    }

    async ensureBaker(): Promise<string> {
        const src = path.resolve(process.cwd(), 'scripts/station_to_splats.cpp');
        if (fs.existsSync(this.bakerPath)) {
            const srcStat = await fs.stat(src);
            const binStat = await fs.stat(this.bakerPath);
            if (binStat.mtimeMs >= srcStat.mtimeMs) {
                return this.bakerPath;
            }
        }
        await fs.ensureDir(path.dirname(this.bakerPath));
        await execAsync(`${process.env.CXX || 'clang++'} -std=c++20 -O3 -I "${this.compiler.getSdkIncludePath()}" -lz "${src}" -o "${this.bakerPath}"`);
        return this.bakerPath;
    }

    async run(req: SurveySplatPipelineRequest, report: ProgressReporter = () => {}): Promise<SurveySplatPipelineResult> {
        const t0 = Date.now();
        const outDir = req.outDir;
        const stationsDir = path.join(outDir, 'stations');
        const fusedSplatPath = path.join(outDir, 'fused.splat');
        const tilesetPath = path.join(outDir, 'tileset.json');
        const metaPath = path.join(outDir, 'tileset.meta.json');
        try {
            await fs.ensureDir(stationsDir);
            report(0.02, 'Loading mesh');
            const renderer = new SurveyStationRenderService();
            await renderer.loadMesh(req.glbPath);
            const engine = new SurveySynthesisEngine();
            let stations = renderer.enrichStations(req.stations, { isoDate: req.isoDate });
            if (req.maxStations && req.maxStations < stations.length) stations = engine.rankForBeautify(stations, { maxCount: req.maxStations });
            const mode = req.mode ?? 'chained';
            const width = req.renderWidth ?? 1920;
            const baker = await this.ensureBaker();
            const beautifier = this.deps?.generator ? new BeautifyStationService(renderer, this.deps.generator) : null;

            const reports: SurveySplatStationReport[] = [];
            const bakedStations: { splatPath: string; station: ColmapCameraPose }[] = [];
            let reference: BeautifyStationResult | undefined;
            for (let i = 0; i < stations.length; i++) {
                const st = stations[i];
                const base = path.join(stationsDir, `station_${String(st.id).padStart(3, '0')}`);
                const splatPath = `${base}.splat`;
                const posePath = `${base}.pose.json`;
                const beautifiedPath = `${base}_beautified.png`;
                const blockoutPath = `${base}_blockout.png`;

                if (!req.forceRebake) {
                    const stStat = await fs.stat(splatPath).catch(() => null);
                    const bStat = await fs.stat(beautifiedPath).catch(() => null);
                    if (stStat && stStat.size > 100000 && fs.existsSync(posePath) && (!bStat || stStat.mtimeMs >= bStat.mtimeMs)) {
                        report(0.05 + 0.7 * (i / stations.length), `Reusing cached station ${st.id} (${i + 1}/${stations.length})`);
                        const pose = await fs.readJson(posePath).catch(() => null);
                        const splatCount = Math.floor(stStat.size / 32);
                        const posENU: [number, number, number] = (pose?.eye || st.positionLocalENU) as [number, number, number];
                        const fwdVec: [number, number, number] = (pose?.forward || st.forwardVector) as [number, number, number];
                        const rep: SurveySplatStationReport = {
                            stationId: st.id, accepted: true, attempts: 1, usedReference: false, splatCount, splatPath,
                            imagePath: beautifiedPath, blockoutPath,
                            qc: SurveySplatPipelineService.cachedPlateQc(),
                            prompt: `Photorealistic view of station ${st.id}`,
                            positionLocalENU: posENU,
                            forwardVector: fwdVec,
                            name: st.name
                        };
                        bakedStations.push({ splatPath, station: { ...st, positionLocalENU: posENU, forwardVector: fwdVec } });
                        reports.push(rep);
                        continue;
                    }
                }

                let res: BeautifyStationResult;
                if (await fs.pathExists(beautifiedPath)) {
                    report(0.05 + 0.7 * (i / stations.length), `Baking from existing beautified image for station ${st.id} (${i + 1}/${stations.length})`);
                    const imagePng = await fs.readFile(beautifiedPath);
                    const dec = decodePng(imagePng);
                    const height = Math.round(width * 9 / 16);
                    const blockout = renderer.renderStationBlockout(st, { width, height });
                    await fs.outputFile(blockoutPath, blockout.png);
                    res = {
                        station: st,
                        alignedStation: st,
                        prompt: `Photorealistic view of station ${st.id}`,
                        blockout,
                        imagePng,
                        image: { width: dec.width, height: dec.height, rgba: dec.rgba },
                        qc: SurveySplatPipelineService.cachedPlateQc(),
                        accepted: true,
                        attempts: 1,
                        generator: this.deps?.generator?.name || 'cached-beautified-plates'
                    };
                } else {
                    if (!beautifier) {
                        throw new Error(`Cannot beautify station ${st.id}: no StationImageGenerator was supplied and no cached plate exists on disk at ${beautifiedPath}`);
                    }
                    report(0.05 + 0.7 * (i / stations.length), `Beautifying station ${st.id} (${i + 1}/${stations.length})`);
                    res = await beautifier.beautify(st, req.beautify, { width, reference: mode === 'chained' ? reference : undefined, maxRerolls: req.maxRerolls });
                    await fs.outputFile(blockoutPath, res.blockout.png);
                    await fs.outputFile(beautifiedPath, res.imagePng);
                    if (res.warp) await fs.outputFile(`${base}_warp.png`, res.warp.warpedPng);
                }

                const rep: SurveySplatStationReport = {
                    stationId: st.id, accepted: res.accepted, attempts: res.attempts, usedReference: !!res.warp, splatCount: 0,
                    imagePath: beautifiedPath, blockoutPath: blockoutPath, qc: res.qc, prompt: res.prompt,
                    positionLocalENU: res.alignedStation.positionLocalENU || st.positionLocalENU,
                    forwardVector: res.alignedStation.forwardVector || st.forwardVector,
                    name: st.name
                };
                if (res.accepted) {
                    const baked = await this.bakeStation(baker, res, `${base}.splat`, req);
                    rep.splatCount = baked.splatCount;
                    rep.splatPath = baked.splatPath;
                    bakedStations.push({ splatPath: baked.splatPath, station: res.alignedStation });
                    if (mode === 'chained') reference = res;
                }
                reports.push(rep);
            }
            if (bakedStations.length === 0) throw new Error('No station passed QC; nothing to bake');

            report(0.8, 'Fusing station splats');
            const voxel = req.voxelSizeMeters ?? 0.025;
            const listPath = path.join(outDir, 'stations_to_fuse.txt');
            await fs.outputFile(listPath, bakedStations.map(s => `${s.splatPath} ${s.station.cameraAltitude ?? s.station.positionLocalENU?.[1] ?? s.station.cameraHeightAboveGround ?? 50.0}`).join('\n'));
            const dropFoliageArg = req.dropFoliage !== false ? '--drop-foliage' : '';
            const normalPruneArg = `--normal-prune-cos ${req.normalPruneCos ?? 0.0}`;
            const consistencyArg = req.dropInconsistent ? `--drop-inconsistent --color-consistency-thresh ${req.colorConsistencyThresh ?? 40.0}` : '';
            const cropRadiusVal = req.cropRadius ?? (req.cropBox ? Math.max(Math.abs(req.cropBox.max[0]), Math.abs(req.cropBox.max[2])) : 115.0);
            const cropRadiusArg = cropRadiusVal > 0 ? `--crop-radius ${cropRadiusVal}` : '';
            const fuseCmd = `"${baker}" --fuse-list "${listPath}" --voxel-size ${voxel} ${cropRadiusArg} ${dropFoliageArg} ${normalPruneArg} ${consistencyArg} --exclude-underside --out-splat "${fusedSplatPath}" --json`;
            const { stdout: fuseStdout } = await execAsync(fuseCmd, { maxBuffer: 16 * 1024 * 1024 });
            const fuseRes = JSON.parse(fuseStdout.trim());
            await fs.remove(listPath).catch(() => {});
            const fusedCount = fuseRes.fusedSplatCount ?? 0;

            report(0.88, 'Tiling');
            const tiles = new Splat3DTilesService();
            const tileRes = await tiles.convert({ inputPath: fusedSplatPath, outDir, origin: { lat: req.anchor.lat, lng: req.anchor.lng, alt: req.anchor.elevationMeters }, headingDeg: req.headingDeg ?? 0, maxDepth: req.tiles?.maxDepth ?? 5, leafCapacity: req.tiles?.leafCapacity, interiorBudget: req.tiles?.interiorBudget });
            if (!tileRes.success) throw new Error(tileRes.error || 'Tiling failed');

            const meshBounds = renderer.getMeshBounds()!;
            const fMin = fuseRes.bounds?.min ?? [-100, -100, -100];
            const fMax = fuseRes.bounds?.max ?? [100, 100, 100];
            const cropBox = req.cropBox ?? {
                min: [
                    Math.min(fMin[0] - 1.0, meshBounds.min[0] - 1.0),
                    Math.min(0.0, Math.min(fMin[1] - 0.5, meshBounds.min[1] - 0.5)),
                    Math.min(fMin[2] - 1.0, meshBounds.min[2] - 1.0)
                ] as [number, number, number],
                max: [
                    Math.max(fMax[0] + 1.0, meshBounds.max[0] + 1.0),
                    Math.max(fMax[1] + 1.0, meshBounds.max[1] + 1.0),
                    Math.max(fMax[2] + 1.0, meshBounds.max[2] + 1.0)
                ] as [number, number, number]
            };
            const meta = {
                generator: this.deps?.generator?.name || 'cached-beautified-plates', mode, anchor: req.anchor, glbPath: req.glbPath,
                eyeHeight: stations[0]?.cameraHeightAboveGround ?? 1.7,
                cropBox, fusedSplatCount: fusedCount, voxelSizeMeters: voxel,
                stations: reports, tiles: { tileCount: tileRes.tileCount, levels: tileRes.levels, tileBytes: tileRes.tileBytes },
                createdAt: new Date().toISOString()
            };
            await fs.writeJson(metaPath, meta, { spaces: 2 });
            report(1, 'Done');
            return { success: true, stations: reports, fusedSplatPath, fusedSplatCount: fusedCount, tilesetPath, metaPath, cropBox, durationMs: Date.now() - t0 };
        } catch (e: any) {
            return { success: false, stations: [], fusedSplatPath, fusedSplatCount: 0, tilesetPath, metaPath, cropBox: { min: [0, 0, 0], max: [0, 0, 0] }, durationMs: Date.now() - t0, error: e?.message || String(e) };
        }
    }

    /** Writes raw RGB + f32 depth + pose json for the aligned station and runs the native baker. */
    private async bakeStation(baker: string, res: BeautifyStationResult, outSplat: string, req: SurveySplatPipelineRequest): Promise<{ splatCount: number; splatPath: string }> {
        const img = res.image;
        // Retain full 2K resolution if available; otherwise use blockout dimensions
        const width = (img && img.width && img.width > res.blockout.width) ? img.width : res.blockout.width;
        const height = (img && img.height && img.height > res.blockout.height) ? img.height : res.blockout.height;

        let rgb: Buffer;
        if (img && img.width === width && img.height === height) {
            rgb = Buffer.alloc(width * height * 3);
            for (let i = 0; i < width * height; i++) {
                const si = i * 4, di = i * 3;
                rgb[di] = img.rgba[si];
                rgb[di + 1] = img.rgba[si + 1];
                rgb[di + 2] = img.rgba[si + 2];
            }
        } else {
            rgb = Buffer.alloc(width * height * 3);
            for (let y = 0; y < height; y++) {
                const sy = Math.min(img.height - 1, Math.floor(y * img.height / height));
                for (let x = 0; x < width; x++) {
                    const sx = Math.min(img.width - 1, Math.floor(x * img.width / width));
                    const si = (sy * img.width + sx) * 4, di = (y * width + x) * 3;
                    rgb[di] = img.rgba[si]; rgb[di + 1] = img.rgba[si + 1]; rgb[di + 2] = img.rgba[si + 2];
                }
            }
        }
        // Depth for the ALIGNED pose (QC may have moved the camera slightly): re-render mesh depth there
        const renderer = new SurveyStationRenderService();
        renderer.setMesh((await this.meshFor(req.glbPath)));
        const aligned = renderer.renderStationBlockout(res.alignedStation, { width, height });
        const depth = Buffer.from(aligned.depth.buffer, aligned.depth.byteOffset, aligned.depth.byteLength);
        const { right, up, forward } = cameraBasis(res.alignedStation.forwardVector, res.alignedStation.upVector || [0, 1, 0]);
        const alt = res.alignedStation.cameraAltitude ?? res.alignedStation.positionLocalENU?.[1] ?? res.alignedStation.cameraHeightAboveGround ?? 50.0;
        const pose = { fx: aligned.intrinsics.fx, fy: aligned.intrinsics.fy, cx: aligned.intrinsics.cx, cy: aligned.intrinsics.cy, eye: res.alignedStation.positionLocalENU, right, up, forward, cameraAltitude: alt, depthKind: 'camera-z' };
        const base = outSplat.replace(/\.splat$/, '');
        await fs.outputFile(`${base}.rgb`, rgb);
        await fs.outputFile(`${base}.depth.f32`, depth);
        await fs.writeJson(`${base}.pose.json`, pose);
        const dropFoliageArg = req.dropFoliage !== false ? '--drop-foliage' : '';
        const foliageModeArg = req.foliageMode ? `--foliage-mode ${req.foliageMode}` : '';
        const enablePhoto = (req.enablePhotometricMicroDepth !== false && req.enableHybridMicroDepth !== false);
        const hybridArg = enablePhoto ? `--photometric-micro-depth --cavity-depth ${req.cavityDepth ?? 3.5} --cavity-lum ${req.cavityLum ?? 0.18}` : '';
        const neuralDepthArg = req.neuralDepthPath ? `--neural-depth "${req.neuralDepthPath}"` : '';
        const neuralWeightArg = req.neuralDepthWeight !== undefined ? `--neural-depth-weight ${req.neuralDepthWeight}` : '';
        const maxDeltaZArg = req.maxDeltaZ !== undefined ? `--max-delta-z ${req.maxDeltaZ}` : '';
        const sigmaScaleArg = req.sigmaScale !== undefined ? `--sigma-scale ${req.sigmaScale}` : '';
        const minCosIncidenceArg = `--min-cos-incidence ${req.minCosIncidence ?? 0.20}`;
        const erodeSilhouetteArg = `--erode-silhouette ${req.erodeSilhouettePx ?? 2}`;
        const twoDgsArg = (req.use2dgs !== false || req.surfaceModel === 'planar') ? '--2dgs' : '';
        const shDegreeArg = (req.shDegree !== undefined && req.shDegree > 0) ? `--sh-degree ${req.shDegree}` : '';
        const exposureScaleArg = (req.exposureScale !== undefined) ? `--exposure-scale ${req.exposureScale}` : '';
        const cmd = `"${baker}" --rgb "${base}.rgb" --depth "${base}.depth.f32" --width ${width} --height ${height} --pose "${base}.pose.json" --out-splat "${outSplat}" --stride ${req.bakeStride ?? 1} --station-altitude ${alt} ${sigmaScaleArg} ${minCosIncidenceArg} ${dropFoliageArg} ${foliageModeArg} ${erodeSilhouetteArg} ${hybridArg} ${neuralDepthArg} ${neuralWeightArg} ${maxDeltaZArg} ${twoDgsArg} ${shDegreeArg} ${exposureScaleArg} --exclude-underside --json`;
        const { stdout } = await execAsync(cmd, { maxBuffer: 8 * 1024 * 1024 });
        await fs.remove(`${base}.rgb`); await fs.remove(`${base}.depth.f32`);
        let splatCount = 0;
        try {
            const parsed = JSON.parse(stdout.trim());
            splatCount = parsed.numSplats ?? 0;
        } catch {
            const st = await fs.stat(outSplat);
            splatCount = Math.floor(st.size / 32);
        }
        return { splatCount, splatPath: outSplat };
    }

    private meshCache: { path: string; mesh: any } | null = null;
    private async meshFor(glbPath: string) {
        if (this.meshCache && this.meshCache.path === glbPath) return this.meshCache.mesh;
        const { HeadlessMeshSilhouetteRenderer } = await import('./HeadlessMeshSilhouetteRenderer');
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        this.meshCache = { path: glbPath, mesh };
        return mesh;
    }

    static medianSigma(splats: BakedGaussian[]): number {
        if (splats.length === 0) return 0.05;
        const step = Math.max(1, Math.floor(splats.length / 5000));
        const v: number[] = [];
        for (let i = 0; i < splats.length; i += step) v.push(Math.max(splats[i].scale[0], splats[i].scale[1]));
        v.sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
    }

    /**
     * Voxel-hash fusion across stations. Within a voxel the splat whose station viewed the surface
     * most head-on wins (smallest elongation => smallest scale[0]/scale[1] ratio), so grazing views
     * do not smear over frontal ones; colours of ties are averaged.
     */
    static fuse(sets: { splats: BakedGaussian[]; station: ColmapCameraPose }[], voxel: number): BakedGaussian[] {
        const grid = new Map<string, BakedGaussian>();
        const inv = 1 / voxel;
        const elong = (s: BakedGaussian) => Math.max(s.scale[0], s.scale[1]) / Math.max(1e-6, Math.min(s.scale[0], s.scale[1]));
        for (const set of sets) {
            for (const s of set.splats) {
                const key = `${Math.floor(s.position[0] * inv)},${Math.floor(s.position[1] * inv)},${Math.floor(s.position[2] * inv)}`;
                const e = grid.get(key);
                if (!e) { grid.set(key, { ...s, position: [...s.position] as any, scale: [...s.scale] as any, colorRgb: [...s.colorRgb] as any }); continue; }
                const ea = elong(e), sa = elong(s);
                if (sa < ea * 0.9) grid.set(key, { ...s, position: [...s.position] as any, scale: [...s.scale] as any, colorRgb: [...s.colorRgb] as any });
                else if (sa <= ea * 1.1) { e.colorRgb[0] = (e.colorRgb[0] + s.colorRgb[0]) / 2; e.colorRgb[1] = (e.colorRgb[1] + s.colorRgb[1]) / 2; e.colorRgb[2] = (e.colorRgb[2] + s.colorRgb[2]) / 2; }
            }
        }
        return Array.from(grid.values());
    }

    /** AABB of the fused splats, clamped to the mesh extent: the viewer's discard volume. */
    static cropBox(_stations: ColmapCameraPose[], meshBounds: { min: [number, number, number]; max: [number, number, number] }, splats: BakedGaussian[]): { min: [number, number, number]; max: [number, number, number] } {
        const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        const step = Math.max(1, Math.floor(splats.length / 20000));
        for (let i = 0; i < splats.length; i += step) for (let k = 0; k < 3; k++) { const v = splats[i].position[k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
        for (let k = 0; k < 3; k++) { min[k] = Math.max(min[k] - 0.5, meshBounds.min[k] - 0.5); max[k] = Math.min(max[k] + 0.5, meshBounds.max[k] + 0.5); }
        return { min, max };
    }
}

export { EMPTY_DEPTH };
