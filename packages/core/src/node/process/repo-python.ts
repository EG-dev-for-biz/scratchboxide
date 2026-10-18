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
    const venv = path.resolve(process.cwd(), '.venv/bin/python');
    return fs.existsSync(venv) ? venv : 'python3';
}
