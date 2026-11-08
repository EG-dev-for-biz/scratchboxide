/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds assets/textures/library/index.json (scratchbox.texture-library/1): one entry per material set in the texture
 * library bucket, holding what costs nothing to know, so texture_library_search can find sets by text and real tile size:
 *
 *   - the sets and their maps (colour, normal, roughness, occlusion, metalness, packed ARM and height): the bucket
 *     listing (the app's service account);
 *   - real tile sizes, tags, descriptions and preview links: the publishers' public metadata (ambientCG API v2,
 *     dimensions in cm; Poly Haven API, dimensions in mm), and the height map's real depth where a publisher gives one
 *     (a third dimension; neither gave one for any set on 2026-11-05, so the depths are estimated and labelled:
 *     scripts/measure_texture_library_heights.ts).
 *
 * No image is downloaded. Colour, roughness and metalness are measured later, on demand, only for the sets a search
 * ranks (texture-library.ts measureLibraryEntries), and cached per set.
 *
 *   npx vite-node scripts/build_texture_library_index.ts [--only Set1,Set2]
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoogleMediaCredentialsService } from '../packages/core/src/node/google-media-credentials-service';
import { libraryBucket, mapRole, type LibrarySetMaps } from '../packages/core/src/node/3d-engine/texture-library';
import { TEXTURE_LIBRARY_SCHEMA, type TextureLibraryEntry, type TextureLibraryIndex } from '../packages/core/src/common/spatial/texture-library-index';

const repoRoot = path.resolve(__dirname, '..');
const outFile = path.join(repoRoot, 'assets/textures/library/index.json');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('only')?.split(',').map(s => s.trim()).filter(Boolean);

interface Meta { publisher: string; realSizeM?: [number, number]; widthOnlyM?: number; /** The publisher's own depth of the height map, metres, when it gives one. */ depthM?: number; pixels?: [number, number]; tags: string[]; appearance: string; previews: TextureLibraryEntry['previews'] }

async function json<T>(url: string): Promise<T> {
    for (let i = 1; ; i++) {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
            return await r.json() as T;
        } catch (err) {
            if (i >= 4) throw err;
            await new Promise(res => setTimeout(res, 1000 * 2 ** i));
        }
    }
}

/** ambientCG: every asset, paged; dimensions are centimetres; the preview maps sit in the 3D-preview link's query. */
async function ambientCG(): Promise<Map<string, Meta>> {
    const out = new Map<string, Meta>();
    for (let offset = 0; ; offset += 250) {
        const page = await json<{ numberOfResults: number; foundAssets: Array<Record<string, any>> }>(`https://ambientcg.com/api/v2/full_json?limit=250&offset=${offset}&include=dimensionsData,tagData,displayData`);
        for (const a of page.foundAssets) {
            const link = (a.previewLinks as Array<{ url: string }> | undefined)?.find(l => l.url.includes('color_url='))?.url ?? '';
            const param = (k: string) => { const m = new RegExp(`${k}_url=([^&]+)`).exec(link); return m ? m[1].replace(/\?.*$/, '') : undefined; };
            const x = Number(a.dimensionX), y = Number(a.dimensionY), z = Number(a.dimensionZ);
            const previews: Meta['previews'] = {};
            for (const role of ['color', 'normal', 'roughness', 'metalness'] as const) { const u = param(role); if (u) previews[role] = u; }
            const disp = param('displacement');
            if (disp) previews.height = disp;
            out.set(a.assetId, {
                publisher: 'ambientCG',
                ...(x > 0 && y > 0 ? { realSizeM: [x / 100, y / 100] as [number, number] } : x > 0 ? { widthOnlyM: x / 100 } : {}),
                ...(z > 0 ? { depthM: z / 100 } : {}),
                tags: (a.tags ?? []).filter((t: string) => !/^\d+$/.test(t)),
                appearance: [a.displayName, a.displayCategory, a.description, a.creationMethodName].filter(Boolean).join('. '),
                previews
            });
        }
        if (offset + 250 >= page.numberOfResults) break;
    }
    return out;
}

/** Poly Haven: textures; dimensions are millimetres. Its preview maps are looked up per set when one is measured. */
async function polyHaven(): Promise<Map<string, Meta>> {
    const all = await json<Record<string, Record<string, any>>>('https://api.polyhaven.com/assets?t=textures');
    const out = new Map<string, Meta>();
    for (const [id, a] of Object.entries(all)) {
        const [w, h, d] = (a.dimensions ?? []) as number[];
        out.set(id, {
            publisher: 'Poly Haven',
            ...(w > 0 && h > 0 ? { realSizeM: [w / 1000, h / 1000] as [number, number] } : {}),
            ...(d > 0 ? { depthM: d / 1000 } : {}),
            ...(Array.isArray(a.max_resolution) ? { pixels: a.max_resolution as [number, number] } : {}),
            tags: [...(a.tags ?? []), ...(a.categories ?? [])],
            appearance: [a.name, a.category, a.description].filter(Boolean).join('. '),
            previews: undefined
        });
    }
    return out;
}

