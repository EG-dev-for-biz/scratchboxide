/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The PBR texture library (one folder per material: a preview `<name>.png` and colour / normal / roughness /
 * displacement maps, ambientCG and Poly Haven layouts) and the closest material to a swatch. The library is read from
 * Cloud Storage (gs://, the default: its index.json and small thumbnails are published next to it by
 * publishPbrLibraryIndex, so nothing large is fetched to shortlist) or from a local folder. Two vision steps, the model
 * as the domain engine (no name lists here): a shortlist of PBR_SHORTLIST names from the swatch image and the library's
 * names, then a pick from a numbered contact image of their thumbnails. The shortlist is shuffled before the contact
 * image is drawn, so the order the model named them in cannot decide the pick. A matched material's maps are fetched
 * (and cached) only when asked for.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/** Where the library is unless the caller names one: SCRATCHBOX_PBR_LIBRARY, else the studio's Cloud Storage copy. */
export const DEFAULT_PBR_LIBRARY = 'gs://scoutscan-pbr-library/PBR_Textures_Library';
/** The published index sits beside the library: <library>_index/index.json and <library>_index/thumbs/<name>.jpg. */
export const PBR_INDEX_SUFFIX = '_index';
export const PBR_INDEX_VERSION = 1;
export const PBR_SHORTLIST = 12;
export const PBR_THUMB_PX = 160;
const FONT = '/System/Library/Fonts/Helvetica.ttc';
const CACHE_ROOT = path.join(os.homedir(), '.scratchbox', 'pbr-library-cache');

export function resolvePbrLibrary(given?: string): string {
    return given || process.env.SCRATCHBOX_PBR_LIBRARY || DEFAULT_PBR_LIBRARY;
}

/** The maps of one material, by role, as file names in its folder (the largest resolution and JPG first when several). */
export interface PbrMapFiles { preview?: string; color?: string; normal?: string; roughness?: string; displacement?: string; ao?: string; metalness?: string; arm?: string }

const ROLE_PATTERNS: Array<[keyof PbrMapFiles, RegExp]> = [
    ['color', /(_Color|_diff_|_col_|_albedo|_basecolor)/i], ['normal', /(_NormalGL|_nor_gl)/i], ['roughness', /(_Roughness|_rough)/i],
    ['displacement', /(_Displacement|_disp)/i], ['ao', /(_AmbientOcclusion|_ao_)/i], ['metalness', /(_Metalness|_metal_)/i], ['arm', /_arm_/i]
];
const resolutionOf = (f: string) => { const m = /(\d+)K/i.exec(f); return m ? Number(m[1]) : 0; };

/** Which file plays which role, from a material folder's file names. */
export function mapFilesOf(name: string, files: string[]): PbrMapFiles {
    const images = files.filter(f => /\.(jpe?g|png|exr|tif)$/i.test(f));
    const out: PbrMapFiles = {};
    if (images.includes(`${name}.png`)) out.preview = `${name}.png`;
    for (const [role, re] of ROLE_PATTERNS) {
        const hits = images.filter(f => re.test(f)).sort((a, b) => resolutionOf(b) - resolutionOf(a) || Number(/\.jpe?g$/i.test(b)) - Number(/\.jpe?g$/i.test(a)));
        if (hits.length) out[role] = hits[0];
    }
    return out;
}

/** The bytes of objects under a library location (Cloud Storage or a folder), and writing them (to publish an index). */
export interface PbrObjectStore {
    read(rel: string): Promise<Buffer>;
    write(rel: string, bytes: Buffer, contentType: string): Promise<void>;
    /** Local copy of an object (downloaded into the cache once for Cloud Storage; the file itself for a folder). */
    localCopy(rel: string): Promise<string>;
}

