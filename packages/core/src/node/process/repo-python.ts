/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

let cachedRoot: string | undefined;

/**
 * The repository root: the nearest ancestor of this module (else of the working directory) holding package.json and
 * packages/core. Falls back to the working directory outside a checkout. The desktop server runs from desktop-app/,
 * so repo files (sidecar scripts, models, .venv) are resolved from here, not from process.cwd().
 */
export function repoRoot(): string {
    if (cachedRoot) return cachedRoot;
    for (const start of [__dirname, process.cwd()]) {
        let d = path.resolve(start);
        for (let i = 0; i < 12; i++) {
            if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'packages', 'core'))) {
                cachedRoot = d;
                return d;
            }
            const up = path.dirname(d);
            if (up === d) break;
            d = up;
        }
    }
    return process.cwd();
}

/** A path inside the repository (see repoRoot). */
export function repoPath(...parts: string[]): string {
    return path.join(repoRoot(), ...parts);
}

/**
 * The Python that runs the repo's local model sidecars (depth, MediaPipe pose, segmentation): the first of the given
 * environment variables that is set, else the repo's `.venv/bin/python` (it carries torch, transformers, mediapipe
 * and opencv), else `python3` on PATH. A missing dependency then fails the sidecar with its own error.
 */
export function resolveRepoPython(...envVars: string[]): string {
    for (const name of envVars) {
        const v = (process.env[name] || '').trim();
        if (v) return v;
    }
    const venv = repoPath('.venv', 'bin', 'python');
    return fs.existsSync(venv) ? venv : 'python3';
}