async function main(): Promise<void> {
    const bucket = libraryBucket();
    const storage = new GoogleMediaCredentialsService().createStorageClient();
    console.log(`listing gs://${bucket} ...`);
    const [files] = await storage.bucket(bucket).getFiles({ autoPaginate: true });
    const sets = new Map<string, { maps: LibrarySetMaps; sizes: Record<string, number>; pixelsToken?: string }>();
    for (const f of files) {
        const [set] = f.name.split('/');
        if (!f.name.includes('/') || (only && !only.includes(set))) continue;
        const s = sets.get(set) ?? { maps: {}, sizes: {} };
        sets.set(set, s);
        const role = mapRole(f.name);
        const size = Number(f.metadata.size ?? 0);
        if (role && (!(role in s.sizes) || size < s.sizes[role])) { s.maps[role] = f.name; s.sizes[role] = size; }
        const res = /_(\d+)[Kk][-_]/.exec(path.basename(f.name));
        if (res && role) s.pixelsToken = res[1];
    }
    console.log(`${sets.size} sets; fetching publisher metadata ...`);
    const [acg, ph] = await Promise.all([ambientCG(), polyHaven()]);

    const entries: TextureLibraryEntry[] = [...sets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => {
        const meta = acg.get(id) ?? ph.get(id);
        const notes: string[] = [];
        if (!meta) notes.push('its publisher no longer lists it: no real size, tags or preview to measure');
        else if (!meta.realSizeM) notes.push(meta.widthOnlyM ? 'its publisher gives only a width: the height follows from the preview\'s aspect once measured' : 'its publisher gives no real size: a script must estimate tile_m');
        if (!s.maps.color) notes.push('no colour map in the bucket: it cannot be used as a surface');
        // the long side from the file names; the other side follows from the preview's aspect once measured
        const long = s.pixelsToken ? Number(s.pixelsToken) * 1024 : undefined;
        return {
            id,
            publisher: meta?.publisher ?? (/^[A-Z]/.test(id) ? 'ambientCG' : 'Poly Haven'),
            maps: s.maps,
            // the height map is fetched only on request (fetchLibrarySets `height`): not part of a set's usual download
            downloadMB: Math.round(Object.entries(s.sizes).filter(([role]) => role !== 'height').reduce((a, [, b]) => a + b, 0) / 1e6),
            ...(meta?.pixels ? { pixels: meta.pixels } : long ? { pixels: [long, long] as [number, number] } : {}),
            ...(meta?.realSizeM ? { realSizeM: meta.realSizeM.map(v => Math.round(v * 1000) / 1000) as [number, number] } : {}),
            ...(meta?.widthOnlyM && !meta.realSizeM ? { widthOnlyM: meta.widthOnlyM } : {}),
            sizeSource: meta?.realSizeM ? `${meta.publisher} metadata` : 'unknown',
            ...(meta?.depthM && s.maps.height ? { heightDepthM: Math.round(meta.depthM * 1e4) / 1e4, heightDepthSource: `${meta.publisher} metadata` } : {}),
            ...(meta?.previews && Object.keys(meta.previews).length ? { previews: meta.previews } : {}),
            appearance: meta?.appearance || id,
            tags: meta?.tags ?? [],
            provenance: 'library' as const,
            ...(notes.length ? { notes } : {})
        };
    });
    const index: TextureLibraryIndex = {
        schema: TEXTURE_LIBRARY_SCHEMA,
        about: 'The texture library bucket\'s material sets with their publishers\' metadata (real tile size, text, preview links), for texture_library_search. Colour and finish are measured on demand for the sets a search ranks and cached under build/texture-library/stats/. appearance and tags are publisher text for reading and text search; nothing branches on them.',
        bucket, builtAt: new Date().toISOString(), sets: entries
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    // one set per line: small diffs when the library changes
    fs.writeFileSync(outFile, JSON.stringify({ ...index, sets: [] }, null, 1).replace('"sets": []', `"sets": [\n${entries.map(e => '  ' + JSON.stringify(e)).join(',\n')}\n ]`) + '\n');
    const sized = entries.filter(e => e.realSizeM).length, widthOnly = entries.filter(e => e.widthOnlyM).length, colourMap = entries.filter(e => e.maps.color).length;
    console.log(`wrote ${outFile}: ${entries.length} sets, ${colourMap} with a colour map, ${sized} with a real size (+${widthOnly} width only)`);
}

main().catch(err => { console.error(err); process.exit(1); });