export function gcsObjectStore(uri: string, bucket: { file(name: string): { download(o?: { destination?: string }): Promise<[Buffer] | unknown>; save(b: Buffer, o: unknown): Promise<unknown> } }, cacheDir = path.join(CACHE_ROOT, uri.replace(/[^a-z0-9]+/gi, '_'))): PbrObjectStore {
    const prefix = uri.replace(/^gs:\/\/[^/]+\/?/, '').replace(/\/$/, '');
    const key = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);
    return {
        read: async rel => ((await bucket.file(key(rel)).download()) as [Buffer])[0],
        write: async (rel, bytes, contentType) => { await bucket.file(key(rel)).save(bytes, { contentType, resumable: false }); },
        localCopy: async rel => {
            const dest = path.join(cacheDir, rel);
            if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); await bucket.file(key(rel)).download({ destination: `${dest}.part` }); fs.renameSync(`${dest}.part`, dest); }
            return dest;
        }
    };
}

export function folderObjectStore(root: string): PbrObjectStore {
    return {
        read: async rel => fs.readFileSync(path.join(root, rel)),
        write: async (rel, bytes) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), bytes); },
        localCopy: async rel => path.join(root, rel)
    };
}

/** The bucket and object store of a gs:// location, with the app's Cloud Storage credentials. */
export async function cloudStore(uri: string): Promise<PbrObjectStore> {
    const m = /^gs:\/\/([^/]+)/.exec(uri);
    if (!m) throw new Error(`${uri} is not a gs:// location`);
    const { GoogleMediaCredentialsService } = await import('../google-media-credentials-service');
    return gcsObjectStore(uri, new GoogleMediaCredentialsService().createStorageClient().bucket(m[1]) as never);
}

export interface PbrLibraryIndexFile { version: number; library: string; materials: Array<{ name: string; maps: PbrMapFiles }> }

export interface PbrLibrary {
    location: string;
    names: string[];
    maps(name: string): PbrMapFiles;
    /** Local thumbnail (PBR_THUMB_PX square JPG) of a material. */
    thumb(name: string): Promise<string>;
    /** Local copies of a material's maps (all roles found, or the roles asked for). */
    fetchMaps(name: string, roles?: Array<keyof PbrMapFiles>): Promise<Partial<Record<keyof PbrMapFiles, string>>>;
    /** Where a material's file lives (gs:// URI or a path). */
    uri(name: string, file: string): string;
}

/**
 * Opens the library at `location` (resolvePbrLibrary): a gs:// location through its published index (publishPbrLibraryIndex),
 * or a local folder listed directly (thumbnails made on first use with ffmpeg).
 */
