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
import { BeautifyStationService, type StationImageGenerator, type BeautifyStationResult } from './BeautifyStationService';
import type { StationBeautifyContext } from '../../browser/generative-canvas/services/location-beautify-service';
import { Splat3DTilesService } from './Splat3DTilesService';
import { SplatService } from '../3d-engine/splat-service';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import type { BakedGaussian } from '../../common/geospatial-4d-protocol';

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
    sigmaScale?: number;           // default 0.95
    /** Drop samples seen more edge-on than this |n.view| (default 0.12); 0 disables the grazing filter. */
    minCosIncidence?: number;
    voxelSizeMeters?: number;      // fusion grid, default derived from footprint (~0.75 x median splat sigma)
    isoDate?: string;
    headingDeg?: number;
    maxRerolls?: number;
    tiles?: { maxDepth?: number; leafCapacity?: number; interiorBudget?: number };
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

    constructor(private deps: { generator: StationImageGenerator }) {}

    async ensureBaker(): Promise<string> {
        if (fs.existsSync(this.bakerPath)) return this.bakerPath;
        const src = path.resolve(process.cwd(), 'scripts/station_to_splats.cpp');
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
            const beautifier = new BeautifyStationService(renderer, this.deps.generator);

            const reports: SurveySplatStationReport[] = [];
            const splatSets: { splats: BakedGaussian[]; station: ColmapCameraPose }[] = [];
            let reference: BeautifyStationResult | undefined;
            for (let i = 0; i < stations.length; i++) {
                const st = stations[i];
                report(0.05 + 0.7 * (i / stations.length), `Beautifying station ${st.id} (${i + 1}/${stations.length})`);
                const res = await beautifier.beautify(st, req.beautify, { width, reference: mode === 'chained' ? reference : undefined, maxRerolls: req.maxRerolls });
                const base = path.join(stationsDir, `station_${String(st.id).padStart(3, '0')}`);
                await fs.outputFile(`${base}_blockout.png`, res.blockout.png);
                await fs.outputFile(`${base}_beautified.png`, res.imagePng);
                if (res.warp) await fs.outputFile(`${base}_warp.png`, res.warp.warpedPng);
                const rep: SurveySplatStationReport = {
                    stationId: st.id, accepted: res.accepted, attempts: res.attempts, usedReference: !!res.warp, splatCount: 0,
                    imagePath: `${base}_beautified.png`, blockoutPath: `${base}_blockout.png`, qc: res.qc, prompt: res.prompt
                };
                if (res.accepted) {
                    const baked = await this.bakeStation(baker, res, `${base}.splat`, req);
                    rep.splatCount = baked.length;
                    rep.splatPath = `${base}.splat`;
                    splatSets.push({ splats: baked, station: res.alignedStation });
                    if (mode === 'chained') reference = res;
                }
                reports.push(rep);
            }
            if (splatSets.length === 0) throw new Error('No station passed QC; nothing to bake');

            report(0.8, 'Fusing station splats');
            const medianSigma = SurveySplatPipelineService.medianSigma(splatSets.flatMap(s => s.splats));
            const voxel = req.voxelSizeMeters ?? Math.max(0.01, medianSigma * 0.75);
            const fused = SurveySplatPipelineService.fuse(splatSets, voxel);
            await fs.outputFile(fusedSplatPath, SplatService.serializeSplatBuffer(fused));

            report(0.88, 'Tiling');
            const tiles = new Splat3DTilesService();
            const tileRes = await tiles.convert({ inputPath: fusedSplatPath, outDir, origin: { lat: req.anchor.lat, lng: req.anchor.lng, alt: req.anchor.elevationMeters }, headingDeg: req.headingDeg ?? 0, maxDepth: req.tiles?.maxDepth ?? 5, leafCapacity: req.tiles?.leafCapacity, interiorBudget: req.tiles?.interiorBudget });
            if (!tileRes.success) throw new Error(tileRes.error || 'Tiling failed');

            const cropBox = SurveySplatPipelineService.cropBox(splatSets.map(s => s.station), renderer.getMeshBounds()!, fused);
            const meta = {
                generator: this.deps.generator.name, mode, anchor: req.anchor, glbPath: req.glbPath,
                eyeHeight: stations[0]?.cameraHeightAboveGround ?? 1.7,
                cropBox, fusedSplatCount: fused.length, voxelSizeMeters: voxel,
                stations: reports, tiles: { tileCount: tileRes.tileCount, levels: tileRes.levels, tileBytes: tileRes.tileBytes },
                createdAt: new Date().toISOString()
            };
            await fs.writeJson(metaPath, meta, { spaces: 2 });
            report(1, 'Done');
            return { success: true, stations: reports, fusedSplatPath, fusedSplatCount: fused.length, tilesetPath, metaPath, cropBox, durationMs: Date.now() - t0 };
        } catch (e: any) {
            return { success: false, stations: [], fusedSplatPath, fusedSplatCount: 0, tilesetPath, metaPath, cropBox: { min: [0, 0, 0], max: [0, 0, 0] }, durationMs: Date.now() - t0, error: e?.message || String(e) };
        }
    }

    /** Writes raw RGB + f32 depth + pose json for the aligned station and runs the native baker. */
    private async bakeStation(baker: string, res: BeautifyStationResult, outSplat: string, req: SurveySplatPipelineRequest): Promise<BakedGaussian[]> {
        const { width, height } = res.blockout;
        const img = res.image;
        // Resample the generated image onto the blockout grid if the model changed resolution
        const rgb = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) {
            const sy = Math.min(img.height - 1, Math.floor(y * img.height / height));
            for (let x = 0; x < width; x++) {
                const sx = Math.min(img.width - 1, Math.floor(x * img.width / width));
                const si = (sy * img.width + sx) * 4, di = (y * width + x) * 3;
                rgb[di] = img.rgba[si]; rgb[di + 1] = img.rgba[si + 1]; rgb[di + 2] = img.rgba[si + 2];
            }
        }
        // Depth for the ALIGNED pose (QC may have moved the camera slightly): re-render mesh depth there
        const renderer = new SurveyStationRenderService();
        renderer.setMesh((await this.meshFor(req.glbPath)));
        const aligned = renderer.renderStationBlockout(res.alignedStation, { width, height });
        const depth = Buffer.from(aligned.depth.buffer, aligned.depth.byteOffset, aligned.depth.byteLength);
        const { right, up, forward } = cameraBasis(res.alignedStation.forwardVector, res.alignedStation.upVector || [0, 1, 0]);
        const pose = { fx: aligned.intrinsics.fx, fy: aligned.intrinsics.fy, cx: aligned.intrinsics.cx, cy: aligned.intrinsics.cy, eye: res.alignedStation.positionLocalENU, right, up, forward, depthKind: 'camera-z' };
        const base = outSplat.replace(/\.splat$/, '');
        await fs.outputFile(`${base}.rgb`, rgb);
        await fs.outputFile(`${base}.depth.f32`, depth);
        await fs.writeJson(`${base}.pose.json`, pose);
        const cmd = `"${baker}" --rgb "${base}.rgb" --depth "${base}.depth.f32" --width ${width} --height ${height} --pose "${base}.pose.json" --out-splat "${outSplat}" --stride ${req.bakeStride ?? 1} --sigma-scale ${req.sigmaScale ?? 0.95} --min-cos-incidence ${req.minCosIncidence ?? 0.12} --json`;
        await execAsync(cmd, { maxBuffer: 8 * 1024 * 1024 });
        await fs.remove(`${base}.rgb`); await fs.remove(`${base}.depth.f32`);
        return SplatService.parseSplatBuffer(await fs.readFile(outSplat));
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
        return [...grid.values()];
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
