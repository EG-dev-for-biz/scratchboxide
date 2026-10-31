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
 * (the judge's region labels of the tile the world was built on: its splats lie on that scan).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { NativeCppCompilerService } from '../native-compiler-service';
import { buildNativeIfStale } from '../native-build';
import { repoPath } from '../../process/repo-python';
import { nearestLabelIndex, type TriangleSoup } from '../../spatial/triangle-surface-index';
import { PHOTO_MATCH_AMBIENT, PHOTO_MATCH_BACKGROUND, PHOTO_MATCH_CLAY, PHOTO_MATCH_NEAR_M, type ArmRender } from './photo-match-eval';

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
    /** Scratch folder for the manifest and the raw renders; removed afterwards. */
    workDir: string;
    signal?: AbortSignal;
}

/** Runs the native renderer on a manifest of `lines` written in `work`; its stdout. */
async function runSplatRender(lines: string[], work: string, signal?: AbortSignal): Promise<string> {
    const manifest = path.join(work, 'manifest.txt');
    fs.writeFileSync(manifest, lines.join('\n') + '\n');
    const binary = await buildNativeIfStale({
        source: repoPath('scripts', 'splat_render.cpp'), binary: repoPath('build', 'splat_render'),
        includeDir: new NativeCppCompilerService().getSdkIncludePath(), libs: ['-lz']
    });
    const { stdout } = await execFileAsync(binary, [manifest], { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return stdout;
}

function checkSplatFile(splatPath: string): void {
    if (!/\.(spz|splat)$/i.test(splatPath)) throw new Error(`a splat arm needs a .spz or .splat file, not ${path.basename(splatPath)}`);
    if (!fs.existsSync(splatPath)) throw new Error(`the splat file ${splatPath} does not exist`);
}

/** The splats' centres, x y z per splat in the file's order. */
export async function splatPositions(splatPath: string, workDir: string, signal?: AbortSignal): Promise<Float32Array> {
    checkSplatFile(splatPath);
    fs.mkdirSync(workDir, { recursive: true });
    try {
        const out = path.join(workDir, 'positions.f32');
        await runSplatRender([`splats ${splatPath}`, `positions ${out}`], workDir, signal);
        const b = fs.readFileSync(out);
        return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * One region label per splat: the label of the nearest triangle of `soup` within `maxDist` (point to triangle; `labels` one
 * for all or one per triangle), else `fallback`. Also how many splats took the fallback.
 */
export function labelSplats(positions: Float32Array, soup: TriangleSoup, labels: number | ArrayLike<number>, fallback: number, maxDist = 0.5): { labels: Uint8Array; fallback: number } {
    const nearest = nearestLabelIndex(soup, labels, maxDist);
    const out = new Uint8Array(positions.length / 3);
    let missed = 0;
    for (let i = 0; i < out.length; i++) {
        const l = nearest(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        if (l < 0) { out[i] = fallback; missed++; } else out[i] = l;
    }
    return { labels: out, fallback: missed };
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