export async function openPbrLibrary(location = resolvePbrLibrary(), opts: { store?: PbrObjectStore; indexStore?: PbrObjectStore; cacheDir?: string } = {}): Promise<PbrLibrary> {
    const remote = location.startsWith('gs://');
    if (remote) {
        const store = opts.store ?? await cloudStore(location);
        const indexStore = opts.indexStore ?? await cloudStore(`${location}${PBR_INDEX_SUFFIX}`);
        let index: PbrLibraryIndexFile;
        try { index = JSON.parse((await indexStore.read('index.json')).toString('utf8')); }
        catch (err) { throw new Error(`no published index for the PBR library at ${location} (${location}${PBR_INDEX_SUFFIX}/index.json: ${(err as Error).message}); run scripts/publish_pbr_library_index.ts`); }
        const byName = new Map(index.materials.map(m => [m.name, m.maps]));
        return {
            location, names: index.materials.map(m => m.name).sort(),
            maps: n => byName.get(n) ?? {},
            thumb: n => indexStore.localCopy(`thumbs/${n}.jpg`),
            fetchMaps: async (n, roles) => fetchRoles(byName.get(n) ?? {}, roles, f => store.localCopy(`${n}/${f}`)),
            uri: (n, f) => `${location}/${n}/${f}`
        };
    }
    if (!fs.existsSync(location)) throw new Error(`no PBR texture library at ${location} (set SCRATCHBOX_PBR_LIBRARY or pass libraryPath)`);
    const thumbsDir = path.join(opts.cacheDir ?? CACHE_ROOT, location.replace(/[^a-z0-9]+/gi, '_'), 'thumbs');
    const byName = new Map<string, PbrMapFiles>();
    for (const d of fs.readdirSync(location, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const maps = mapFilesOf(d.name, fs.readdirSync(path.join(location, d.name)));
        if (maps.preview || maps.color) byName.set(d.name, maps);
    }
    return {
        location, names: [...byName.keys()].sort(),
        maps: n => byName.get(n) ?? {},
        thumb: async n => thumbnailOf(path.join(location, n), byName.get(n) ?? {}, path.join(thumbsDir, `${n}.jpg`)),
        fetchMaps: async (n, roles) => fetchRoles(byName.get(n) ?? {}, roles, async f => path.join(location, n, f)),
        uri: (n, f) => path.join(location, n, f)
    };
}

async function fetchRoles(maps: PbrMapFiles, roles: Array<keyof PbrMapFiles> | undefined, get: (file: string) => Promise<string>): Promise<Partial<Record<keyof PbrMapFiles, string>>> {
    const out: Partial<Record<keyof PbrMapFiles, string>> = {};
    for (const role of roles ?? (Object.keys(maps) as Array<keyof PbrMapFiles>)) { const f = maps[role]; if (f) out[role] = await get(f); }
    return out;
}

/** A material's PBR_THUMB_PX thumbnail from its preview, else its colour map, made once into `out`. */
export async function thumbnailOf(dir: string, maps: PbrMapFiles, out: string): Promise<string> {
    if (fs.existsSync(out)) return out;
    const src = maps.preview ?? maps.color;
    if (!src) throw new Error(`${path.basename(dir)} has no preview or colour map`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, src), '-vf', `scale=${PBR_THUMB_PX}:${PBR_THUMB_PX}`, '-frames:v', '1', out]);
    return out;
}

/**
 * Publishes the index of a library held in a local folder to `indexStore` (the gs://<library>_index location): index.json
 * (every material with a preview or colour map, and its maps by role) and one thumbnail per material. Thumbnails already
 * made (in `thumbsDir`, by an earlier run) are re-used.
 */
export async function publishPbrLibraryIndex(localRoot: string, libraryUri: string, indexStore: PbrObjectStore, opts: { thumbsDir?: string; concurrency?: number; onProgress?: (m: string) => void } = {}): Promise<PbrLibraryIndexFile> {
    const lib = await openPbrLibrary(localRoot, opts.thumbsDir ? { cacheDir: opts.thumbsDir } : {});
    const index: PbrLibraryIndexFile = { version: PBR_INDEX_VERSION, library: libraryUri, materials: lib.names.map(name => ({ name, maps: lib.maps(name) })) };
    let next = 0, done = 0;
    const failed: string[] = [];
    await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, async () => {
        for (let i; (i = next++) < lib.names.length;) {
            const name = lib.names[i];
            try { await indexStore.write(`thumbs/${name}.jpg`, fs.readFileSync(await lib.thumb(name)), 'image/jpeg'); } catch { failed.push(name); }
            if (++done % 200 === 0) opts.onProgress?.(`published ${done} of ${lib.names.length} thumbnails`);
        }
    }));
    index.materials = index.materials.filter(m => !failed.includes(m.name));
    await indexStore.write('index.json', Buffer.from(JSON.stringify(index)), 'application/json');
    return index;
}

/** One generateContent call returning parsed JSON (the caller's Gemini client, Vertex in the app). */
export type JsonVision = (parts: unknown[]) => Promise<any>;

export function geminiJsonVision(client: { models: { generateContent(req: unknown): Promise<{ text?: string }> } }, model = 'gemini-2.5-flash'): JsonVision {
    return async parts => {
        const r = await client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json' } });
        return JSON.parse(r.text ?? '{}');
    };
}

