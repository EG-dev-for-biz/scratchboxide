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
 * - compileNativeCachedSync serves a caller that must stay synchronous: the same entry and lock, the thread blocked
 *   while it waits or compiles.
 * - Every lookup stamps its entry's last use (`<key>/last-used`). The cache is bounded (pruneNativeBuildCache): entries
 *   unused for longer than the age bound go, then the least recently used until the cache is within the size bound.
 *   An entry used within the idle grace, being built (its lock is present) or held in this process is never removed;
 *   removal renames the entry aside first and puts it back if it was used meanwhile. A process prunes after it
 *   compiles something, at most once an hour across processes (SCRATCHBOX_NATIVE_BUILD_CACHE_MAX_MB, default 4096,
 *   and SCRATCHBOX_NATIVE_BUILD_CACHE_MAX_AGE_DAYS, default 30).
 */

import { execFile, execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const KEY_FORMAT = 'scratchbox-native-build-v1';
const ENTRY_BINARY = 'bin';
const ENTRY_LAST_USED = 'last-used';

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
/** Blocks the thread (for a caller that must stay synchronous). */
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A lock that cannot be read as a holder (corrupt, or from an older format) is taken over once it is this old. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

function readLock(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * One try at the lock (acquireBuildLock): its release when taken; else how long to wait before the next try (0: at
 * once, the lock was just released or taken over). Throws once the deadline has passed.
 */
function tryBuildLock(lock: string, timeoutMs: number, deadline: number, token: string): (() => void) | number {
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
    if (text === undefined) return 0; // released meanwhile
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
            return 0; // someone else moved it
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
        return 0;
    }
    if (Date.now() > deadline) throw new NativeBuildError(`timed out after ${timeoutMs} ms waiting for process ${holder?.pid ?? '(unknown)'} to build ${path.basename(lock, '.lock')}`, '');
    return 250;
}

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
    while (true) {
        const r = tryBuildLock(lock, timeoutMs, deadline, token);
        if (typeof r === 'function') return r;
        if (r) await sleep(r);
    }
}

