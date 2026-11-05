/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader on the finished exterior (user decision, 2026-10-30): it reads the photos as the viewer will show them,
 * straightened, filled, de-lit, roof shadows lifted and harmonised (tile-refine-twin.ts), so it is not spent on, or fooled
 * by, the shadows, seams and smears the texture stage takes out. It runs in the twin after harmonising and before the
 * material regions. What it saw (the building's brief, what lies between the windows) is told to the material reads
 * (material-finish.ts, material-choice.ts, material-naming.ts); nothing is drawn from its openings (user decision,
 * 2026-11-05: one material path for every surface, no glass layer).
 *
 * - Each rebuilt facade's own texture in the twin is its straightened photo (facade-lattice.ts), the same size and frame:
 *   harmonised, it takes the photo's place in a copy of the orthos (facades.json, the coverage and occlusion masks kept,
 *   so what tile_refine found blocked is greyed and skipped here as on the photo: occlusion.ts). A facade with no rebuilt
 *   texture keeps its straightened photo, not de-lit (counted).
 * - Every other plane (roofs, terraces, the walls tile_refine did not analyse) is photographed face on (plane-orthos.ts)
 *   from tile_refine's flat scan with its photos swapped for the harmonised ones: the twin appends to the scan's images,
 *   it never reorders them.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { mapLimit } from '../../../../common/map-limit';
import { encodePngAsync, pngCodecThreads } from '../../../png-codec-pool';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { readPlanes, type FacadeAsk, type FacadeReaderFile } from './facade-reader';
import type { NamedBuilding } from './facade-reader-brief';
import type { ModelReadingStore } from './model-readings';
import { planeOrthos } from './plane-orthos';

export const TWIN_READER_VERSION = 'twin-reader/2';

export interface TwinReaderReport {
    dir: string;
    /** Facades read from their harmonised rebuilt texture, and those left on their straightened photo (no rebuilt texture of that size). */
    facadesHarmonised: number; facadesAsPhotographed: number;
    /** Scan photos swapped for their harmonised versions to photograph the other planes. */
    photosHarmonised: number; planes: number;
}

/** The facade each rebuilt facade texture belongs to (the lattice's nodes carry sbFacadeLattice.facadeId): image index by facade. */
function facadeTextures(json: any): Map<number, number> {
    const out = new Map<number, number>();
    for (const n of json.nodes ?? []) {
        const id = n.extras?.sbFacadeLattice?.facadeId;
        if (typeof id !== 'number' || n.mesh === undefined) continue;
        for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
            const t = json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture;
            const src = t !== undefined ? json.textures?.[t.index]?.source : undefined;
            if (typeof src === 'number' && !out.has(id)) out.set(id, src);
        }
    }
    return out;
}

/** tile_refine's flat scan with each of its photos swapped for the harmonised one of the same index and size. */
async function harmonisedScan(flatGlb: Uint8Array, finalImage: Map<number, RgbaImage8>): Promise<{ glb: Uint8Array; swapped: number }> {
    const g = parseGlbBytes(flatGlb);
    const json = JSON.parse(JSON.stringify(g.json));
    const swaps = (json.images ?? []).flatMap((im: any, i: number) => {
        const img = finalImage.get(i);
        if (!img || im.bufferView === undefined) return [];
        const view = json.bufferViews[im.bufferView], raw = g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        // the same photo only: its size as the scan holds it (PNG IHDR or JPEG SOF)
        const size = imageSize(raw);
        return size && size[0] === img.width && size[1] === img.height ? [{ im, img }] : [];
    }) as Array<{ im: { bufferView?: number; mimeType?: string }; img: RgbaImage8 }>;
    // encoded on the codec threads (png-codec-pool.ts), a few at once, then laid into the buffer in image order
    const encoded = await mapLimit(swaps, Math.max(1, pngCodecThreads()), s => encodePngAsync(s.img.width, s.img.height, s.img.rgba, 4));
    const parts: Uint8Array[] = [g.bin];
    let length = g.bin.byteLength;
    const pad = () => { const r = length % 4; if (r) { parts.push(new Uint8Array(4 - r)); length += 4 - r; } };
    swaps.forEach(({ im }, k) => {
        const bytes = encoded[k];
        pad();
        json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
        parts.push(bytes); length += bytes.length;
        im.bufferView = json.bufferViews.length - 1; im.mimeType = 'image/png';
    });
    pad();
    const bin = new Uint8Array(length);
    let o = 0;
    for (const p of parts) { bin.set(p, o); o += p.byteLength; }
    json.buffers = [{ byteLength: length }];
    return { glb: assembleGlb(json, bin), swapped: swaps.length };
}

