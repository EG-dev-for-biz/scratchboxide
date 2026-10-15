/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds a native CLI from one C++20 source once, across processes:
 *
 * - it is rebuilt only when it is missing or older than a file it was compiled from (clang's -MMD list, written next
 *   to the binary as <binary>.d), never because an unrelated header in the include directory changed;
 * - one process builds at a time (an exclusive <binary>.lock naming its pid, created with its content in one step so
 *   no process ever reads it half-written; a lock whose process is gone, or older than the build timeout, is taken
 *   over, and only the process that wrote a lock removes it); the others wait and use the binary it built;
 * - the binary and its dependency list are compiled to temp names and renamed into place, and temp files left by a
 *   process that died mid-build are removed;
 * - a failed build throws with the compiler's output; an older binary is never used instead.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

function mtimeMs(file: string): number {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

/** The prerequisites listed in a clang -MMD dependency file. */
export function readDepFile(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ');
    const colon = text.indexOf(': ');
    if (colon < 0) return [];
    return text.slice(colon + 2).split(/(?<!\\)\s+/).filter(Boolean).map(p => p.replace(/\\ /g, ' '));
}

/** Whether `binary` exists and is newer than every file its dependency list names. */
export function nativeBinaryIsFresh(binary: string): boolean {
    const depFile = `${binary}.d`;
    if (!fs.existsSync(binary) || !fs.existsSync(depFile)) return false;
    const binTime = fs.statSync(binary).mtimeMs;
    const deps = readDepFile(depFile);
    return deps.length > 0 && deps.every(d => mtimeMs(d) <= binTime);
}

function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A lock that cannot be read as a holder (corrupt, or from an older format) is taken over once it is this old. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

/**
 * Takes <binary>.lock, waiting for (or taking over from) another process; returns its release.
 *
 * The lock is a hard link to a temp file already holding { pid, at, token }, so it appears with its content or not at
 * all. Taking over a stale lock renames it aside and checks that what was moved is the holder judged stale (another
 * process may have replaced it meanwhile; then it is linked back). Release removes the lock only while it is still
 * this process's own.
 */
async function acquireLock(lock: string, timeoutMs: number): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const readLock = (file: string): string | undefined => {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return undefined;
        }
    };
    while (true) {
        const tmp = `${lock}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        try {
            fs.linkSync(tmp, lock);
            return () => {
                const text = readLock(lock);
                try {
                    if (text !== undefined && JSON.parse(text).token === token) fs.rmSync(lock, { force: true });
                } catch {
                    // not ours (unreadable): left alone
                }
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        } finally {
            fs.rmSync(tmp, { force: true });
        }
        const text = readLock(lock);
        if (text === undefined) continue; // released meanwhile
        let holder: { pid?: number; at?: number } | undefined;
        try {
            holder = JSON.parse(text);
        } catch {
            holder = undefined;
        }
        const age = Date.now() - (holder?.at ?? mtimeMs(lock));
        const stale = holder ? !processAlive(Number(holder.pid)) || age > timeoutMs : age > UNREADABLE_LOCK_GRACE_MS;
        if (stale) {
            const aside = `${lock}.stale-${token}`;
            try {
                fs.renameSync(lock, aside);
            } catch {
                continue; // someone else moved it
            }
            if (readLock(aside) !== text) {
                // not the lock judged stale: another process's fresh lock, put back unless a third one holds it now
                try {
                    fs.linkSync(aside, lock);
                } catch {
                    // the path is taken again: that holder keeps it
                }
            }
            fs.rmSync(aside, { force: true });
            continue;
        }
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for process ${holder?.pid ?? '(unknown)'} to build ${path.basename(lock, '.lock')}`);
        await sleep(250);
    }
}

/** Temp outputs of builds whose process is gone (a killed worker). */
function removeOrphanedTemps(binary: string): void {
    const dir = path.dirname(binary);
    const prefix = `${path.basename(binary)}.`;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const m = /\.(?:tmp|stale)-(\d+)[-.]/.exec(name.slice(prefix.length - 1));
        if (m && !processAlive(Number(m[1]))) fs.rmSync(path.join(dir, name), { force: true });
    }
}

function compile(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(process.env.CXX || 'clang++', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || stdout || err.message).slice(-4000)));
            else resolve();
        });
    });
}

/** Builds spec.binary when it is stale (see the file comment) and returns its path. */
export async function buildNativeIfStale(spec: NativeBuildSpec): Promise<string> {
    if (!fs.existsSync(spec.source)) throw new Error(`${path.basename(spec.binary)} source not found: ${spec.source}`);
    if (nativeBinaryIsFresh(spec.binary)) return spec.binary;
    const timeoutMs = spec.timeoutMs ?? 15 * 60_000;
    fs.mkdirSync(path.dirname(spec.binary), { recursive: true });
    const release = await acquireLock(`${spec.binary}.lock`, timeoutMs);
    try {
        // another process may have built it while this one waited
        if (nativeBinaryIsFresh(spec.binary)) return spec.binary;
        removeOrphanedTemps(spec.binary);
        const tag = `${process.pid}-${Date.now()}`;
        const tmpBin = `${spec.binary}.tmp-${tag}`;
        const tmpDep = `${spec.binary}.d.tmp-${tag}`;
        const args = ['-std=c++20', '-O3', ...(process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : []), ...(spec.flags ?? []),
            '-I', spec.includeDir, spec.source, '-o', tmpBin, '-MMD', '-MF', tmpDep, ...(spec.libs ?? [])];
        try {
            await compile(args, timeoutMs);
            fs.renameSync(tmpBin, spec.binary);
            fs.renameSync(tmpDep, `${spec.binary}.d`);
        } catch (err) {
            for (const f of [tmpBin, tmpDep]) fs.rmSync(f, { force: true });
            throw new Error(`could not build ${path.basename(spec.binary)}: ${(err as Error).message}`);
        }
        return spec.binary;
    } finally {
        release();
    }
}
