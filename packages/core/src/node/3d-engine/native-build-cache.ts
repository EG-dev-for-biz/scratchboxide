/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The one native build cache every C++ service compiles through.
 *
 * - A build is keyed on content: the translation unit's text, the text of every header it includes (followed
 *   recursively through quoted and angle includes and __has_include, resolved like the compiler resolves them:
 *   the including file's directory, then the source directory, then each -I directory; system headers are covered
 *   by the compiler identity), the flags, the libraries, the compiler's `--version` output, the platform and, for
 *   -march=native, the host CPU. Never mtimes: touching a file does not rebuild, and restoring an older file does.
 * - Each key has its own entry directory (`<root>/<key>/bin`), so builds of different sources never share a file.
 *   A binary is compiled to a temp name and renamed into place; an entry is never rewritten once present.
 * - The root is shared by every process (`SCRATCHBOX_NATIVE_BUILD_CACHE`, default `<tmpdir>/scratchbox-native-build-cache`).
 *   One process compiles a key at a time (an exclusive lock file); the others wait and use what it built; within a
 *   process concurrent requests for one key share one build.
 * - Header hashes are memoised by (inode, size, mtime, ctime), so a warm key costs one stat per header.
 * - A failed compile throws (NativeBuildError) with the compiler's output; nothing older is used instead.
 */

import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const KEY_FORMAT = 'scratchbox-native-build-v1';
const ENTRY_BINARY = 'bin';

/** The binary of a cache entry. */
export function nativeBuildEntryBinary(cacheRoot: string, key: string): string {
    return path.join(cacheRoot, key, ENTRY_BINARY);
}

export class NativeBuildError extends Error {
    constructor(message: string, readonly compilerOutput: string) {
        super(message);
        this.name = 'NativeBuildError';
    }
}

export interface NativeCompileSpec {
    /** Path of the translation unit. Give this or sourceCode. */
    sourcePath?: string;
    /** Text of the translation unit; written to a private temp file only when it has to be compiled. */
    sourceCode?: string;
    /** Directory quoted includes of sourceCode resolve against (the directory it would have been written to). */
    sourceDir?: string;
    /** -I directories, in order. */
    includeDirs: string[];
    /** Compiler flags before the source, in order (see defaultNativeFlags). */
    flags: string[];
    /** Linker inputs after the source (e.g. -lz). */
    libs?: string[];
    /** A precompiled header to include (-include-pch). It changes how fast, not what, is compiled. */
    pchPath?: string;
    /** What is being built (for messages; the cache entry is named by the key alone). */
    name: string;
    /** Compiler command, possibly with launcher words ("ccache clang++"); default $CXX or clang++. */
    compiler?: string;
    /** Longest a compile (and a wait for another process's compile) may take (default 15 min). */
    timeoutMs?: number;
    /** Cache root (default nativeBuildCacheRoot()). */
    cacheRoot?: string;
}

export interface NativeCompileResult {
    binaryPath: string;
    key: string;
    cacheHit: boolean;
    compileMs: number;
    compilerOutput: string;
}

/** -std=c++20 -O3, plus -march=native only when SCRATCHBOX_NATIVE_ARCH=1 (AGENTS.md: avoids SIGILL on other hosts). */
export function defaultNativeFlags(extra: string[] = []): string[] {
    return ['-std=c++20', '-O3', ...(process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : []), ...extra];
}

export function nativeBuildCacheRoot(): string {
    return path.resolve(process.env.SCRATCHBOX_NATIVE_BUILD_CACHE || path.join(os.tmpdir(), 'scratchbox-native-build-cache'));
}

function compilerArgv(compiler?: string): string[] {
    const words = (compiler || process.env.CXX || 'clang++').trim().split(/\s+/).filter(Boolean);
    return words.length ? words : ['clang++'];
}

const compilerIdentities = new Map<string, string>();

