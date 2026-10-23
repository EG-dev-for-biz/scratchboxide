/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The local PBR texture library (one folder per material: a preview `<name>.png` and colour / normal / roughness /
 * displacement maps, ambientCG and Poly Haven layouts) and the closest material to a swatch. Two vision steps, the model
 * as the domain engine (no name lists here): a shortlist of PBR_SHORTLIST names from the swatch image and the library's
 * names, then a pick from a numbered contact image of their thumbnails. The shortlist is shuffled before the contact
 * image is drawn, so the order the model named them in cannot decide the pick. Thumbnails are cached per library.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/** Where the library is unless the caller names one: SCRATCHBOX_PBR_LIBRARY, else the studio's RAID copy. */
export const DEFAULT_PBR_LIBRARY = '/Volumes/G-RAID MIRROR/PBR_Textures_Library';
export const PBR_SHORTLIST = 12;
export const PBR_THUMB_PX = 160;
const FONT = '/System/Library/Fonts/Helvetica.ttc';

export function resolvePbrLibrary(given?: string): string {
    const root = given || process.env.SCRATCHBOX_PBR_LIBRARY || DEFAULT_PBR_LIBRARY;
    if (!fs.existsSync(root)) throw new Error(`no PBR texture library at ${root} (set SCRATCHBOX_PBR_LIBRARY or pass libraryPath)`);
    return root;
}

/** A material folder's colour map: its preview first, else the first colour / diffuse map. */
export function colourMapOf(dir: string): string | undefined {
    const name = path.basename(dir);
    const preview = path.join(dir, `${name}.png`);
    if (fs.existsSync(preview)) return preview;
    const files = fs.readdirSync(dir).sort();
    const pick = files.find(f => /_Color\.(jpg|png)$/i.test(f)) ?? files.find(f => /_diff_.*\.(jpg|png)$/i.test(f)) ?? files.find(f => /_col.*\.(jpg|png)$/i.test(f));
    return pick ? path.join(dir, pick) : undefined;
}

export interface PbrLibraryIndex { root: string; names: string[]; thumbs: Map<string, string> }

/** Every material of `root` with a colour map, thumbnailed once into `cacheDir` (re-used on later calls). */
export async function indexPbrLibrary(root: string, cacheDir = path.join(os.homedir(), '.scratchbox', 'pbr-library-thumbs'), concurrency = 8, onProgress?: (m: string) => void): Promise<PbrLibraryIndex> {
    const dir = path.join(cacheDir, Buffer.from(root).toString('base64url').slice(0, 40));
    fs.mkdirSync(dir, { recursive: true });
    const folders = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const thumbs = new Map<string, string>();
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        for (let i; (i = next++) < folders.length;) {
            if (i % 200 === 0) onProgress?.(`indexing the PBR library: ${i} of ${folders.length} materials`);
            const name = folders[i], out = path.join(dir, `${name}.jpg`);
            if (fs.existsSync(out)) { thumbs.set(name, out); continue; }
            const src = colourMapOf(path.join(root, name));
            if (!src) continue;
            try { await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${PBR_THUMB_PX}:${PBR_THUMB_PX}`, '-frames:v', '1', out]); thumbs.set(name, out); } catch { /* an unreadable map leaves the material out */ }
        }
    }));
    return { root, names: [...thumbs.keys()].sort(), thumbs };
}

/** One generateContent call returning parsed JSON (the caller's Gemini client, Vertex in the app). */
export type JsonVision = (parts: unknown[]) => Promise<any>;

export function geminiJsonVision(client: { models: { generateContent(req: unknown): Promise<{ text?: string }> } }, model = 'gemini-2.5-flash'): JsonVision {
    return async parts => {
        const r = await client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json' } });
        return JSON.parse(r.text ?? '{}');
    };
}

export interface PbrMatch { name: string; folder: string; colourMap: string; confidence: number | null; why: string; shortlist: string[] }

/** The library material closest to a swatch image (see the module comment). */
export async function matchSwatchToLibrary(swatch: { photo: string; description: string; sizeMeters: { u: number; v: number } }, index: PbrLibraryIndex, vision: JsonVision, workDir: string, rand: () => number = Math.random): Promise<PbrMatch> {
    const photo = fs.readFileSync(swatch.photo).toString('base64');
    const size = `${swatch.sizeMeters.u.toFixed(1)} x ${swatch.sizeMeters.v.toFixed(1)} m`;
    const s1 = await vision([{ text: `The image is a rectified ${size} swatch of a real building surface ("${swatch.description}"). Below are the names of every material in a PBR texture library. Choose the ${PBR_SHORTLIST} names whose material is most likely to match this surface (same material and pattern). Answer JSON: {"names": [exact names]}.\n\n${index.names.join(', ')}` }, { inlineData: { mimeType: 'image/png', data: photo } }]);
    const short = [...new Set<string>((s1.names ?? []).filter((n: string) => index.thumbs.has(n)))].slice(0, PBR_SHORTLIST);
    if (!short.length) throw new Error('the model named no material of the library');
    for (let i = short.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [short[i], short[j]] = [short[j], short[i]]; }
    fs.mkdirSync(workDir, { recursive: true });
    const contact = path.join(workDir, `contact_${path.basename(swatch.photo, path.extname(swatch.photo))}.jpg`);
    const cols = 4, rows = Math.ceil(short.length / cols);
    const labels = short.map((n, i) => `[${i}]drawtext=fontfile=${FONT}:text='${i + 1}':x=6:y=6:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7[l${i}]`);
    const pads = Array.from({ length: rows * cols - short.length }, (_, i) => `color=white:s=${PBR_THUMB_PX}x${PBR_THUMB_PX}[l${short.length + i}]`);
    const grid = [...labels, ...pads].join(';') + ';' + Array.from({ length: rows }, (_, r) => `${Array.from({ length: cols }, (_, c) => `[l${r * cols + c}]`).join('')}hstack=${cols}[r${r}]`).join(';') + ';' + (rows > 1 ? `${Array.from({ length: rows }, (_, r) => `[r${r}]`).join('')}vstack=${rows}` : '[r0]null');
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...short.flatMap(n => ['-i', index.thumbs.get(n)!]), '-filter_complex', grid, '-frames:v', '1', contact]);
    const s2 = await vision([{ text: `Image 1 is a swatch of a real building surface ("${swatch.description}", ${size}). Image 2 shows ${short.length} library materials, numbered. Which number matches the swatch best by material, pattern, joint layout and colour? Answer JSON: {"number": n, "confidence": 0..1, "why": "<one short sentence>"}` }, { inlineData: { mimeType: 'image/png', data: photo } }, { inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(contact).toString('base64') } }]);
    const k = Math.round(Number(s2.number)) - 1;
    const name = short[k >= 0 && k < short.length ? k : 0];
    const folder = path.join(index.root, name);
    return { name, folder, colourMap: colourMapOf(folder) ?? index.thumbs.get(name)!, confidence: typeof s2.confidence === 'number' ? s2.confidence : null, why: String(s2.why ?? ''), shortlist: short };
}
