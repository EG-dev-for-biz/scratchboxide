/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';

export interface ExecFileAsyncOptions {
    /** Aborting it kills the child (the promise rejects with an AbortError). */
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBuffer?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/**
 * Runs a binary with an argument list (no shell) without blocking the event loop, and resolves with its raw stdout.
 * Rejects with the child's error (carrying `stderr` as a string) on a non-zero exit, timeout or abort.
 */
export function execFileBuffer(file: string, args: string[], options: ExecFileAsyncOptions = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            {
                encoding: 'buffer',
                maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
                timeout: options.timeoutMs ?? 0,
                cwd: options.cwd,
                env: options.env,
                ...(options.signal ? { signal: options.signal } : {})
            },
            (err, stdout, stderr) => {
                if (err) {
                    (err as any).stderr = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
                    reject(err);
                    return;
                }
                resolve(stdout);
            }
        );
    });
}