/** acquireBuildLock, blocking the thread while it waits. */
export function acquireBuildLockSync(lock: string, timeoutMs: number): () => void {
    const deadline = Date.now() + timeoutMs;
    const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    while (true) {
        const r = tryBuildLock(lock, timeoutMs, deadline, token);
        if (typeof r === 'function') return r;
        if (r) sleepSync(r);
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

function runCompilerSync(argv: string[], args: string[], timeoutMs: number): string {
    const r = spawnSync(argv[0], [...argv.slice(1), ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
    const output = `${r.stderr || ''}${r.stdout ? `\n${r.stdout}` : ''}`.trim();
    if (r.error || r.status !== 0) throw new NativeBuildError(output || r.error?.message || `exit ${r.status}`, output || r.error?.message || `exit ${r.status}`);
    return output;
}

/** A build's temp binary and source (the source written when the spec carries its text) and the compiler's arguments. */
function prepareBuild(spec: NativeCompileSpec, binaryPath: string): { tmpBin: string; tmpSrc?: string; args: string[] } {
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
    return { tmpBin, ...(tmpSrc ? { tmpSrc } : {}), args };
}

function buildFailure(spec: NativeCompileSpec, err: unknown): unknown {
    return err instanceof NativeBuildError ? new NativeBuildError(`could not build ${spec.name}: ${err.compilerOutput.slice(-4000)}`, err.compilerOutput) : err;
}

const inFlight = new Map<string, Promise<NativeCompileResult>>();

/** Where a spec's binary lives in the cache. */
function cacheEntry(spec: NativeCompileSpec): { key: string; entryDir: string; binaryPath: string } {
    const { key } = nativeBuildKey(spec);
    const entryDir = path.join(spec.cacheRoot ?? nativeBuildCacheRoot(), key);
    // The entry's binary is named by the key alone: builds that differ only in the name they ask for share it.
    return { key, entryDir, binaryPath: nativeBuildEntryBinary(path.dirname(entryDir), key) };
}

/** Returns the cached binary for spec, compiling it first when no process has yet (see the file comment). */
export async function compileNativeCached(spec: NativeCompileSpec): Promise<NativeCompileResult> {
    const started = Date.now();
    const { key, entryDir, binaryPath } = cacheEntry(spec);
    // stamped before it is looked at again: a prune that renamed the entry aside meanwhile sees the stamp and puts it back,
    // or the binary is gone and is built anew
    if (statFile(binaryPath) && markUsed(entryDir) && statFile(binaryPath)) {
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
                markUsed(entryDir);
                return { binaryPath, key, cacheHit: true, compileMs: Date.now() - started, compilerOutput: '' };
            }
            const { tmpBin, tmpSrc, args } = prepareBuild(spec, binaryPath);
            const compileStart = Date.now();
            try {
                const output = await runCompiler(compilerArgv(spec.compiler), args, timeoutMs);
                fs.renameSync(tmpBin, binaryPath);
                markUsed(entryDir);
                return { binaryPath, key, cacheHit: false, compileMs: Date.now() - compileStart, compilerOutput: output };
            } catch (err) {
                fs.rmSync(tmpBin, { force: true });
                throw buildFailure(spec, err);
            } finally {
                if (tmpSrc) fs.rmSync(tmpSrc, { force: true });
            }
        } finally {
            release();
        }
    })();
    inFlight.set(binaryPath, build);
    let result: NativeCompileResult;
    try {
        result = await build;
    } finally {
        inFlight.delete(binaryPath);
    }
    if (!result.cacheHit) maybePruneNativeBuildCache(path.dirname(entryDir));
    return result;
}

/**
 * compileNativeCached for a caller that must stay synchronous: the same cache entry and lock, the thread blocked
 * while it waits and compiles. When this process is already building the entry asynchronously (it holds the lock and
 * cannot release it while the thread is blocked), it compiles its own copy and keeps whichever lands first.
 */
export function compileNativeCachedSync(spec: NativeCompileSpec): NativeCompileResult {
    const started = Date.now();
    const { key, entryDir, binaryPath } = cacheEntry(spec);
    if (statFile(binaryPath) && markUsed(entryDir) && statFile(binaryPath)) {
        return { binaryPath, key, cacheHit: true, compileMs: Date.now() - started, compilerOutput: '' };
    }
    const timeoutMs = spec.timeoutMs ?? 15 * 60_000;
    fs.mkdirSync(entryDir, { recursive: true });
    const release = inFlight.has(binaryPath) ? () => undefined : acquireBuildLockSync(`${binaryPath}.lock`, timeoutMs);
    let result: NativeCompileResult;
    try {
        if (statFile(binaryPath)) {
            markUsed(entryDir);
            return { binaryPath, key, cacheHit: true, compileMs: Date.now() - started, compilerOutput: '' };
        }
        const { tmpBin, tmpSrc, args } = prepareBuild(spec, binaryPath);
        const compileStart = Date.now();
        try {
            const output = runCompilerSync(compilerArgv(spec.compiler), args, timeoutMs);
            // an entry is never rewritten: a build that landed meanwhile is kept
            if (statFile(binaryPath)) fs.rmSync(tmpBin, { force: true }); else fs.renameSync(tmpBin, binaryPath);
            markUsed(entryDir);
            result = { binaryPath, key, cacheHit: false, compileMs: Date.now() - compileStart, compilerOutput: output };
        } catch (err) {
            fs.rmSync(tmpBin, { force: true });
            throw buildFailure(spec, err);
        } finally {
            if (tmpSrc) fs.rmSync(tmpSrc, { force: true });
        }
    } finally {
        release();
    }
    maybePruneNativeBuildCache(path.dirname(entryDir));
    return result;
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

// ============================================================================================
// Bounds: last use, age, size

/** Stamps an entry's last use; false when the entry directory is gone. */
export function markNativeBuildEntryUsed(entryDir: string): boolean {
    return markUsed(entryDir);
}

function markUsed(entryDir: string): boolean {
    const stamp = path.join(entryDir, ENTRY_LAST_USED);
    const now = new Date();
    try {
        fs.utimesSync(stamp, now, now);
        return true;
    } catch {
        try {
            fs.writeFileSync(stamp, '');
            return true;
        } catch {
            return false;
        }
    }
}

function lastUsedMs(entryDir: string): number {
    for (const f of [ENTRY_LAST_USED, ENTRY_BINARY]) {
        try {
            return fs.statSync(path.join(entryDir, f)).mtimeMs;
        } catch {
            // next
        }
    }
    return 0;
}

function dirBytes(dir: string): number {
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
        try {
            const st = fs.lstatSync(path.join(dir, name));
            total += st.isDirectory() ? dirBytes(path.join(dir, name)) : st.size;
        } catch {
            // gone meanwhile
        }
    }
    return total;
}

export interface NativeBuildCachePruneOptions {
    /** Cache root (default nativeBuildCacheRoot()). */
    cacheRoot?: string;
    /** Size bound: least recently used entries go until the cache is within it (default 4 GiB). */
    maxBytes?: number;
    /** Entries unused for longer go (default 30 days). */
    maxAgeMs?: number;
    /** Entries used more recently than this are kept whatever the bounds (default 15 min). */
    minIdleMs?: number;
    /** The time to judge ages by (default now). */
    nowMs?: number;
}

export interface NativeBuildCachePruneResult {
    removed: { key: string; bytes: number; lastUsedMs: number; reason: 'age' | 'size' }[];
    /** Entries over a bound that were kept: in use (used within the idle grace, or held in this process) or locked. */
    kept: { key: string; reason: 'in_use' | 'locked' }[];
    bytesBefore: number;
    bytesAfter: number;
}

const DEFAULT_MAX_BYTES = 4096 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600_000;
const DEFAULT_MIN_IDLE_MS = 15 * 60_000;
const PRUNE_INTERVAL_MS = 3600_000;
const PRUNE_STAMP = '.last-prune';
const ASIDE_PREFIX = '.prune-';

/**
 * Removes entries unused for longer than maxAgeMs, then the least recently used until the cache is within maxBytes.
 * Never removes an entry used within minIdleMs, one whose build lock is present, or one this process is building.
 * An entry is renamed aside before it is deleted, and put back when its last-use stamp moved meanwhile.
 */
export function pruneNativeBuildCache(options: NativeBuildCachePruneOptions = {}): NativeBuildCachePruneResult {
    const root = options.cacheRoot ?? nativeBuildCacheRoot();
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const minIdleMs = options.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
    const now = options.nowMs ?? Date.now();
    const result: NativeBuildCachePruneResult = { removed: [], kept: [], bytesBefore: 0, bytesAfter: 0 };
    if (!fs.existsSync(root)) return result;
    const held = new Set([...inFlight.keys()].map(b => path.basename(path.dirname(b))));
    // used: the last use (the stamp, else the binary's mtime, else the directory's); stamped: the first two alone (0: neither)
    const entries: { key: string; dir: string; bytes: number; used: number; stamped: number }[] = [];
    for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (name.startsWith(ASIDE_PREFIX)) {
            // left by a prune whose process is gone
            const m = /^\.prune-.+-(\d+)-[0-9a-f]+$/.exec(name);
            if (m && !processAlive(Number(m[1]))) fs.rmSync(dir, { recursive: true, force: true });
            continue;
        }
        let st: fs.Stats;
        try {
            st = fs.statSync(dir);
        } catch {
            continue;
        }
        if (!st.isDirectory()) continue;
        const bytes = dirBytes(dir);
        result.bytesBefore += bytes;
        // an entry without its binary is being built, or a failed build: removed only by age, when nothing holds it
        const stamped = lastUsedMs(dir);
        entries.push({ key: name, dir, bytes, used: stamped || st.mtimeMs, stamped });
    }
    entries.sort((a, b) => a.used - b.used || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let total = result.bytesBefore;
    for (const e of entries) {
        const reason = now - e.used > maxAgeMs ? 'age' : total > maxBytes ? 'size' : undefined;
        if (!reason) continue;
        if (!statFile(path.join(e.dir, ENTRY_BINARY)) && reason !== 'age') continue;
        if (held.has(e.key) || now - e.used < minIdleMs) { result.kept.push({ key: e.key, reason: 'in_use' }); continue; }
        if (fs.existsSync(path.join(e.dir, `${ENTRY_BINARY}.lock`))) { result.kept.push({ key: e.key, reason: 'locked' }); continue; }
        const aside = path.join(root, `${ASIDE_PREFIX}${e.key}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        try {
            fs.renameSync(e.dir, aside);
        } catch {
            continue; // gone, or taken meanwhile
        }
        // used (or locked for a build) between the look and the rename: put it back, unless the key was built anew meanwhile
        if (lastUsedMs(aside) !== e.stamped || fs.existsSync(path.join(aside, `${ENTRY_BINARY}.lock`))) {
            try {
                fs.renameSync(aside, e.dir);
            } catch {
                fs.rmSync(aside, { recursive: true, force: true });
            }
            result.kept.push({ key: e.key, reason: 'in_use' });
            continue;
        }
        fs.rmSync(aside, { recursive: true, force: true });
        total -= e.bytes;
        result.removed.push({ key: e.key, bytes: e.bytes, lastUsedMs: e.used, reason });
    }
    result.bytesAfter = total;
    return result;
}

function envNumber(name: string): number | undefined {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Prunes the cache with the environment's bounds, at most once per PRUNE_INTERVAL_MS across processes; never throws. */
export function maybePruneNativeBuildCache(cacheRoot: string = nativeBuildCacheRoot()): NativeBuildCachePruneResult | undefined {
    try {
        const stamp = path.join(cacheRoot, PRUNE_STAMP);
        const last = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
        if (Date.now() - last < PRUNE_INTERVAL_MS) return undefined;
        fs.mkdirSync(cacheRoot, { recursive: true });
        fs.writeFileSync(stamp, String(process.pid));
        const mb = envNumber('SCRATCHBOX_NATIVE_BUILD_CACHE_MAX_MB');
        const days = envNumber('SCRATCHBOX_NATIVE_BUILD_CACHE_MAX_AGE_DAYS');
        return pruneNativeBuildCache({
            cacheRoot,
            maxBytes: mb === undefined ? undefined : mb * 1024 * 1024,
            maxAgeMs: days === undefined ? undefined : days * 24 * 3600_000
        });
    } catch {
        return undefined;
    }
}
