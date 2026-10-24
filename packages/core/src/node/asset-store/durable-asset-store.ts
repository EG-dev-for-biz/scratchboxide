/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The durable asset store: every file the app publishes to a URL (/models/x.glb, /build/generated-images/y.png, ...)
 * is also kept under the user's Scratchbox home, named by its content hash, with the recipe that made it. A checkout
 * can be deleted, its public/models emptied or its build directory cleaned, and the served paths keep working: the
 * server looks a missing file up here (app.ts), and a path whose file is gone everywhere can be rebuilt from its recipe.
 *
 * Layout under <home>:
 *   scratchbox.db                   the index (asset-db.ts)
 *   assets/blobs/<aa>/<sha256>      the bytes, one file per distinct content (APFS clones when the volume allows)
 *
 * The store is deliberately simple: synchronous, one process-wide instance, and every method either records what it
 * did or throws. A file is never served from it unless its bytes still match the recorded size.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AssetDb, type EventRow, type RecipeRow, type ServedRow } from './asset-db';
import { scratchboxHome } from './scratchbox-home';

export interface StoredAsset extends ServedRow {
    /** The blob's absolute path in the store. */
    file: string;
}

export interface PutFileOptions {
    /** The URL path the app serves the file at, e.g. "/models/x.glb". */
    servedPath: string;
    /** Which part of the app made it (an open label). */
    origin: string;
    workspace?: string;
    /** The recipe this file came out of (recipes are put separately, before or after). */
    recipeId?: string;
    mime?: string;
    /** The file replaces one that was lost: the served path is marked as rebuilt. */
    rebuilt?: boolean;
}

export interface BackfillReport {
    /** Files recorded by this sweep. */
    added: number;
    /** Files already recorded with the same size and mtime. */
    unchanged: number;
    /** Files that could not be read or hashed, with why. */
    failed: Array<{ file: string; error: string }>;
}

const SHA = /^[0-9a-f]{64}$/;

const MIME_BY_EXT: Record<string, string> = {
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.ply': 'application/octet-stream', '.spz': 'application/octet-stream', '.splat': 'application/octet-stream',
    '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream', '.txt': 'text/plain', '.csv': 'text/csv', '.py': 'text/x-python'
};

export function mimeForFile(file: string): string | undefined {
    return MIME_BY_EXT[path.extname(file).toLowerCase()];
}

export function sha256OfFile(file: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/** sha256OfFile without blocking the event loop (the background sweep). */
export function sha256OfFileStreamed(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file, { highWaterMark: 1 << 20 })
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** A served path as the store keys it: decoded, one leading slash, no "." or ".." segments. Throws on anything else. */
export function normalizeServedPath(raw: string): string {
    let decoded = raw.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        throw new Error(`asset store: served path is not valid URL text: ${JSON.stringify(raw)}`);
    }
    decoded = decoded.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!decoded.startsWith('/')) decoded = `/${decoded}`;
    const segments = decoded.slice(1).split('/');
    if (segments.some(s => s === '' || s === '.' || s === '..') || decoded.includes('\0')) {
        throw new Error(`asset store: served path has an empty, "." or ".." segment: ${JSON.stringify(raw)}`);
    }
    return decoded;
}

export class DurableAssetStore {
    readonly home: string;
    readonly root: string;
    readonly db: AssetDb;
    private readonly blobKeptListeners = new Set<(sha256: string) => void>();

    constructor(home: string = scratchboxHome()) {
        this.home = path.resolve(home);
        this.root = path.join(this.home, 'assets');
        fs.mkdirSync(path.join(this.root, 'blobs'), { recursive: true });
        this.db = new AssetDb(path.join(this.home, 'scratchbox.db'));
    }

    blobPath(sha256: string): string {
        if (!SHA.test(sha256)) throw new Error(`asset store: bad sha256 ${JSON.stringify(sha256)}`);
        return path.join(this.root, 'blobs', sha256.slice(0, 2), sha256);
    }

    /**
     * Records `file` under its served path: hashes it, keeps its bytes (a copy is made only when that content is not
     * in the store yet) and points the served path at it. Returns what was recorded.
     */
    putFile(file: string, opts: PutFileOptions): StoredAsset {
        const source = path.resolve(file);
        const stat = fs.statSync(source);
        if (!stat.isFile()) throw new Error(`asset store: not a file: ${source}`);
        return this.putHashed(source, sha256OfFile(source), stat.size, opts);
    }