/** The compiler's `--version` output (memoised per command). Throws when the compiler cannot be run. */
export function compilerIdentity(compiler?: string): string {
    const argv = compilerArgv(compiler);
    const id = argv.join(' ');
    let identity = compilerIdentities.get(id);
    if (identity === undefined) {
        try {
            identity = execFileSync(argv[0], [...argv.slice(1), '--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            throw new NativeBuildError(`cannot run the C++ compiler "${id}": ${(err as Error).message}`, '');
        }
        compilerIdentities.set(id, identity);
    }
    return identity;
}

interface IncludeRef { quoted: boolean; name: string }
interface FileMemo { sig: string; hash: string; includes: IncludeRef[] }
const fileMemo = new Map<string, FileMemo>();

const INCLUDE_RE = /^[ \t]*#[ \t]*include(?:_next)?[ \t]*([<"])([^>"\n]+)[>"]|__has_include(?:_next)?[ \t]*\([ \t]*([<"])([^>"\n]+)[>"]/gm;

function scanIncludes(text: string): IncludeRef[] {
    const refs: IncludeRef[] = [];
    for (const m of Array.from(text.matchAll(INCLUDE_RE))) {
        const delim = m[1] ?? m[3];
        refs.push({ quoted: delim === '"', name: (m[2] ?? m[4]).trim() });
    }
    return refs;
}

function statSig(st: fs.Stats): string {
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

/** Content hash and include list of a file, recomputed only when its (inode, size, mtime, ctime) changes. */
function fileInfo(file: string, st: fs.Stats): FileMemo {
    const sig = statSig(st);
    const memo = fileMemo.get(file);
    if (memo && memo.sig === sig) return memo;
    const bytes = fs.readFileSync(file);
    const fresh: FileMemo = { sig, hash: crypto.createHash('sha256').update(bytes).digest('hex'), includes: scanIncludes(bytes.toString('utf8')) };
    fileMemo.set(file, fresh);
    return fresh;
}

/** The content hash of a file, memoised by (inode, size, mtime, ctime). */
export function hashFileMemo(file: string): string {
    return fileInfo(file, fs.statSync(file)).hash;
}

function statFile(file: string): fs.Stats | undefined {
    try {
        const st = fs.statSync(file);
        return st.isFile() ? st : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Hashes `rootText` (or rootFile's content) and the content of everything it includes, recursively. The hash covers
 * how each include was spelled and what it resolved to, so adding a header that shadows another changes it.
 * Returns the hash and the header files it covers.
 */
export function hashIncludeClosure(root: { file?: string; text?: string; dir?: string }, includeDirs: string[]): { hash: string; files: string[] } {
    const hasher = crypto.createHash('sha256');
    const seen = new Set<string>();
    const files: string[] = [];
    const visit = (refs: IncludeRef[], fromDir: string | undefined) => {
        for (const ref of refs) {
            const candidates = [
                ...(ref.quoted && fromDir ? [fromDir] : []),
                ...(ref.quoted && root.dir && root.dir !== fromDir ? [root.dir] : []),
                ...includeDirs
            ].map(d => path.resolve(d, ref.name));
            let resolved: string | undefined;
            let st: fs.Stats | undefined;
            for (const c of candidates) {
                st = statFile(c);
                if (st) { resolved = c; break; }
            }
            if (!resolved || !st) {
                // A system header (covered by the compiler identity) or a missing one (the compile fails).
                hasher.update(`?${ref.quoted ? '"' : '<'}${ref.name}\n`);
                continue;
            }
            const info = fileInfo(resolved, st);
            hasher.update(`${ref.quoted ? '"' : '<'}${ref.name}=${info.hash}\n`);
            if (seen.has(resolved)) continue;
            seen.add(resolved);
            files.push(resolved);
            visit(info.includes, path.dirname(resolved));
        }
    };
    let rootRefs: IncludeRef[];
    if (root.file) {
        const st = fs.statSync(root.file);
        const info = fileInfo(root.file, st);
        hasher.update(`root=${info.hash}\n`);
        rootRefs = info.includes;
        visit(rootRefs, path.dirname(root.file));
    } else {
        const text = root.text ?? '';
        hasher.update(`root=${crypto.createHash('sha256').update(text).digest('hex')}\n`);
        visit(scanIncludes(text), root.dir);
    }
    return { hash: hasher.digest('hex'), files };
}

/** The cache key of a build (see the file comment) and the headers it covers. */
export function nativeBuildKey(spec: NativeCompileSpec): { key: string; files: string[] } {
    if (Boolean(spec.sourcePath) === (spec.sourceCode !== undefined)) {
        throw new NativeBuildError('a native build needs exactly one of sourcePath and sourceCode', '');
    }
    if (spec.sourcePath && !statFile(spec.sourcePath)) {
        throw new NativeBuildError(`${spec.name} source not found: ${spec.sourcePath}`, '');
    }
    const closure = hashIncludeClosure(
        spec.sourcePath ? { file: spec.sourcePath } : { text: spec.sourceCode, dir: spec.sourceDir },
        spec.includeDirs
    );
    const flags = spec.flags;
    const hasher = crypto.createHash('sha256')
        .update(`${KEY_FORMAT}\n`)
        .update(`${process.platform}/${process.arch}\n`)
        .update(`compiler=${compilerIdentity(spec.compiler)}\n`)
        .update(`flags=${JSON.stringify(flags)}\n`)
        .update(`libs=${JSON.stringify(spec.libs ?? [])}\n`)
        .update(`pch=${spec.pchPath ? 'yes' : 'no'}\n`)
        .update(`sources=${closure.hash}\n`);
    if (flags.some(f => f.startsWith('-march=native') || f.startsWith('-mcpu=native') || f.startsWith('-mtune=native'))) {
        hasher.update(`cpu=${os.cpus()[0]?.model ?? 'unknown'}\n`);
    }
    return { key: hasher.digest('hex').slice(0, 40), files: closure.files };
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

function mtimeMs(file: string): number {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A lock that cannot be read as a holder (corrupt, or from an older format) is taken over once it is this old. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

/**
 * Takes an exclusive lock file, waiting for (or taking over from) another process; returns its release.
 *
 * The lock is a hard link to a temp file already holding { pid, at, token }, so it appears with its content or not at
 * all. Taking over a stale lock (its process gone, or older than timeoutMs) renames it aside and checks that what was
 * moved is the holder judged stale (another process may have replaced it meanwhile; then it is linked back). Release
 * removes the lock only while it is still this process's own.
 */
export async function acquireBuildLock(lock: string, timeoutMs: number): Promise<() => void> {
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
        if (Date.now() > deadline) throw new NativeBuildError(`timed out after ${timeoutMs} ms waiting for process ${holder?.pid ?? '(unknown)'} to build ${path.basename(lock, '.lock')}`, '');
        await sleep(250);
    }
}

/** Temp outputs (`<name>.tmp-<pid>-...` / `<name>.stale-<pid>-...`) of builds whose process is gone. */
export function removeOrphanedTemps(file: string): void {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const m = /\.(?:tmp|stale)-(\d+)[-.]/.exec(name.slice(prefix.length - 1));
        if (m && !processAlive(Number(m[1]))) fs.rmSync(path.join(dir, name), { force: true });
    }
}

function runCompiler(argv: string[], args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(argv[0], [...argv.slice(1), ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            const output = `${String(stderr || '')}${stdout ? `\n${String(stdout)}` : ''}`.trim();
            if (err) reject(new NativeBuildError(output || err.message, output || err.message));
            else resolve(output);
        });
    });
}

const inFlight = new Map<string, Promise<NativeCompileResult>>();

/** Returns the cached binary for spec, compiling it first when no process has yet (see the file comment). */
export async function compileNativeCached(spec: NativeCompileSpec): Promise<NativeCompileResult> {
    const started = Date.now();
    const { key } = nativeBuildKey(spec);
    const entryDir = path.join(spec.cacheRoot ?? nativeBuildCacheRoot(), key);
    // The entry's binary is named by the key alone: builds that differ only in the name they ask for share it.
    const binaryPath = nativeBuildEntryBinary(path.dirname(entryDir), key);
    if (statFile(binaryPath)) {
        return { binaryPath, key, cacheHit: true, compileMs: Date.now() - started, compilerOutput: '' };
    }
    const pending = inFlight.get(binaryPath);
    if (pending) return pending;
    const build = (async (): Promise<NativeCompileResult> => {
        const timeoutMs = spec.timeoutMs ?? 15 * 60_000;
        fs.mkdirSync(entryDir, { recursive: true });
        const release = await acquireBuildLock(`${binaryPath}.lock`, timeoutMs);
        try {
            // another process may have built it while this one waited
            if (statFile(binaryPath)) {
                return { binaryPath, key, cacheHit: true, compileMs: Date.now() - started, compilerOutput: '' };
            }
            removeOrphanedTemps(binaryPath);
            const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            const tmpBin = `${binaryPath}.tmp-${tag}`;
            const tmpSrc = spec.sourceCode !== undefined ? `${binaryPath}.tmp-${tag}.cpp` : undefined;
            if (tmpSrc) fs.writeFileSync(tmpSrc, spec.sourceCode!, 'utf8');
            const args = [
                ...spec.flags,
                // quoted includes of sourceCode still resolve against the directory it belongs to
                ...(tmpSrc && spec.sourceDir ? ['-iquote', spec.sourceDir] : []),
                ...spec.includeDirs.map(d => `-I${d}`),
                ...(spec.pchPath ? ['-include-pch', spec.pchPath] : []),
                '-o', tmpBin, tmpSrc ?? spec.sourcePath!,
                ...(spec.libs ?? [])
            ];
            const compileStart = Date.now();
            try {
                const output = await runCompiler(compilerArgv(spec.compiler), args, timeoutMs);
                fs.renameSync(tmpBin, binaryPath);
                return { binaryPath, key, cacheHit: false, compileMs: Date.now() - compileStart, compilerOutput: output };
            } catch (err) {
                fs.rmSync(tmpBin, { force: true });
                if (err instanceof NativeBuildError) {
                    throw new NativeBuildError(`could not build ${spec.name}: ${err.compilerOutput.slice(-4000)}`, err.compilerOutput);
                }
                throw err;
            } finally {
                if (tmpSrc) fs.rmSync(tmpSrc, { force: true });
            }
        } finally {
            release();
        }
    })();
    inFlight.set(binaryPath, build);
    try {
        return await build;
    } finally {
        inFlight.delete(binaryPath);
    }
}

/**
 * Puts the cached binary at `dest` (a hard link, or a copy across file systems), atomically: a process running
 * `dest` keeps the file it started. Does nothing when `dest` already is that binary.
 */
export function placeCachedBinary(cachedBinary: string, dest: string): void {
    const src = fs.statSync(cachedBinary);
    const cur = statFile(dest);
    if (cur && cur.ino === src.ino && cur.dev === src.dev) return;
    const stamp = `${dest}.buildkey`;
    const key = path.basename(path.dirname(cachedBinary));
    if (cur && cur.size === src.size && cur.dev !== src.dev && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    removeOrphanedTemps(dest);
    const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let copied = false;
    try {
        fs.linkSync(cachedBinary, tmp);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        fs.copyFileSync(cachedBinary, tmp);
        fs.chmodSync(tmp, 0o755);
        copied = true;
    }
    fs.renameSync(tmp, dest);
    if (copied) {
        const tmpStamp = `${stamp}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmpStamp, key);
        fs.renameSync(tmpStamp, stamp);
    }
}

/** Builds (through the cache) and places the binary at `binary`; returns `binary`. */
export async function buildNativeBinary(spec: Omit<NativeCompileSpec, 'name'> & { binary: string }): Promise<string> {
    const { binary, ...rest } = spec;
    const result = await compileNativeCached({ ...rest, name: path.basename(binary) });
    placeCachedBinary(result.binaryPath, binary);
    return binary;
}
