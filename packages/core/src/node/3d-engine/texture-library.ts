/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Surface material sets from the private texture library bucket (ambientCG and Poly Haven PBR sets, one folder per set
 * at the bucket's root), fetched for a procedural script before it runs: sb.library_surface() reads them, shrinks and
 * packs them natively and matches them to a measured colour. Only the maps a GLB material uses are downloaded (colour,
 * OpenGL-convention normal, roughness, occlusion, metalness, or a packed AO/roughness/metalness map), into a cache under
 * build/texture-library/ that later runs reuse. The set names come from the bucket's folder listing (cached a week), and a
 * name not in it is reported with the closest names instead of failing the script. Each fetched set carries its entry in
 * the library index (assets/textures/library/index.json: real size, measured colour and finish), which
 * texture_library_search ranks.
 *
 * Map roles are told apart by the two libraries' file-naming conventions for channels (ambientCG `_Color`, `_NormalGL`;
 * Poly Haven `_diff_`, `_nor_gl_`), never by what a set depicts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { NativePythonRunnerService } from './native-python-runner-service';
import { ESTIMATED_SIZES_FILE, type EstimatedSizes } from './texture-library-sizes';
import type { TextureLibraryColour, TextureLibraryEntry, TextureLibraryIndex } from '../../common/spatial/texture-library-index';

export interface LibrarySetMaps {
    color?: string;
    normal?: string;
    roughness?: string;
    ao?: string;
    metalness?: string;
    /** Poly Haven's packed map: R occlusion, G roughness, B metalness. */
    arm?: string;
}

export interface LibrarySet {
    name: string;
    /** Local files by role, under the cache. */
    maps: LibrarySetMaps;
    dir: string;
    /** The set's entry in the library index (real size, measured colour and finish), when the index has it. */
    index?: TextureLibraryEntry;
}

export interface LibraryFetch {
    bucket: string;
    cacheDir: string;
    sets: LibrarySet[];
    /** Requested names the library does not have (or has without a colour map), each with its closest names. */
    missing: Array<{ name: string; reason: string; nearest: string[] }>;
    catalogSize: number;
}

const ROLE_PATTERNS: ReadonlyArray<{ role: keyof LibrarySetMaps; pattern: RegExp }> = [
    { role: 'color', pattern: /_(Color|diff|diffuse|albedo|basecolor)[_.]/i },
    { role: 'normal', pattern: /_(NormalGL|nor_gl)[_.]/i },
    { role: 'roughness', pattern: /_(Roughness|rough)[_.]/i },
    { role: 'ao', pattern: /_(AmbientOcclusion|ao)[_.]/i },
    { role: 'metalness', pattern: /_(Metalness|metal)[_.]/i },
    { role: 'arm', pattern: /_arm[_.]/i }
];
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;

let indexCache: { file: string; mtimeMs: number; index: TextureLibraryIndex } | undefined;

/** One set's statistics, measured by the engine on its publisher's preview maps, cached under build/texture-library/stats/. */
interface MeasuredStats {
    colour?: TextureLibraryColour;
    roughnessMean?: number;
    roughnessSpread?: number;
    metallic?: number;
    /** Whether a metalness (or packed ARM) preview was measured, and what it showed. */
    metalnessMeasured?: boolean;
    metalShare?: number;
    metalnessP95?: number;
    normalTiltRmsDeg?: number;
    statsSource?: string;
    sourceSize?: [number, number];
    /** STATS_VERSION when measured; older files are measured again when a search reaches them. */
    version?: number;
    error?: string;
}

/** 2: metal share and 95th percentile, normal tilt, and whether metalness was measured. */
const STATS_VERSION = 2;

const statsDir = (repoRoot: string) => path.join(repoRoot, 'build', 'texture-library', 'stats');
const statsFile = (repoRoot: string, id: string) => path.join(statsDir(repoRoot), `${id}.json`);

