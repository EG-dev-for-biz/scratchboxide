/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A splat world as a photo-match arm: renders a .spz or .splat (in the tile frame) from the judge's pinhole poses, in its
 * neutral light or its clay, as an ArmRender like renderTriangles' (photo-match-eval.ts), so a splat world is judged from
 * exactly the same poses and on the same bars as a mesh build. The native renderer (scripts/splat_render.cpp,
 * scratchbox_splat_raster.hpp) projects every splat as the app's viewer does (common/spatial/splat-ewa-projection.ts) and
 * composites them front to back; on the 7th Ave world (4 M splats) a 1280 x 800 view takes about 0.3 s, and its coverage
 * agrees with the viewer's own render at IoU 0.98 to 0.99.
 *
 * With labels (one region label per splat) each render also carries `regions`: per pixel, the label of the splat that takes
 * it past half coverage, `skyLabel` where none does. labelSplats gives each splat the label of the nearest labelled triangle
 * (the judge's region labels of the tile the world was built on: its splats lie on that scan); splatRegions adds the judge's
 * own rule from geometry for a splat no triangle is near.
 *
 * A splat world lies in the frame of the tile extraction it was built on; splatFrame reads that frame's origin from the
 * extraction's GLB (named in the world's tileset.meta.json), and splatOffset moves it onto another frame.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { LocalTangentPlane } from '../../../common/coordinate/LocalTangentPlane';
import { NativeCppCompilerService } from '../native-compiler-service';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../native-build-cache';
import { repoPath } from '../../process/repo-python';
import { nearestLabelIndex, type TriangleSoup } from '../../spatial/triangle-surface-index';
import {
    PHOTO_MATCH_AMBIENT, PHOTO_MATCH_BACKGROUND, PHOTO_MATCH_CLAY, PHOTO_MATCH_GROUND_BAND_M, PHOTO_MATCH_NEAR_M, REGION,
    type ArmRender, type TerrainLookup
} from './photo-match-eval';

const execFileAsync = promisify(execFile);

export interface SplatArmView {
    camera: PinholeCamera;
    /** Render in the judge's clay (one albedo, its key light and background) instead of its neutral light. */
    clay?: boolean;
}

export interface SplatArmRender extends ArmRender {
    /** With labels: per pixel the label of the splat that takes it past half coverage (`skyLabel` where none does). */
    regions?: Uint8Array;
}

export interface SplatArmOptions {
    /** One region label per splat, in the file's order. */
    labels?: Uint8Array;
    skyLabel?: number;
    /** Metres added to every splat's position as it loads (its frame onto the cameras', splatOffset). */
    offset?: readonly [number, number, number];
    /** Scratch folder for the manifest and the raw renders; removed afterwards. */
    workDir: string;
    signal?: AbortSignal;
}

