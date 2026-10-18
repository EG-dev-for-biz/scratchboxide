/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds a native CLI from one C++20 source through the shared native build cache (native-build-cache.ts):
 *
 * - it is rebuilt only when the content of the source, of a header it includes (recursively), the flags or the
 *   compiler change, never because a file was touched or an unrelated header in the include directory changed;
 * - one process compiles a given build at a time; the others wait and use the binary it built, and processes and
 *   checkouts with the same sources share it;
 * - the binary is placed at spec.binary atomically (a hard link to the cache entry), and temp files left by a process
 *   that died mid-build are removed;
 * - a failed build throws with the compiler's output; an older binary is never used instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildNativeBinary, defaultNativeFlags, nativeBuildEntryBinary, nativeBuildKey, nativeBuildCacheRoot, NativeBuildError } from './native-build-cache';

export interface NativeBuildSpec {
    /** The C++ source (one translation unit). */
    source: string;
    /** Where the binary goes. */
    binary: string;
    /** Include directory passed with -I. */
    includeDir: string;
    /** Extra compiler flags (after -std=c++20 -O3; -march=native is added when SCRATCHBOX_NATIVE_ARCH=1). */
    flags?: string[];
    /** Linker flags after the source (e.g. -lz). */
    libs?: string[];
    /** Longest a build (and a wait for another process's build) may take (default 15 min). */
    timeoutMs?: number;
}

function cacheSpec(spec: NativeBuildSpec) {
    return {
        sourcePath: spec.source,
        includeDirs: [spec.includeDir],
        flags: defaultNativeFlags(spec.flags ?? []),
        libs: spec.libs,
        timeoutMs: spec.timeoutMs
    };
}

/** Whether `binary` is the cached build of spec's current sources (content-keyed; see the file comment). */
export function nativeBinaryIsFresh(spec: NativeBuildSpec): boolean {
    if (!fs.existsSync(spec.binary) || !fs.existsSync(spec.source)) return false;
    const { key } = nativeBuildKey({ ...cacheSpec(spec), name: path.basename(spec.binary) });
    const cached = nativeBuildEntryBinary(nativeBuildCacheRoot(), key);
    try {
        const a = fs.statSync(cached);
        const b = fs.statSync(spec.binary);
        return a.ino === b.ino && a.dev === b.dev;
    } catch {
        return false;
    }
}

/** Builds spec.binary when its sources changed (see the file comment) and returns its path. */
export async function buildNativeIfStale(spec: NativeBuildSpec): Promise<string> {
    if (!fs.existsSync(spec.source)) throw new Error(`${path.basename(spec.binary)} source not found: ${spec.source}`);
    try {
        return await buildNativeBinary({ ...cacheSpec(spec), binary: spec.binary });
    } catch (err) {
        if (err instanceof NativeBuildError) throw new Error(err.message);
        throw err;
    }
}