/** An index entry with its measured statistics, when the set has been measured: colour, finish, and the shape the
 * preview's aspect gives (the pixel size, and the height when the publisher gave only a width). */
function withStats(e: TextureLibraryEntry, st: MeasuredStats | undefined): TextureLibraryEntry {
    if (!st) return e;
    if (st.error) return { ...e, notes: [...(e.notes ?? []), `preview statistics failed: ${st.error}`] };
    const out: TextureLibraryEntry = { ...e, ...(st.colour ? { colour: st.colour } : {}), ...(st.statsSource ? { statsSource: st.statsSource } : {}) };
    if (st.roughnessMean !== undefined) { out.roughnessMean = st.roughnessMean; out.roughnessSpread = st.roughnessSpread; }
    if (st.metallic !== undefined) out.metallic = st.metallic;
    out.hasMetalnessMap = !!(e.maps.metalness || e.maps.arm);
    if (st.metalnessMeasured) { out.metalShare = st.metalShare; out.metalnessP95 = st.metalnessP95; }
    else if (st.version !== undefined && out.hasMetalnessMap) {
        // the bucket holds a metalness map its publisher has no preview of: its metalness is unknown, not 0
        delete out.metallic;
        out.notes = [...(out.notes ?? []), 'its metalness map has no preview to measure: metalness unmeasured'];
    }
    if (st.normalTiltRmsDeg !== undefined) out.normalTiltRmsDeg = st.normalTiltRmsDeg;
    const aspect = st.sourceSize ? st.sourceSize[1] / st.sourceSize[0] : undefined;
    if (aspect && e.pixels && e.pixels[0] === e.pixels[1] && aspect !== 1) {
        const long = e.pixels[0];
        out.pixels = aspect < 1 ? [long, Math.round(long * aspect)] : [Math.round(long / aspect), long];
    }
    if (aspect && !e.realSizeM && e.widthOnlyM) {
        out.realSizeM = [e.widthOnlyM, Math.round(e.widthOnlyM * aspect * 1000) / 1000];
        out.sizeSource = `${e.publisher} metadata (width; height from the preview's aspect)`;
        out.notes = (e.notes ?? []).filter(n => !/no real size/.test(n));
    }
    return out;
}

/** The library index (assets/textures/library/index.json under `repoRoot`, built by scripts/build_texture_library_index.ts)
 * with the statistics of every set measured so far; undefined when it has not been built. */
export function loadTextureLibraryIndex(repoRoot: string): TextureLibraryIndex | undefined {
    const file = path.join(repoRoot, 'assets', 'textures', 'library', 'index.json');
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return undefined; }
    if (indexCache?.file !== file || indexCache.mtimeMs !== mtimeMs) indexCache = { file, mtimeMs, index: JSON.parse(fs.readFileSync(file, 'utf8')) as TextureLibraryIndex };
    let measured: string[] = [];
    try { measured = fs.readdirSync(statsDir(repoRoot)).filter(f => f.endsWith('.json')); } catch { /* nothing measured yet */ }
    const estimates = estimatedSizes(path.join(path.dirname(file), ESTIMATED_SIZES_FILE));
    if (!measured.length && !estimates) return indexCache.index;
    const stats = new Map<string, MeasuredStats>();
    for (const f of measured) {
        try { stats.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(statsDir(repoRoot), f), 'utf8')) as MeasuredStats); } catch { /* a half-written file: measured again when needed */ }
    }
    return { ...indexCache.index, sets: indexCache.index.sets.map(e => withEstimatedSize(withStats(e, stats.get(e.id)), estimates)) };
}

let sizesCache: { file: string; mtimeMs: number; doc: EstimatedSizes } | undefined;
/** The estimated tile sizes (texture-library-sizes.ts), when they have been made. */
function estimatedSizes(file: string): EstimatedSizes | undefined {
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return undefined; }
    if (sizesCache?.file !== file || sizesCache.mtimeMs !== mtimeMs) sizesCache = { file, mtimeMs, doc: JSON.parse(fs.readFileSync(file, 'utf8')) as EstimatedSizes };
    return sizesCache.doc;
}

