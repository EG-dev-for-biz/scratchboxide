/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Learned image matching (DISK keypoints + LightGlue, kornia, Apache-2.0; tools/matching/learned_match.py) for Street View
 * registration: a photo against the tiles' texture rendered from its pose, and photos of different panoramas against each
 * other. On the 7th Ave drive (2026-11-09) it found 25-624 matches per photo/render pair where block matching found 0-8.
 *
 * The images are sent to the worker inline and never written to disk (Street View imagery is not stored).
 * The interpreter: SCRATCHBOX_MATCH_PYTHON, else SCRATCHBOX_PYTHON, else the project's .venv, with torch and kornia
 * importable (`pip install kornia`). The DISK and LightGlue weights are fetched by kornia on first use.
 */

import { getPythonWorkerPool } from '../process/persistent-python-worker';
import { repoPath, resolveRepoPython } from '../process/repo-python';

/** Pinhole intrinsics of an image, pixels: [fx, fy, cx, cy]. */
export type Intrinsics4 = [number, number, number, number];

export interface MatchImage { id: string; /** Encoded image (JPEG or PNG), kept in memory. */ bytes: Buffer }
export interface MatchPairRequest {
    a: string; b: string;
    /** Keep only matches that fit one essential matrix, given both images' intrinsics (two photos of one scene). */
    essential?: { fa: Intrinsics4; fb: Intrinsics4 };
}
export interface MatchPairResult { a: string; b: string; raw: number; pa: Array<[number, number]>; pb: Array<[number, number]>; score: number[] }

/** What the drive registration needs of a matcher (a second implementation can serve tests with known geometry). */
export interface LearnedMatcher {
    match(images: MatchImage[], pairs: MatchPairRequest[], opts?: { ignoreBottomPx?: number; maxKeypoints?: number }): Promise<MatchPairResult[]>;
}

export class LearnedMatcherUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'LearnedMatcherUnavailableError'; }
}

export class LearnedFeatureMatcherService implements LearnedMatcher {
    private readonly python: string;
    constructor(opts: { pythonExecutable?: string; timeoutMs?: number } = {}, private readonly sidecarPath = repoPath('tools', 'matching', 'learned_match.py')) {
        try {
            this.python = opts.pythonExecutable ?? resolveRepoPython({
                overrideVars: ['SCRATCHBOX_MATCH_PYTHON'],
                modules: ['numpy', 'torch', 'cv2', 'kornia'],
                purpose: 'learned image matching for Street View registration (tools/matching/learned_match.py)'
            });
        } catch (e) {
            throw new LearnedMatcherUnavailableError(e instanceof Error ? e.message : String(e));
        }
        this.timeoutMs = opts.timeoutMs ?? 300_000;
    }
    private readonly timeoutMs: number;

    async match(images: MatchImage[], pairs: MatchPairRequest[], opts: { ignoreBottomPx?: number; maxKeypoints?: number } = {}): Promise<MatchPairResult[]> {
        if (!pairs.length) return [];
        const pool = getPythonWorkerPool({
            pythonBinary: this.python,
            scriptPath: this.sidecarPath,
            label: 'the learned matching sidecar',
            env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE', PYTORCH_ENABLE_MPS_FALLBACK: '1' }
        });
        const request = {
            images: images.map(im => ({ id: im.id, b64: im.bytes.toString('base64') })),
            pairs, maxKeypoints: opts.maxKeypoints ?? 2048, ignoreBottomPx: opts.ignoreBottomPx ?? 0
        };
        const res = await pool.run({ stdin: JSON.stringify(request), timeoutMs: this.timeoutMs });
        const line = res.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
        const answer = line ? JSON.parse(line) as { error?: string; pairs?: MatchPairResult[] } : undefined;
        if (res.exitCode !== 0 || !answer || answer.error || !answer.pairs) {
            throw new Error(`the learned matching sidecar failed (exit ${res.exitCode}): ${answer?.error ?? res.stderr.trim().split('\n').slice(-6).join(' | ')}`);
        }
        return answer.pairs;
    }
}
