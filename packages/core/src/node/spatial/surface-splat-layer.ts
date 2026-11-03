/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The surface splat layer (docs/research/2026-10-30-surface-splat-layer-plan.md): a splat on every patch of the scan's
 * surface, coloured from the station images, in place of one splat per photo pixel thinned by a voxel fuse. Coverage
 * then follows the geometry, so a surface no photo happened to hit is not a hole. Each patch of surface is coloured
 * from one station, and the stations' colours are brought together only where they show the same content.
 *
 * This prepares what the native builder (scripts/mesh_to_surface_splats.cpp, scratchbox_surface_splats.hpp) reads: the
 * scan's triangles the hulls keep (splat-containment.ts: no pits, no car lumps, nothing above the scan), each station's
 * image at the size its camera was baked for, its depth for the occlusion test, rendered from the same mesh, and its
 * mask: its sky (segmentSky, the Street View registration's own, above the camera's horizon only), so a roof edge is
 * never coloured from the sky behind it, and, with the scan's photo-textured extraction (`tileGlbPath`), what its photo
 * does not truly see (true-view-gate.ts), so a surface is coloured only from a photo of that surface.
 *
 * Colour order (user decision, 2026-11-03, "colour from true views"): a station that truly sees the surface; else the
 * scan's own photo texture of it (the tiles' view of that era's structure, `tile-texture`); else a generated fill
 * (`generated`). The scan's structure is kept either way: a photo that sees through it (a newer era) is not used there.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { HeadlessMeshSilhouetteRenderer } from './HeadlessMeshSilhouetteRenderer';
import type { SurveyStationRenderService } from './SurveyStationRenderService';
import { buildScanHulls, keptByHulls, ContainmentReason } from './splat-containment';
import { glbRaycaster } from './street-view-stations';
import { buildValidMask, readGlbScene, sceneToRenderMesh, segmentSky } from './StreetViewPoseRegistrar';
import { trueViewMask, type TrueViewReport } from './true-view-gate';
import { readTileTriangles, type TileTriangles } from '../3d-engine/staged-location/tile-texture-transfer';
import { linearToSrgb255 } from '../../common/spatial/photogrammetric-delight';
import { dilateMask } from '../3d-engine/staged-location/streetview-ownership';
import { decodePng, resampleRgba } from '../texture-processing';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import { buildNativeIfStale } from '../3d-engine/native-build';
import { repoPath } from '../process/repo-python';

const execFileAsync = promisify(execFile);

/** Default splat budget: what the viewer draws and sorts at an interactive rate (the first 7th Ave world was 3.8 M). */
export const SURFACE_SPLAT_BUDGET = 4_000_000;
/** Spacing near the walk: k radians times the distance to it (about 2 px at 1920 wide, 70 degrees), from sMin to sMax. */
export const SURFACE_SPACING = { k: 0.0025, sMinM: 0.04, sMaxM: 0.25 };
/** A surface no station sees: closed at this spacing within this distance of the walk, left out beyond it. */
export const SURFACE_UNSEEN = { spacingM: 1.0, maxDistM: 40 };
/** A lump outside every hull up to this tall (a car, a van, a delivery truck) is laid on the street; taller, it is dropped. */
const LUMP_MAX_RISE_M = 4;
/** The station depth used for the occlusion test is rendered at this fraction of the image's size. */
const DEPTH_SCALE = 0.25;
/**
 * A station's sky is grown by this many pixels before the builder reads it: a sample's colour is read over a footprint
 * around its pixel, and at a roofline 50 m from a 7th Ave station (fx about 2,700 px) that reaches about 3 px.
 */
const SKY_GROW_PX = 4;

/**
 * A station's sky: what segmentSky reads as sky in its photo, above the station camera's horizon only, grown by
 * SKY_GROW_PX. Sky shows only above the horizon, and a roof edge seen against it stands above it too, while what the
 * segmenter takes for sky below it is pale pavement or a storefront (7th Ave, 2026-11-02: strips of pavement in 4 of 33
 * station photos; an overhead station's pale roofs all lie below its horizon).
 */