function imageSize(b: Uint8Array): [number, number] | undefined {
    if (b[0] === 0x89 && b[1] === 0x50) return [(b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0];
    for (let o = 2; o + 9 < b.length;) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1];
        if (m >= 0xc0 && m <= 0xc3) return [(b[o + 7] << 8) | b[o + 8], (b[o + 5] << 8) | b[o + 6]];
        o += 2 + ((b[o + 2] << 8) | b[o + 3]);
    }
    return undefined;
}

/**
 * Reads every plane of the building on the harmonised twin (finalImage, the twin's photos by its own image index; json, its
 * glTF) beside the K orthos, and returns its records (the brief, each plane's zones and what it saw between and in the
 * windows). With `readings`, a plane whose photo is unchanged since an earlier build is answered from the store.
 */
export async function readOnTwin(input: {
    orthosDir: string; flatGlb: string; twinJson: any; finalImage: Map<number, RgbaImage8>;
    ask: FacadeAsk; building?: NamedBuilding; signal?: AbortSignal; progress?: (m: string) => void;
    /** The reader's answers kept between builds (model-readings.ts), and the model they are asked of. */
    readings?: { store: ModelReadingStore; model: string };
}): Promise<{ records: FacadeReaderFile; report: TwinReaderReport }> {
    const key = crypto.createHash('sha256').update(TWIN_READER_VERSION).update(fs.readFileSync(path.join(input.orthosDir, 'facades.json'))).digest('hex').slice(0, 16);
    const dir = path.join(input.orthosDir, `twin_read_${key}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // the facades: their harmonised rebuilt textures in place of their straightened photos, the frames and masks kept
    const facadesFile = JSON.parse(fs.readFileSync(path.join(input.orthosDir, 'facades.json'), 'utf8')) as { facades: Array<{ facadeId: number; image: string; width: number; height: number; uncoveredMask?: string; occludedMask?: string }> };
    const textures = facadeTextures(input.twinJson);
    let facadesHarmonised = 0, facadesAsPhotographed = 0;
    // the textures encoded on the codec threads (png-codec-pool.ts), a few at once
    await mapLimit(facadesFile.facades, Math.max(1, pngCodecThreads()), async f => {
        const src = path.join(input.orthosDir, f.image);
        if (!fs.existsSync(src)) return;
        const ti = textures.get(f.facadeId), img = ti !== undefined ? input.finalImage.get(ti) : undefined;
        if (img && img.width === f.width && img.height === f.height) { fs.writeFileSync(path.join(dir, f.image), await encodePngAsync(img.width, img.height, img.rgba, 4)); facadesHarmonised++; }
        else { fs.copyFileSync(src, path.join(dir, f.image)); facadesAsPhotographed++; }
        for (const m of [f.uncoveredMask, f.occludedMask]) if (m && fs.existsSync(path.join(input.orthosDir, m))) fs.copyFileSync(path.join(input.orthosDir, m), path.join(dir, m));
    });
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify(facadesFile));
    // the other planes, photographed from the flat scan with its photos harmonised
    const scan = await harmonisedScan(fs.readFileSync(input.flatGlb), input.finalImage);
    const scanFile = path.join(dir, 'scan_harmonised.glb');
    fs.writeFileSync(scanFile, scan.glb);
    const po = await planeOrthos(scanFile, dir);
    fs.rmSync(scanFile, { force: true });
    const { records } = await readPlanes(dir, input.ask, { ...(input.signal ? { signal: input.signal } : {}), ...(input.progress ? { progress: input.progress } : {}), ...(input.building ? { building: input.building } : {}), ...(input.readings ? { readings: input.readings } : {}) });
    return { records, report: { dir, facadesHarmonised, facadesAsPhotographed, photosHarmonised: scan.swapped, planes: po.file.planes.length } };
}