/** A set without a publisher size given its estimated width, its height from its pixels' aspect, and labelled so. */
function withEstimatedSize(e: TextureLibraryEntry, doc: EstimatedSizes | undefined): TextureLibraryEntry {
    const est = doc?.sets[e.id];
    if (e.realSizeM || !est) return e;
    const aspect = e.pixels ? e.pixels[1] / e.pixels[0] : 1;
    return {
        ...e, realSizeM: [est.widthM, Math.round(est.widthM * aspect * 1000) / 1000],
        sizeSource: `estimated from its preview by a vision model (${doc!.model}, confidence ${Math.round(est.conf)}; generated)`,
        notes: (e.notes ?? []).filter(n => !/no real size/.test(n))
    };
}

async function fetchRetry(url: string, signal?: AbortSignal, tries = 3): Promise<Response> {
    for (let i = 1; ; i++) {
        try {
            const r = await fetch(url, signal ? { signal } : {});
            if (r.ok || r.status === 404 || i >= tries) return r;
        } catch (err) {
            if (i >= tries || signal?.aborted) throw err;
        }
        await new Promise(res => setTimeout(res, 800 * 2 ** i));
    }
}

/** A Poly Haven set's 1K JPEG colour, normal, roughness (or packed ARM) and metalness maps, from its file listing. */
async function polyHavenPreviews(id: string, signal?: AbortSignal): Promise<NonNullable<TextureLibraryEntry['previews']>> {
    const r = await fetchRetry(`https://api.polyhaven.com/files/${encodeURIComponent(id)}`, signal);
    if (!r.ok) throw new Error(`Poly Haven lists no files for ${id} (HTTP ${r.status})`);
    const files = await r.json() as Record<string, Record<string, Record<string, { url: string }>>>;
    const jpg = (k: string) => files[k]?.['1k']?.jpg?.url;
    return {
        ...(jpg('Diffuse') ? { color: jpg('Diffuse') } : {}),
        ...(jpg('nor_gl') ? { normal: jpg('nor_gl') } : {}),
        // the packed map carries the metalness (its blue channel); a separate roughness map, when listed, overrides its green
        ...(jpg('arm') ? { arm: jpg('arm') } : {}),
        ...(jpg('Rough') ? { roughness: jpg('Rough') } : {}),
        ...(jpg('Metal') ? { metalness: jpg('Metal') } : {})
    };
}

/**
 * A set's colour preview (its publisher's 1K JPEG), cached under build/texture-library/previews: what the tile-only harvest
 * measures a set's texture from (pipeline-k/material-harvest.ts). Undefined when the publisher lists none.
 */