    /** putFile for a caller that hashed the file itself (the background sweep hashes with a stream). */
    private putHashed(source: string, sha256: string, bytes: number, opts: PutFileOptions): StoredAsset {
        const servedPath = normalizeServedPath(opts.servedPath);
        const stat = { size: bytes };
        const copied = this.keepBytes(source, sha256, stat.size);
        const mime = opts.mime ?? mimeForFile(source) ?? null;
        const previous = this.db.served(servedPath);
        this.db.transaction(() => {
            this.db.upsertBlob({ sha256, bytes: stat.size, mime });
            this.db.upsertServed({ path: servedPath, sha256, workspace: opts.workspace ?? null, origin: opts.origin, recipeId: opts.recipeId ?? null, rebuilt: !!opts.rebuilt });
            if (!previous || previous.sha256 !== sha256 || previous.rebuilt !== !!opts.rebuilt) {
                this.db.addEvent(opts.rebuilt ? 'asset.rebuilt' : previous ? 'asset.replaced' : 'asset.stored', servedPath, sha256,
                    { origin: opts.origin, bytes: stat.size, ...(opts.recipeId ? { recipeId: opts.recipeId } : {}), ...(previous ? { previousSha256: previous.sha256 } : {}) });
            }
        });
        if (copied) this.notifyBlobKept(sha256);
        return this.lookupRequired(servedPath);
    }

    /** Calls `listener` with each content hash whose bytes newly enter the store (the cloud mirror uploads them). */
    onBlobKept(listener: (sha256: string) => void): () => void {
        this.blobKeptListeners.add(listener);
        return () => this.blobKeptListeners.delete(listener);
    }

    private notifyBlobKept(sha256: string): void {
        for (const listener of this.blobKeptListeners) {
            try {
                listener(sha256);
            } catch (err) {
                console.warn(`[asset-store] blob listener failed for ${sha256}: ${(err as Error).message}`);
            }
        }
    }

    /** Points `servedPath` at the content another served path already has (a rebuilt layer under the old name). */
    alias(servedPath: string, toServedPath: string, opts: { origin: string; recipeId?: string; rebuilt?: boolean; workspace?: string }): StoredAsset {
        const target = this.lookup(toServedPath);
        if (!target) throw new Error(`asset store: nothing is served at ${toServedPath}`);
        const normalized = normalizeServedPath(servedPath);
        this.db.transaction(() => {
            this.db.upsertServed({ path: normalized, sha256: target.sha256, workspace: opts.workspace ?? target.workspace, origin: opts.origin, recipeId: opts.recipeId ?? target.recipeId, rebuilt: !!opts.rebuilt });
            this.db.addEvent(opts.rebuilt ? 'asset.rebuilt' : 'asset.aliased', normalized, target.sha256, { from: target.path, origin: opts.origin });
        });
        return this.lookupRequired(normalized);
    }