function stationSky(rgba: Uint8Array | Buffer, W: number, H: number, cam: { fx: number; fy: number; cx: number; cy: number; right: number[]; up: number[]; forward: number[] }): Uint8Array {
    const sky = segmentSky(rgba, W, H, buildValidMask(W, H, { watermarkBottomPx: 0 }));
    for (let y = 0; y < H; y++) {
        const rowUp = cam.forward[1] - cam.up[1] * (y - cam.cy) / cam.fy;
        for (let x = 0; x < W; x++) if (sky[y * W + x] && rowUp + cam.right[1] * (x - cam.cx) / cam.fx <= 0) sky[y * W + x] = 0;
    }
    return dilateMask(sky, W, H, SKY_GROW_PX);
}

export interface SurfaceLayerStation {
    /** The station as baked (its aligned pose): its depth is rendered from it. */
    station: ColmapCameraPose;
    /** The accepted station image. */
    imagePath: string;
    /** The camera the image was baked with (station_to_splats' pose.json: fx, fy, cx, cy, eye, right, up, forward). */
    posePath: string;
    /** Weight of its views against the others' (a street station's real photograph wins ties). */
    priority: number;
    /**
     * Why its picture is not used, when it is not (e.g. the image model redrew the view, so no single warp places it on
     * the photo it was asked for): its camera still says what the walk sees, and so how finely the scan is sampled there,
     * but it colours nothing.
     */
    refused?: string;
}

export interface SurfaceLayerRequest {
    glbPath: string;
    anchor: GeodeticAnchor;
    /** The renderer with the scan loaded (the pipeline's own). */
    renderer: SurveyStationRenderService;
    stations: SurfaceLayerStation[];
    /** The walk the viewer stands on: two ends in the scan frame (x, z) at eye height `eyeY`. */
    corridor: { a: [number, number]; b: [number, number]; eyeY: number };
    outSplat: string;
    outSpz: string;
    workDir: string;
    budget?: number;
    /** Mask each station's sky so no sample is coloured from it (default true; false reads every pixel, as before). */
    skyMask?: boolean;
    /**
     * The scan with its photo texture: the textured extraction of the same crawl (the same triangles as `glbPath`, in its
     * frame). With it each station colours only what it truly sees (true-view-gate.ts), and what no station truly sees
     * takes this texture; without it every station's view of the scan is used, as before.
     */
    tileGlbPath?: string;
    /** Where to write each splat's colour source (one byte per splat, in the splat file's order: SURFACE_SOURCES). */
    outProvenance?: string;
    signal?: AbortSignal;
}

/** A splat's colour source, as the provenance file stores it: a station that truly sees it, the scan's texture, a fill. */
export const SURFACE_SOURCES = ['true-view', 'tile-texture', 'generated'] as const;