/** Runs the native renderer on a manifest of `lines` written in `work`; its stdout. */
async function runSplatRender(lines: string[], work: string, signal?: AbortSignal): Promise<string> {
    const manifest = path.join(work, 'manifest.txt');
    fs.writeFileSync(manifest, lines.join('\n') + '\n');
    let binary: string;
    try {
        binary = (await compileNativeCached({
            sourcePath: repoPath('scripts', 'splat_render.cpp'), includeDirs: [new NativeCppCompilerService().getSdkIncludePath()],
            flags: defaultNativeFlags(), libs: ['-lz'], name: 'splat_render', timeoutMs: 300_000
        })).binaryPath;
    } catch (err) {
        throw new Error(`could not build splat_render: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
    }
    const { stdout } = await execFileAsync(binary, [manifest], { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return stdout;
}

function checkSplatFile(splatPath: string): void {
    if (!/\.(spz|splat)$/i.test(splatPath)) throw new Error(`a splat arm needs a .spz or .splat file, not ${path.basename(splatPath)}`);
    if (!fs.existsSync(splatPath)) throw new Error(`the splat file ${splatPath} does not exist`);
}

const offsetLine = (offset?: readonly number[]) => (offset && offset.some(v => v !== 0) ? [`offset ${offset.map(v => v.toFixed(6)).join(' ')}`] : []);

/** The splats' centres, x y z per splat in the file's order (moved by `offset`). */
export async function splatPositions(splatPath: string, workDir: string, signal?: AbortSignal, offset?: readonly [number, number, number]): Promise<Float32Array> {
    checkSplatFile(splatPath);
    fs.mkdirSync(workDir, { recursive: true });
    try {
        const out = path.join(workDir, 'positions.f32');
        await runSplatRender([`splats ${splatPath}`, ...offsetLine(offset), `positions ${out}`], workDir, signal);
        const b = fs.readFileSync(out);
        return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * One region label per splat: the label of the nearest triangle of `soup` within `maxDist` (point to triangle; `labels` one
 * for all or one per triangle), else `fallback` (one label, or one from the splat's position). Also how many splats took the
 * fallback.
 */
export function labelSplats(positions: Float32Array, soup: TriangleSoup, labels: number | ArrayLike<number>, fallback: number | ((x: number, y: number, z: number) => number), maxDist = 0.5): { labels: Uint8Array; fallback: number } {
    const nearest = nearestLabelIndex(soup, labels, maxDist);
    const out = new Uint8Array(positions.length / 3);
    let missed = 0;
    for (let i = 0; i < out.length; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        const l = nearest(x, y, z);
        if (l < 0) { out[i] = typeof fallback === 'number' ? fallback : fallback(x, y, z); missed++; } else out[i] = l;
    }
    return { labels: out, fallback: missed };
}

/** A splat world's labels and what they say about its frame. */
export interface SplatRegions {
    labels: Uint8Array;
    /** Splats per REGION label (sky never). */
    byLabel: { ground: number; neighbours: number; target: number; trees: number };
    /** Share of splats no triangle of the reference lay within `maxDist` of (labelled by the rule from geometry). */
    unmatchedShare: number;
    /** Median height (m) of the ground-labelled splats over the terrain under them: how far the world's street sits off the reference's. */
    groundGapM: number | null;
}

/**
 * The judge's region labels for a splat world (its splats in the reference frame): each splat the label of the nearest
 * labelled reference triangle within `maxDist`, else the judge's rule from geometry (triangleRegions on one point): ground
 * within PHOTO_MATCH_GROUND_BAND_M over the terrain under it, else `standing(x, z)`; off the terrain, `standing` too.
 */
export function splatRegions(positions: Float32Array, reference: TriangleSoup, referenceLabels: ArrayLike<number>, terrain: TerrainLookup, standing: (x: number, z: number) => number, maxDist = 0.5): SplatRegions {
    const byGeometry = (x: number, y: number, z: number) => {
        const g = terrain.groundAt(x, z);
        return g === g && y - g <= PHOTO_MATCH_GROUND_BAND_M ? REGION.ground : standing(x, z);
    };
    const { labels, fallback } = labelSplats(positions, reference, referenceLabels, byGeometry, maxDist);
    const byLabel = { ground: 0, neighbours: 0, target: 0, trees: 0 };
    const gaps: number[] = [];
    for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        if (l === REGION.ground) {
            byLabel.ground++;
            const g = terrain.groundAt(positions[i * 3], positions[i * 3 + 2]);
            if (g === g) gaps.push(positions[i * 3 + 1] - g);
        } else if (l === REGION.neighbours) byLabel.neighbours++;
        else if (l === REGION.target) byLabel.target++;
        else if (l === REGION.trees) byLabel.trees++;
    }
    gaps.sort((a, b) => a - b);
    return { labels, byLabel, unmatchedShare: labels.length ? fallback / labels.length : 0, groundGapM: gaps.length ? gaps[gaps.length >> 1] : null };
}

/** Where a splat world's frame sits on the Earth: its origin, ellipsoidal height. */
export interface SplatFrame { lat: number; lng: number; heightMeters: number; source: string }

/** The JSON chunk of a GLB (its first chunk): here only its top-level extras are read. */
function glbJsonOf(file: string): { extras?: { anchor?: { lat?: unknown; lng?: unknown; ellipsoidalHeightM?: unknown } } } {
    const b = fs.readFileSync(file);
    if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
    return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
}

/**
 * The frame of the splat world at `splatPath`: the origin of the tile extraction it was built on, read from that GLB's
 * extras (anchor.ellipsoidalHeightM), the GLB named by `glbPath` in the world's tileset.meta.json beside the file. The meta's
 * own anchor.elevationMeters is a height above sea level, not the frame's origin, so it is not used.
 */
export function splatFrame(splatPath: string): SplatFrame {
    const meta = path.join(path.dirname(splatPath), 'tileset.meta.json');
    if (!fs.existsSync(meta)) throw new Error(`no tileset.meta.json beside ${splatPath}: give the splat world's origin`);
    const glb = (JSON.parse(fs.readFileSync(meta, 'utf8')) as { glbPath?: unknown }).glbPath;
    if (typeof glb !== 'string' || !fs.existsSync(glb)) throw new Error(`${meta} names no tile extraction that exists (glbPath ${String(glb)}): give the splat world's origin`);
    const a = glbJsonOf(glb).extras?.anchor;
    const lat = a?.lat, lng = a?.lng, h = a?.ellipsoidalHeightM;
    if (typeof lat !== 'number' || typeof lng !== 'number' || typeof h !== 'number') {
        throw new Error(`${glb} records no frame anchor (extras.anchor with ellipsoidalHeightM): give the splat world's origin`);
    }
    return { lat, lng, heightMeters: h, source: `the extras of ${path.basename(glb)}, the tile extraction the world was built on` };
}

/**
 * The offset (m, x east, y up, z south) that moves a frame anchored at `from` onto the frame anchored at `to` (both origins
 * at ellipsoidal heights), and the angle (radians) between their up axes, which the offset leaves out.
 */
export function splatOffset(to: { lat: number; lng: number; heightMeters: number }, from: { lat: number; lng: number; heightMeters: number }): { offsetM: [number, number, number]; tiltRad: number } {
    const plane = new LocalTangentPlane({ lat: to.lat, lng: to.lng, alt: to.heightMeters });
    const [x, y, z] = plane.toLocal({ lat: from.lat, lng: from.lng, alt: from.heightMeters });
    const d2r = Math.PI / 180;
    const up = (p: { lat: number; lng: number }) => [Math.cos(p.lat * d2r) * Math.cos(p.lng * d2r), Math.cos(p.lat * d2r) * Math.sin(p.lng * d2r), Math.sin(p.lat * d2r)];
    const a = up(to), b = up(from);
    return { offsetM: [x, y, z], tiltRad: Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) };
}

/** Renders the splat file at `splatPath` from each of `views`; one ArmRender per view, in order. */
export async function renderSplatArm(splatPath: string, views: SplatArmView[], opts: SplatArmOptions): Promise<SplatArmRender[]> {
    checkSplatFile(splatPath);
    if (!views.length) return [];
    const work = opts.workDir;
    fs.mkdirSync(work, { recursive: true });
    try {
        const f = (v: ArrayLike<number>) => Array.from(v, x => Number(x).toFixed(6)).join(' ');
        const lines = [
            `splats ${splatPath}`,
            ...offsetLine(opts.offset),
            `light ${PHOTO_MATCH_AMBIENT} ${PHOTO_MATCH_BACKGROUND.join(' ')} ${PHOTO_MATCH_NEAR_M}`,
            `clay ${PHOTO_MATCH_CLAY.albedo.join(' ')} ${PHOTO_MATCH_CLAY.ambient} ${PHOTO_MATCH_CLAY.background.join(' ')}`
        ];
        if (opts.labels) {
            const labelsPath = path.join(work, 'labels.u8');
            fs.writeFileSync(labelsPath, opts.labels);
            lines.push(`labels ${labelsPath} ${opts.skyLabel ?? 0}`);
        }
        const prefixes = views.map((v, i) => {
            const c = v.camera, prefix = path.join(work, `v${i}`);
            lines.push(`view ${prefix} ${v.clay ? 'clay' : 'textured'} ${c.width} ${c.height} ${c.fx} ${c.fy} ${c.cx} ${c.cy} ${f(c.eye)} ${f(c.right)} ${f(c.up)} ${f(c.fwd)}`);
            return prefix;
        });
        const stdout = await runSplatRender(lines, work, opts.signal);
        const perView = stdout.trim().split('\n').slice(0, -1).map(l => JSON.parse(l) as { view: string; drawn: number; ms: number });
        return views.map((v, i) => {
            const { width, height } = v.camera, prefix = prefixes[i];
            const info = perView.find(x => x.view === prefix);
            const cov = fs.readFileSync(`${prefix}.cov`);
            return {
                width, height,
                rgba: new Uint8Array(fs.readFileSync(`${prefix}.rgba`)),
                coverage: new Float32Array(cov.buffer, cov.byteOffset, cov.byteLength / 4).slice(),
                ...(opts.labels ? { regions: new Uint8Array(fs.readFileSync(`${prefix}.reg`)) } : {}),
                triangles: info?.drawn ?? 0,
                ms: info?.ms ?? 0
            };
        });
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
