/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The described targets of the synthetic scenes (make_synthetic.py), shared by the replay tests and the live recorder. */

import * as fs from 'fs-extra';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { RecordedAnswer } from './replay-source';

export const FIXTURE_DIR = __dirname;
export const RECORDINGS = path.join(FIXTURE_DIR, 'recorded-answers.json');
export const PYTHON = process.env.SCRATCHBOX_PYTHON || path.resolve(FIXTURE_DIR, '../../../../../.venv/bin/python');
export const SHOTS = path.resolve(FIXTURE_DIR, '../../../../../test-results/screenshots/open_vocab_segment');

export interface DescribedCase {
    name: string;
    image: string;
    target: string;
    /** Ground-truth mask file (absent for a target that is not in the image). */
    gt?: string;
    /** A mask the result must not take (a neighbour). */
    avoid?: string;
}

export const DESCRIBED_CASES: DescribedCase[] = [
    { name: 'statue', image: 'statue.png', target: 'the statue standing on the plinth, plinth included', gt: 'statue_gt.png' },
    { name: 'urn', image: 'touching.png', target: 'the pale urn on the left (not the crate it touches)', gt: 'touching_gt_urn.png', avoid: 'touching_gt_crate.png' },
    { name: 'panel', image: 'occluded.png', target: 'the pale rectangular panel behind the dark vertical post (both visible halves, without the post)', gt: 'occluded_gt.png' }
];

export const NOT_FOUND_CASE = { name: 'absent', image: 'statue.png', target: 'the bicycle leaning against the wall' };
export const VIDEO_TARGET = 'the red object with a short mast';
export const VIDEO_FRAMES = 16;
export const VIDEO_FPS = 8;

export function loadRecordings(): RecordedAnswer[] {
    return fs.existsSync(RECORDINGS) ? fs.readJsonSync(RECORDINGS) : [];
}

export function makeScenes(dir: string): void {
    const r = spawnSync(PYTHON, ['-I', path.join(FIXTURE_DIR, 'make_synthetic.py'), dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`make_synthetic.py failed: ${r.stderr}`);
}

/** A lossless clip of the moving scene (PNG frames in MOV, rgb24), so decoded frames equal the source PNGs. */
export function makeClip(dir: string): string {
    const clip = path.join(dir, 'moving.mov');
    const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-framerate', String(VIDEO_FPS), '-i', path.join(dir, 'moving_%02d.png'), '-c:v', 'png', '-pix_fmt', 'rgb24', clip], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg could not make the clip: ${r.stderr}`);
    return clip;
}

/** IoU of two mask files (and the fraction of `b` covered by `a`), measured with OpenCV. */
export function maskIou(a: string, b: string): { iou: number; covered: number } {
    const r = spawnSync(PYTHON, ['-I', '-c', [
        'import sys, json, cv2',
        'a = cv2.imread(sys.argv[1], 0) > 127; b = cv2.imread(sys.argv[2], 0) > 127',
        'u = (a | b).sum(); print(json.dumps({"iou": float((a & b).sum() / u) if u else 1.0, "covered": float((a & b).sum() / max(1, b.sum()))}))'
    ].join('\n'), a, b], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`mask comparison failed: ${r.stderr}`);
    return JSON.parse(r.stdout.trim());
}

export interface OverlayPanel { mask: string; title: string; positive?: number[][]; negative?: number[][]; box?: number[]; gt?: string }

export function overlay(out: string, image: string, panels: OverlayPanel[]): string {
    fs.ensureDirSync(path.dirname(out));
    const spec = `${out}.panels.json`;
    fs.writeJsonSync(spec, panels);
    const r = spawnSync(PYTHON, ['-I', path.join(FIXTURE_DIR, 'overlay.py'), out, image, spec], { encoding: 'utf8' });
    fs.removeSync(spec);
    if (r.status !== 0) throw new Error(`overlay failed: ${r.stderr}`);
    return out;
}