export async function libraryColourPreview(entry: TextureLibraryEntry, repoRoot: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const dir = path.join(repoRoot, 'build', 'texture-library', 'previews');
    const file = path.join(dir, `${entry.id}.jpg`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const previews = entry.previews?.color ? entry.previews : entry.publisher === 'Poly Haven' ? await polyHavenPreviews(entry.id, signal) : {};
    if (!previews.color) return undefined;
    const r = await fetchRetry(previews.color, signal);
    if (!r.ok) return undefined;
    const bytes = new Uint8Array(await r.arrayBuffer());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    return bytes;
}

/** Whether a set has been measured at the current STATS_VERSION, or failed to be (a failure is not retried). */
export function libraryEntryMeasured(repoRoot: string, id: string): boolean {
    try { const st = JSON.parse(fs.readFileSync(statsFile(repoRoot, id), 'utf8')) as MeasuredStats; return !!st.error || st.version === STATS_VERSION; } catch { return false; }
}

/**
 * Measures the given sets' colour, roughness, metalness and normal relief with the engine (sb._native.surface.prepare_material_maps) on
 * their publishers' small preview maps, and caches the statistics per set; the previews are deleted once measured. Sets
 * measured before (at the current STATS_VERSION, or that failed) are skipped. Only what a search is about to rank is measured, never the whole library.
 */
/** Sets measured per engine run (measureLibraryEntries). */
const MEASURE_CHUNK = 64;

export async function measureLibraryEntries(entries: TextureLibraryEntry[], opts: { repoRoot: string; signal?: AbortSignal; concurrency?: number }): Promise<{ measured: string[]; failed: Array<{ id: string; reason: string }> }> {
    const todo = entries.filter(e => !libraryEntryMeasured(opts.repoRoot, e.id));
    const failed: Array<{ id: string; reason: string }> = [];
    if (!todo.length) return { measured: [], failed };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-library-previews-'));
    const jobs: Array<{ id: string; publisher: string; color: string; normal?: string; roughness?: string; metalness?: string; arm?: string }> = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, todo.length) }, async () => {
        while (next < todo.length) {
            const e = todo[next++];
            try {
                const previews = e.previews?.color ? e.previews : e.publisher === 'Poly Haven' ? await polyHavenPreviews(e.id, opts.signal) : {};
                if (!previews.color) throw new Error('its publisher has no preview colour map');
                const local: Record<string, string> = {};
                for (const [role, url] of Object.entries(previews)) {
                    if (!url) continue;
                    const r = await fetchRetry(url, opts.signal);
                    if (!r.ok) { if (role === 'color') throw new Error(`preview colour map unavailable (HTTP ${r.status})`); continue; }
                    const file = path.join(work, `${e.id}_${role}${path.extname(new URL(url).pathname) || '.jpg'}`);
                    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
                    local[role] = file;
                }
                jobs.push({ id: e.id, publisher: e.publisher, color: local.color, ...local });
            } catch (err) {
                if (opts.signal?.aborted) throw err;
                failed.push({ id: e.id, reason: err instanceof Error ? err.message : String(err) });
            }
        }
    }));
    try {
        // in chunks, each its own engine run whose statistics are written as it finishes: a long list on a busy machine
        // never runs one call past its time limit, and what was measured is kept when a later chunk fails
        for (let at = 0; at < jobs.length; at += MEASURE_CHUNK) {
            const chunk = jobs.slice(at, at + MEASURE_CHUNK), tag = `${at / MEASURE_CHUNK}`;
            const out = path.join(work, `stats_${tag}.json`), jobsFile = path.join(work, `jobs_${tag}.json`);
            const script = `
import json, scratchbox_native as n
jobs = json.load(open(${JSON.stringify(jobsFile)}))
out = {}
for j in jobs:
    try:
        r = n.surface.prepare_material_maps(j["color"], normal=j.get("normal", ""), roughness=j.get("roughness", ""), metalness=j.get("metalness", ""), arm=j.get("arm", ""), max_size=256)
        out[j["id"]] = {k: (list(v) if isinstance(v, tuple) else v) for k, v in r.items() if not k.endswith("_png")}
        out[j["id"]]["has_roughness"] = bool(j.get("roughness") or j.get("arm"))
        out[j["id"]]["has_metalness"] = bool(j.get("metalness") or j.get("arm"))
        out[j["id"]]["has_normal"] = bool(j.get("normal"))
    except Exception as e:
        out[j["id"]] = {"error": str(e)}
json.dump(out, open(${JSON.stringify(out)}, "w"))
`;
            fs.writeFileSync(jobsFile, JSON.stringify(chunk));
            const run = await NativePythonRunnerService.getInstance().runScript(script, { timeoutMs: 10 * 60 * 1000, ...(opts.signal ? { signal: opts.signal } : {}) });
            if (!run.success) throw new Error(`measuring the library previews failed (sets ${at + 1}-${at + chunk.length} of ${jobs.length}; ${at} measured before): ${run.stderr || run.errorDetails || 'the engine run ended without a reason (its time limit?)'}`);
            const raw = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, Record<string, any>>;
            const r4 = (v: number) => Math.round(v * 1e4) / 1e4, r2 = (v: number) => Math.round(v * 100) / 100;
            fs.mkdirSync(statsDir(opts.repoRoot), { recursive: true });
            for (const j of chunk) {
                const st = raw[j.id];
                const m: MeasuredStats = !st || st.error ? { error: st?.error ?? 'no statistics returned' } : {
                    colour: {
                        meanLinearRgb: st.mean_albedo_linear.map(r4), spreadLinearRgb: st.spread_albedo_linear.map(r4),
                        meanLab: st.mean_lab.map(r2), spreadLab: st.spread_lab.map(r2)
                    },
                    ...(st.has_roughness ? { roughnessMean: r4(st.mean_roughness), roughnessSpread: r4(st.spread_roughness) } : {}),
                    metallic: r4(st.mean_metalness),
                    metalnessMeasured: !!st.has_metalness,
                    ...(st.has_metalness ? { metalShare: r4(st.metal_share), metalnessP95: r4(st.metalness_p95) } : {}),
                    ...(st.has_normal ? { normalTiltRmsDeg: r2(st.normal_tilt_rms_deg) } : {}),
                    version: STATS_VERSION,
                    statsSource: `${j.publisher} preview maps (${st.source_size.join('x')}), measured by the engine`,
                    sourceSize: st.source_size
                };
                fs.writeFileSync(statsFile(opts.repoRoot, j.id), JSON.stringify(m));
                if (m.error) failed.push({ id: j.id, reason: m.error });
            }
        }
        // a set that cannot be measured is remembered, so later searches do not fetch it again
        fs.mkdirSync(statsDir(opts.repoRoot), { recursive: true });
        for (const f of failed) if (!fs.existsSync(statsFile(opts.repoRoot, f.id))) fs.writeFileSync(statsFile(opts.repoRoot, f.id), JSON.stringify({ error: f.reason }));
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    return { measured: jobs.map(j => j.id).filter(id => !failed.some(f => f.id === id)), failed };
}