export interface SurfaceLayerReport {
    triangles: number;
    keptTriangles: number;
    /** Kept triangles with a vertex laid on the street (LUMP_MAX_RISE_M). */
    flattenedTriangles: number;
    invisibleTriangles: number;
    /** Unseen triangles left out (further than SURFACE_UNSEEN.maxDistM from the walk). */
    skippedTriangles: number;
    splats: number;
    observed: number;
    relaxed: number;
    unobserved: number;
    spacingScale: number;
    spzBytes: number;
    /** Patches (one station each), patches whose station the smoothing changed, splats their patch's station could not see. */
    patches: number;
    relabelled: number;
    fallback: number;
    /**
     * The stations' colour agreement on the patches two of them see face on (scratchbox_surface_splats.hpp): shared
     * patches and the same-content ones among them, the median difference of all (natural log, linear light), the
     * same-content ones' mean difference as read, after the gains and after the offset field, how much one gain per
     * station leaves unexplained, and which corrections were applied.
     */
    seams: { pairs: number; inliers: number; medianAll: number; before: number; afterGain: number; after: number; gainResidual: number; gainsAtBound: number; gainsKept: boolean; fieldKept: boolean };
    /** Per station, per channel (r, g, b); all 1 when no gain was applied. */
    gains: number[][];
    /** Per station, the share of its image masked as sky (above its horizon, grown); 0 when the sky is not masked. */
    skyShares: number[];
    /** Per station, what the true-view gate found (absent without `tileGlbPath`). */
    trueViews?: TrueViewReport[];
    /**
     * Splats and patches by colour source (SURFACE_SOURCES order: a true view, the tile texture, generated), the generated
     * splats on a flattened lump and with no texture, and the tile texture's tone curve toward the stations: its median
     * gain per channel (linear; all 1 when no curve was fitted) and the paired samples and stations it was fitted on.
     */
    sources: { trueView: number; tileTexture: number; generated: number; generatedMoved: number; generatedUntextured: number; patches: { trueView: number; tileTexture: number; generated: number }; tileGain: number[]; tileGainSamples: number; tileToneStations: number };
    /** Per station, the patches it colours (by most of their splats). */
    stationPatches: number[];
    ms: number;
}