export interface PbrMatch {
    name: string; confidence: number | null; why: string; shortlist: string[];
    /** The material's maps by role: file names, and where each lives (gs:// URI or path). */
    maps: PbrMapFiles; mapUris: Partial<Record<keyof PbrMapFiles, string>>;
    /** Local copies of the maps, when the caller asked for them (fetchMaps). */
    localMaps?: Partial<Record<keyof PbrMapFiles, string>>;
}

/** The library material closest to a swatch image (see the module comment). */
export async function matchSwatchToLibrary(swatch: { photo: string; description: string; sizeMeters: { u: number; v: number } }, library: PbrLibrary, vision: JsonVision, workDir: string, opts: { rand?: () => number; fetchMaps?: boolean | Array<keyof PbrMapFiles> } = {}): Promise<PbrMatch> {
    const rand = opts.rand ?? Math.random;
    const photo = fs.readFileSync(swatch.photo).toString('base64');
    const size = `${swatch.sizeMeters.u.toFixed(1)} x ${swatch.sizeMeters.v.toFixed(1)} m`;
    const s1 = await vision([{ text: `The image is a rectified ${size} swatch of a real building surface ("${swatch.description}"). Below are the names of every material in a PBR texture library. Choose the ${PBR_SHORTLIST} names whose material is most likely to match this surface (same material and pattern). Answer JSON: {"names": [exact names]}.\n\n${library.names.join(', ')}` }, { inlineData: { mimeType: 'image/png', data: photo } }]);
    const known = new Set(library.names);
    const short = [...new Set<string>((s1.names ?? []).filter((n: string) => known.has(n)))].slice(0, PBR_SHORTLIST);
    if (!short.length) throw new Error('the model named no material of the library');
    for (let i = short.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [short[i], short[j]] = [short[j], short[i]]; }
    fs.mkdirSync(workDir, { recursive: true });
    const contact = path.join(workDir, `contact_${path.basename(swatch.photo, path.extname(swatch.photo))}.jpg`);
    const cols = 4, rows = Math.ceil(short.length / cols);
    const labels = short.map((n, i) => `[${i}]drawtext=fontfile=${FONT}:text='${i + 1}':x=6:y=6:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7[l${i}]`);
    const pads = Array.from({ length: rows * cols - short.length }, (_, i) => `color=white:s=${PBR_THUMB_PX}x${PBR_THUMB_PX}[l${short.length + i}]`);
    const grid = [...labels, ...pads].join(';') + ';' + Array.from({ length: rows }, (_, r) => `${Array.from({ length: cols }, (_, c) => `[l${r * cols + c}]`).join('')}hstack=${cols}[r${r}]`).join(';') + ';' + (rows > 1 ? `${Array.from({ length: rows }, (_, r) => `[r${r}]`).join('')}vstack=${rows}` : '[r0]null');
    const thumbs = await Promise.all(short.map(n => library.thumb(n)));
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...thumbs.flatMap(t => ['-i', t]), '-filter_complex', grid, '-frames:v', '1', contact]);
    const s2 = await vision([{ text: `Image 1 is a swatch of a real building surface ("${swatch.description}", ${size}). Image 2 shows ${short.length} library materials, numbered. Which number matches the swatch best by material, pattern, joint layout and colour? Answer JSON: {"number": n, "confidence": 0..1, "why": "<one short sentence>"}` }, { inlineData: { mimeType: 'image/png', data: photo } }, { inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(contact).toString('base64') } }]);
    const k = Math.round(Number(s2.number)) - 1;
    const name = short[k >= 0 && k < short.length ? k : 0];
    const maps = library.maps(name);
    const mapUris = Object.fromEntries(Object.entries(maps).map(([role, f]) => [role, library.uri(name, f as string)]));
    const localMaps = opts.fetchMaps ? await library.fetchMaps(name, Array.isArray(opts.fetchMaps) ? opts.fetchMaps : undefined) : undefined;
    return { name, maps, mapUris, ...(localMaps ? { localMaps } : {}), confidence: typeof s2.confidence === 'number' ? s2.confidence : null, why: String(s2.why ?? ''), shortlist: short };
}