    /** What is served at `servedPath`, when its bytes are present and whole; undefined otherwise. */
    lookup(servedPath: string): StoredAsset | undefined {
        let normalized: string;
        try {
            normalized = normalizeServedPath(servedPath);
        } catch {
            return undefined;
        }
        const row = this.db.served(normalized);
        if (!row) return undefined;
        const file = this.blobPath(row.sha256);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            return undefined;
        }
        if (!stat.isFile() || stat.size !== row.bytes) return undefined;
        return { ...row, file };
    }

    private lookupRequired(servedPath: string): StoredAsset {
        const found = this.lookup(servedPath);
        if (!found) throw new Error(`asset store: ${servedPath} was recorded but its bytes are not in the store`);
        return found;
    }

    /**
     * Writes the stored bytes of `servedPath` back to `dir/<basename>` (the checkout copy, e.g. public/models) when that
     * file is missing or differs, so code that reads published files from disk finds a recovered file where it expects
     * it. Returns the file's path, or undefined when the store has no bytes for the path.
     */
    materialize(servedPath: string, dir: string): string | undefined {
        const found = this.lookup(servedPath);
        if (!found) return undefined;
        const target = path.join(path.resolve(dir), path.posix.basename(found.path));
        if (fs.existsSync(target) && fs.statSync(target).size === found.bytes && sha256OfFile(target) === found.sha256) return target;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.copyFileSync(found.file, tmp, fs.constants.COPYFILE_FICLONE);
            fs.renameSync(tmp, target);
        } catch (err) {
            fs.rmSync(tmp, { force: true });
            throw err;
        }
        this.db.addEvent('asset.materialized', found.path, found.sha256, { file: target });
        return target;
    }

    /** The served row even when its bytes are gone (so a recipe can still be found for a rebuild). */
    record(servedPath: string): ServedRow | undefined {
        try {
            return this.db.served(normalizeServedPath(servedPath));
        } catch {
            return undefined;
        }
    }

    putRecipe(recipe: { id: string; kind: string; workspace?: string; body: unknown }): void {
        const existing = this.db.recipe(recipe.id);
        this.db.transaction(() => {
            this.db.upsertRecipe({ id: recipe.id, kind: recipe.kind, workspace: recipe.workspace ?? null, body: recipe.body });
            if (!existing) this.db.addEvent('recipe.stored', recipe.id, null, { kind: recipe.kind });
        });
    }

    recipe(id: string): RecipeRow | undefined {
        return this.db.recipe(id);
    }

    /** The recipe behind a served path, from its record (the bytes need not be present). */
    recipeFor(servedPath: string): RecipeRow | undefined {
        const row = this.record(servedPath);
        return row?.recipeId ? this.db.recipe(row.recipeId) : undefined;
    }

    servedByRecipe(recipeId: string): StoredAsset[] {
        return this.db.servedByRecipe(recipeId).map(row => ({ ...row, file: this.blobPath(row.sha256) }));
    }

    events(opts: { subject?: string; limit?: number } = {}): EventRow[] {
        return this.db.events(opts);
    }

    /**
     * Records every file under `dir` as served at `urlPrefix` + its relative path. Files already seen with the same
     * size and mtime are not hashed again, so a repeat sweep over a large models directory is cheap. Served paths that
     * are already recorded are kept pointing where they are unless the file's content differs. Hashing streams and
     * the sweep yields between files, so a server can run it in the background while it serves requests.
     */
    async backfill(dir: string, urlPrefix: string, opts: { origin?: string; workspace?: string; shouldStop?: () => boolean } = {}): Promise<BackfillReport> {
        const report: BackfillReport = { added: 0, unchanged: 0, failed: [] };
        const base = path.resolve(dir);
        if (!fs.existsSync(base)) return report;
        const prefix = normalizeServedPath(urlPrefix);
        const walk = async (d: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(d, { withFileTypes: true });
            } catch (err) {
                report.failed.push({ file: d, error: (err as Error).message });
                return;
            }
            for (const entry of entries) {
                if (opts.shouldStop?.()) return;
                if (entry.name.startsWith('.')) continue;
                const file = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    await walk(file);
                    continue;
                }
                if (!entry.isFile()) continue;
                try {
                    const stat = fs.statSync(file);
                    const rel = path.relative(base, file).split(path.sep).join('/');
                    const servedPath = `${prefix}/${rel}`;
                    const known = this.db.scanned(file, stat.size, stat.mtimeMs);
                    const current = this.db.served(servedPath);
                    if (known && current && current.sha256 === known && fs.existsSync(this.blobPath(known))) {
                        report.unchanged++;
                        continue;
                    }
                    const sha256 = await sha256OfFileStreamed(file);
                    // the file on disk is what the record already says (a copy the store wrote back, or an unchanged
                    // file seen for the first time by this sweep): the record keeps its origin, recipe and rebuilt flag
                    if (current && current.sha256 === sha256 && fs.existsSync(this.blobPath(sha256))) {
                        this.db.rememberScanned(file, stat.size, stat.mtimeMs, sha256);
                        report.unchanged++;
                        continue;
                    }
                    const stored = this.putHashed(file, sha256, stat.size, { servedPath, origin: opts.origin ?? 'backfill', ...(opts.workspace ? { workspace: opts.workspace } : {}) });
                    this.db.rememberScanned(file, stat.size, stat.mtimeMs, stored.sha256);
                    report.added++;
                } catch (err) {
                    report.failed.push({ file, error: (err as Error).message });
                }
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        };
        await walk(base);
        return report;
    }

    /** Copies the bytes into the store when that content is not there yet (atomic: a temp file, then a rename); true when it copied. */
    private keepBytes(source: string, sha256: string, bytes: number): boolean {
        const target = this.blobPath(sha256);
        if (fs.existsSync(target) && fs.statSync(target).size === bytes) return false;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.copyFileSync(source, tmp, fs.constants.COPYFILE_FICLONE);
            fs.renameSync(tmp, target);
        } catch (err) {
            fs.rmSync(tmp, { force: true });
            if (fs.existsSync(target) && fs.statSync(target).size === bytes) return false; // another process won the race
            throw err;
        }
        return true;
    }

    close(): void {
        this.db.close();
    }
}

let shared: DurableAssetStore | undefined;
let sharedFailure: string | undefined;

/**
 * The process-wide store under the user's Scratchbox home, opened on first use. SCRATCHBOX_ASSET_STORE=0 turns it
 * off (every caller then behaves as before the store existed). A store that cannot be opened is reported once and
 * treated as off: publishing never fails because the index is unavailable.
 */
export function defaultDurableAssetStore(): DurableAssetStore | undefined {
    if (process.env.SCRATCHBOX_ASSET_STORE === '0') return undefined;
    if (shared && shared.home === scratchboxHome()) return shared;
    if (sharedFailure) return undefined;
    try {
        shared = new DurableAssetStore();
        return shared;
    } catch (err) {
        sharedFailure = (err as Error).message;
        console.warn(`[asset-store] not available: ${sharedFailure}`);
        return undefined;
    }
}

/** Forgets the shared store (tests that change SCRATCHBOX_HOME between cases). */
export function resetDefaultDurableAssetStore(): void {
    try {
        shared?.close();
    } catch { /* already closed */ }
    shared = undefined;
    sharedFailure = undefined;
}