/** Builds the surface splat layer into `outSplat` and `outSpz`; the work files are removed whatever happens. */
export async function buildSurfaceSplatLayer(req: SurfaceLayerRequest): Promise<SurfaceLayerReport> {
    await fs.ensureDir(req.workDir);
    try {
        // the scan's triangles the hulls keep: the textured extraction's own when given (each with its UVs and texture),
        // else the clay mesh's
        const tile: TileTriangles | undefined = req.tileGlbPath ? readTileTriangles(await fs.readFile(req.tileGlbPath)) : undefined;
        let v: ArrayLike<number>, idx: ArrayLike<number>;
        if (tile) { v = tile.positions; idx = Uint32Array.from({ length: tile.texture.length * 3 }, (_, i) => i); }
        else { const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(req.glbPath); v = mesh.vertices; idx = mesh.indices; }
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < v.length; i += 3) { minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]); minZ = Math.min(minZ, v[i + 2]); maxZ = Math.max(maxZ, v[i + 2]); }
        const hulls = buildScanHulls(glbRaycaster(req.glbPath, { lat: req.anchor.lat, lng: req.anchor.lng, heightMeters: req.anchor.elevationMeters }), { minX, maxX, minZ, maxZ });
        const triCount = Math.floor(idx.length / 3);
        const kept = new Float32Array(triCount * 9);
        const keptUv = tile ? new Float32Array(triCount * 6) : undefined, keptTex = tile ? new Int32Array(triCount) : undefined, keptMoved = tile ? new Uint8Array(triCount) : undefined;
        let k = 0, flattenedTriangles = 0;
        const flat: number[] = [];
        for (let t = 0; t < triCount; t++) {
            const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
            // a lump outside every hull (a parked car, a van, a kiosk) stood up as a cone in front of the walk: its
            // vertices are laid on the street it stands on; taller, it is dropped. A triangle with any vertex laid down is
            // laid down whole, so a lump that meets a kept low structure lies flat instead of folding up from it as a
            // shard (7th Ave, 2026-11-03: the creased white shards beside the walk)
            flat.length = 0;
            let drop = false, lay = false;
            for (const o of [a, b, c]) {
                const why = hulls.classify(v[o], v[o + 1], v[o + 2]);
                if (why === ContainmentReason.InAir) {
                    const g = hulls.groundAt(v[o], v[o + 2]);
                    if (g === undefined || v[o + 1] - g > LUMP_MAX_RISE_M) { drop = true; break; }
                    lay = true;
                } else if (!keptByHulls(why)) { drop = true; break; }
            }
            if (drop) continue;
            for (const o of [a, b, c]) {
                const g = lay ? hulls.groundAt(v[o], v[o + 2]) : undefined;
                if (lay && g === undefined) { drop = true; break; }
                flat.push(v[o], g ?? v[o + 1], v[o + 2]);
            }
            if (drop) continue;
            const moved = flat[1] !== v[a + 1] || flat[4] !== v[b + 1] || flat[7] !== v[c + 1];
            if (moved) flattenedTriangles++;
            if (tile) {
                const kt = k / 9;
                keptUv!.set(tile.uvs.subarray(t * 6, t * 6 + 6), kt * 6);
                keptTex![kt] = tile.texture[t];
                keptMoved![kt] = moved ? 1 : 0;
            }
            for (const x of flat) kept[k++] = x;
        }
        const keptTriangles = k / 9;
        const trisPath = path.join(req.workDir, 'tris.f32');
        await fs.writeFile(trisPath, Buffer.from(kept.buffer, 0, k * 4));
        const tileLines: string[] = [];
        if (tile) {
            const uvPath = path.join(req.workDir, 'tile.uv.f32'), texPath = path.join(req.workDir, 'tile.tex.i32'), movedPath = path.join(req.workDir, 'tile.moved.u8');
            await fs.writeFile(uvPath, Buffer.from(keptUv!.buffer, 0, keptTriangles * 6 * 4));
            await fs.writeFile(texPath, Buffer.from(keptTex!.buffer, 0, keptTriangles * 4));
            await fs.writeFile(movedPath, Buffer.from(keptMoved!.buffer, 0, keptTriangles));
            tileLines.push(`tile ${uvPath} ${texPath} ${movedPath}`);
            for (const [ti, tx] of tile.textures.entries()) {
                const rgb = Buffer.alloc(tx.width * tx.height * 3);
                for (let p = 0; p < rgb.length; p++) rgb[p] = linearToSrgb255(tx.linear[p]);
                const tp = path.join(req.workDir, `tile${ti}.rgb`);
                await fs.writeFile(tp, rgb);
                tileLines.push(`texture ${tp} ${tx.width} ${tx.height}`);
            }
        }
        // the gate's depth: the same scan, as the registration renders it; the textured tiles must be its own crawl (the
        // stations' depth, the hulls and the splats' texture are then one surface)
        const gateMesh = tile ? sceneToRenderMesh(readGlbScene(req.glbPath)) : undefined;
        if (tile && gateMesh!.indices.length / 3 !== tile.texture.length) {
            throw new Error(`the photo-textured tiles ${req.tileGlbPath} (${tile.texture.length} triangles) are not the crawl of the scan ${req.glbPath} (${gateMesh!.indices.length / 3}): extract both at the same place and radius`);
        }

        // each station: its image at its baked camera's size, its depth for the occlusion test, and its mask (its sky,
        // and what its photo does not truly see)
        const lines: string[] = [];
        const skyShares: number[] = [];
        const trueViews: TrueViewReport[] = [];
        for (const [i, s] of req.stations.entries()) {
            if (req.signal?.aborted) throw req.signal.reason ?? new Error('stopped');
            const pose = await fs.readJson(s.posePath) as { fx: number; fy: number; cx: number; cy: number; eye: number[]; right: number[]; up: number[]; forward: number[] };
            const W = Math.round(pose.cx * 2), H = Math.round(pose.cy * 2);
            const img = decodePng(await fs.readFile(s.imagePath));
            const rgba = img.width === W && img.height === H ? img.rgba : resampleRgba(img.rgba, img.width, img.height, W, H);
            const rgb = Buffer.alloc(W * H * 3);
            for (let p = 0; p < W * H; p++) { rgb[p * 3] = rgba[p * 4]; rgb[p * 3 + 1] = rgba[p * 4 + 1]; rgb[p * 3 + 2] = rgba[p * 4 + 2]; }
            const rgbPath = path.join(req.workDir, `s${i}.rgb`), depthPath = path.join(req.workDir, `s${i}.depth.f32`);
            await fs.writeFile(rgbPath, rgb);
            const DW = Math.max(16, Math.round(W * DEPTH_SCALE)), DH = Math.max(16, Math.round(H * DEPTH_SCALE));
            const d = req.renderer.renderStationBlockout(s.station, { width: DW, height: DH });
            await fs.writeFile(depthPath, Buffer.from(d.depth.buffer, d.depth.byteOffset, d.depth.byteLength));
            const f = (xs: number[]) => xs.map(x => x.toFixed(6)).join(' ');
            lines.push(`station ${rgbPath} ${W} ${H} ${pose.fx} ${pose.fy} ${pose.cx} ${pose.cy} ${f(pose.eye)} ${f(pose.right)} ${f(pose.up)} ${f(pose.forward)} ${depthPath} ${DW} ${DH} ${d.intrinsics.fx} ${d.intrinsics.fy} ${d.intrinsics.cx} ${d.intrinsics.cy} ${s.priority}`);
            const sky = req.skyMask === false ? undefined : stationSky(rgba, W, H, pose);
            let skyPx = 0;
            if (sky) for (let p = 0; p < sky.length; p++) skyPx += sky[p];
            skyShares.push(sky ? skyPx / sky.length : 0);
            let mask = sky;
            if (s.refused) {
                mask = new Uint8Array(W * H).fill(1);
                if (tile) trueViews.push({ blocks: 0, passed: 0, refused: { tooSmall: 0, disagree: 0, atLimit: 0 }, seenShare: 0, medianNcc: null, medianShiftM: null, width: W, height: H, ms: 0, pictureRefused: s.refused });
            } else if (tile) {
                const gate = trueViewMask({ photo: rgba, width: W, height: H, camera: pose, tile, mesh: gateMesh!, ...(sky ? { sky } : {}) });
                trueViews.push(gate.report);
                mask = new Uint8Array(W * H);
                for (let p = 0; p < mask.length; p++) mask[p] = (sky && sky[p]) || !gate.seen[p] ? 1 : 0;
            }
            if (!mask) continue;
            const maskPath = path.join(req.workDir, `s${i}.mask.u8`);
            await fs.writeFile(maskPath, mask);
            lines.push(`mask ${maskPath}`);
        }

        const c = req.corridor;
        const manifest = [
            `triangles ${trisPath} ${keptTriangles}`,
            `corridor ${c.a[0]} ${c.eyeY} ${c.a[1]} ${c.b[0]} ${c.eyeY} ${c.b[1]}`,
            `spacing ${SURFACE_SPACING.k} ${SURFACE_SPACING.sMinM} ${SURFACE_SPACING.sMaxM} ${req.budget ?? SURFACE_SPLAT_BUDGET}`,
            'incidence 0.26 0.05',
            `unseen ${SURFACE_UNSEEN.spacingM} ${SURFACE_UNSEEN.maxDistM}`,
            ...lines,
            ...tileLines,
            ...(req.outProvenance ? [`provenance ${req.outProvenance}`] : []),
            `out ${req.outSplat} ${req.outSpz}`
        ].join('\n');
        const manifestPath = path.join(req.workDir, 'manifest.txt');
        await fs.writeFile(manifestPath, manifest);

        const binary = await buildNativeIfStale({
            source: repoPath('scripts', 'mesh_to_surface_splats.cpp'), binary: repoPath('build', 'mesh_to_surface_splats'),
            includeDir: new NativeCppCompilerService().getSdkIncludePath(), libs: ['-lz']
        });
        const { stdout } = await execFileAsync(binary, [manifestPath], { maxBuffer: 16 * 1024 * 1024, ...(req.signal ? { signal: req.signal } : {}) });
        const out = JSON.parse(stdout.trim().split('\n').pop()!) as Omit<SurfaceLayerReport, 'keptTriangles' | 'flattenedTriangles' | 'skyShares' | 'trueViews'>;
        return { ...out, triangles: triCount, keptTriangles, flattenedTriangles, skyShares, ...(tile ? { trueViews } : {}) };
    } finally {
        await fs.remove(req.workDir).catch(() => undefined);
    }
}