export function libraryBucket(): string {
    return process.env.GCS_TEXTURE_BUCKET || 'scratchbox-library-training-textures';
}

/** The role a library file plays, or undefined for files a GLB material does not use (displacement, DX normals, previews,
 * .blend/.usdc/.mtlx, half-uploaded `.part` maps). */
export function mapRole(objectName: string): keyof LibrarySetMaps | undefined {
    if (!/\.(png|jpe?g)$/i.test(objectName)) return undefined;
    // only the part after the set's own name, which may itself hold a channel word ("rough_plaster")
    const [set] = objectName.split('/');
    const base = path.posix.basename(objectName);
    const rest = base.toLowerCase().startsWith(set.toLowerCase()) ? base.slice(set.length) : base;
    return ROLE_PATTERNS.find(r => r.pattern.test(rest))?.role;
}

/** Closest catalogue names to one not in it: those sharing its letters-only stem first, then by common prefix. */
export function nearestNames(name: string, catalog: string[], limit = 8): string[] {
    const stem = name.toLowerCase().replace(/[^a-z]/g, '');
    const lower = name.toLowerCase();
    const prefixLen = (a: string) => { let i = 0; while (i < a.length && i < lower.length && a[i] === lower[i]) i++; return i; };
    return catalog
        .map(n => ({ n, stemHit: stem.length >= 3 && n.toLowerCase().replace(/[^a-z]/g, '').includes(stem) ? 1 : 0, p: prefixLen(n.toLowerCase()) }))
        .filter(c => c.stemHit || c.p >= 3)
        .sort((a, b) => b.stemHit - a.stemHit || b.p - a.p || a.n.localeCompare(b.n))
        .slice(0, limit)
        .map(c => c.n);
}

async function loadCatalog(storage: ReturnType<GoogleMediaCredentialsService['createStorageClient']>, bucket: string, cacheDir: string): Promise<string[]> {
    const file = path.join(cacheDir, 'catalog.json');
    try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8')) as { bucket: string; at: number; sets: string[] };
        if (c.bucket === bucket && Date.now() - c.at < CATALOG_TTL_MS) return c.sets;
    } catch { /* no catalogue cached yet */ }
    const sets: string[] = [];
    let pageToken: string | undefined;
    do {
        const [, next, response] = await storage.bucket(bucket).getFiles({ delimiter: '/', autoPaginate: false, maxResults: 1000, ...(pageToken ? { pageToken } : {}) });
        sets.push(...((response as { prefixes?: string[] })?.prefixes ?? []).map(p => p.replace(/\/$/, '')));
        pageToken = (next as { pageToken?: string } | null)?.pageToken;
    } while (pageToken);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bucket, at: Date.now(), sets }));
    return sets;
}

/** Fetches the named sets' maps into `cacheDir` (default build/texture-library under `repoRoot`). */
export async function fetchLibrarySets(names: string[], opts: { repoRoot: string; cacheDir?: string; signal?: AbortSignal; progress?: (m: string) => void }): Promise<LibraryFetch> {
    const bucket = libraryBucket();
    const cacheDir = opts.cacheDir ?? path.join(opts.repoRoot, 'build', 'texture-library');
    const storage = new GoogleMediaCredentialsService().createStorageClient();
    const catalog = await loadCatalog(storage, bucket, cacheDir);
    const byLower = new Map(catalog.map(n => [n.toLowerCase(), n]));
    const indexed = new Map((loadTextureLibraryIndex(opts.repoRoot)?.sets ?? []).map(e => [e.id, e]));
    const out: LibraryFetch = { bucket, cacheDir, sets: [], missing: [], catalogSize: catalog.length };
    for (const raw of [...new Set(names.map(n => n.trim()).filter(Boolean))]) {
        opts.signal?.throwIfAborted();
        const name = byLower.get(raw.toLowerCase());
        if (!name) {
            out.missing.push({ name: raw, reason: `no set "${raw}" in gs://${bucket}`, nearest: nearestNames(raw, catalog) });
            continue;
        }
        const [files] = await storage.bucket(bucket).getFiles({ prefix: `${name}/` });
        // per role, the smallest file (a set stored at several resolutions downloads its least)
        const chosen = new Map<keyof LibrarySetMaps, { name: string; size: number }>();
        for (const f of files) {
            const role = mapRole(f.name);
            const size = Number(f.metadata.size ?? 0);
            if (role && (!chosen.has(role) || size < chosen.get(role)!.size)) chosen.set(role, { name: f.name, size });
        }
        if (!chosen.has('color')) {
            out.missing.push({ name, reason: `set "${name}" has no colour map in the library (files: ${files.map(f => path.basename(f.name)).slice(0, 8).join(', ')})`, nearest: nearestNames(name, catalog).filter(n => n !== name) });
            continue;
        }
        const dir = path.join(cacheDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const maps: LibrarySetMaps = {};
        for (const [role, f] of chosen) {
            const local = path.join(dir, path.basename(f.name));
            if (!fs.existsSync(local) || fs.statSync(local).size !== f.size) {
                opts.progress?.(`texture library: downloading ${f.name} (${(f.size / 1e6).toFixed(0)} MB, cached for later runs)`);
                const tmp = `${local}.download`;
                await storage.bucket(bucket).file(f.name).download({ destination: tmp });
                fs.renameSync(tmp, local);
            }
            maps[role] = local;
        }
        const entry = indexed.get(name);
        out.sets.push({ name, maps, dir, ...(entry ? { index: entry } : {}) });
    }
    return out;
}
