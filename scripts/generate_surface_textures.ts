/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generates the surface texture library (surface-texture-generator.ts) into the durable asset store, next to the GLBs:
 * each map at /models/surfaces/<id>/<map>.jpg, the index at /models/surfaces/index.json, each entry with its recipe so it
 * can be made again. Real model calls (billed); never run from tests.
 *
 *   tsx --env-file=.env scripts/generate_surface_textures.ts [--only id,id] [--out dir] [--concurrency 4]
 *
 * Entries already in the stored index and not generated this run are kept; an entry that fails is removed from it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { STREETVIEW_GEMINI_MODEL } from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import { PanoramaDepthService } from '../packages/core/src/node/spatial/PanoramaDepthService';
import { GoogleMediaCredentialsService } from '../packages/core/src/node/google-media-credentials-service';
import { generateImageWithModels } from '../packages/core/src/node/google-media-generation-service';
import { IMAGE_MODEL_PRIORITY } from '../packages/core/src/common/media-generation-protocol';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../packages/core/src/node/image-codec-ffmpeg';
import { resampleRgba } from '../packages/core/src/node/texture-processing';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { defaultDurableAssetStore } from '../packages/core/src/node/asset-store/durable-asset-store';
import { generateSurfaceTexture, type SurfaceTextureModels, type SurfaceTextureSpec } from '../packages/core/src/node/3d-engine/surface-texture-generator';
import { SURFACE_TEXTURE_SCHEMA, validateSurfaceTextureIndex, type SurfaceTextureEntry, type SurfaceTextureIndex } from '../packages/core/src/common/spatial/surface-texture-library';

export const SURFACES_SERVED_DIR = '/models/surfaces';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const specs = (JSON.parse(fs.readFileSync(path.join(__dirname, 'surface-textures', 'specs.json'), 'utf8')).surfaces as SurfaceTextureSpec[]);
    const only = arg('only')?.split(',').map(s => s.trim()).filter(Boolean);
    const todo = only ? specs.filter(s => only.includes(s.id)) : specs;
    const out = path.resolve(arg('out') ?? path.join(process.cwd(), '.scratchbox', 'surface-textures'));
    const concurrency = Math.max(1, Number(arg('concurrency') ?? 4));
    // the app's own Vertex credentials (the image models are served there)
    const client: any = await new GoogleMediaCredentialsService().createVertexClient();
    const store = defaultDurableAssetStore();
    if (!store) throw new Error('The durable asset store is off (SCRATCHBOX_ASSET_STORE=0)');

    fs.mkdirSync(out, { recursive: true });
    const depthService = new PanoramaDepthService(undefined, { timeoutMs: 600_000 });
    const png = (img: { rgba: Uint8Array; width: number; height: number }) => encodePng(img.width, img.height, img.rgba, 4).toString('base64');
    const models: SurfaceTextureModels = {
        async paint(prompt, aspectRatio) {
            const a = await generateImageWithModels(client, { models: IMAGE_MODEL_PRIORITY, contents: [{ role: 'user', parts: [{ text: prompt }] }], imageConfig: { aspectRatio, imageSize: '2K' } });
            const d = await decodeImageToRgba(a.data);
            if (process.env.SURFACE_DEBUG_DIR) { fs.mkdirSync(process.env.SURFACE_DEBUG_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SURFACE_DEBUG_DIR, `${Date.now()}_${prompt.slice(0, 24).replace(/\W+/g, '_')}.png`), encodePng(d.width, d.height, new Uint8Array(d.rgba), 4)); }
            return { rgba: new Uint8Array(d.rgba), width: d.width, height: d.height, model: a.modelUsed };
        },
        async depth(image) {
            const dir = fs.mkdtempSync(path.join(out, '.depth-'));
            try {
                const file = path.join(dir, 'in.png');
                fs.writeFileSync(file, encodePng(image.width, image.height, image.rgba, 4));
                const r = await depthService.generateImageDepth(file, { outDir: dir });
                if (r.width !== image.width || r.height !== image.height) throw new Error(`depth came back ${r.width}x${r.height}, wanted ${image.width}x${image.height}`);
                return { depths: r.depths, model: r.modelUsed };
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        async read(prompt, image) {
            const r = await client.models.generateContent({ model: STREETVIEW_GEMINI_MODEL, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png(image) } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } });
            return r.text ?? '';
        },
        resize: (rgba, w, h, size) => new Uint8Array(resampleRgba(Buffer.from(rgba), w, h, size, size))
    };

    const stored = store.lookup(`${SURFACES_SERVED_DIR}/index.json`);
    const previous: SurfaceTextureIndex | undefined = stored ? JSON.parse(fs.readFileSync(stored.file, 'utf8')) : undefined;
    const entries = new Map<string, SurfaceTextureEntry>((previous?.surfaces ?? []).map(e => [e.id, e]));
    const failures: string[] = [];
    const queue = [...todo];
    const worker = async () => {
        for (let spec = queue.shift(); spec; spec = queue.shift()) {
            const t0 = Date.now();
            try {
                const g = await generateSurfaceTexture(spec, models);
                const dir = path.join(out, spec.id);
                fs.mkdirSync(dir, { recursive: true });
                const recipeId = `surface-texture:${spec.id}:${crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)}`;
                store.putRecipe({ id: recipeId, kind: 'surface-texture', body: { spec, script: 'scripts/generate_surface_textures.ts', source: g.entry.source } });
                const maps: SurfaceTextureEntry['maps'] = { color: '', normal: '', roughness: '' };
                for (const [key, rgba, q] of [['color', g.color, 90], ['normal', g.normal, 95], ['roughness', g.roughness, 90], ['height', g.height, 92]] as const) {
                    const file = path.join(dir, `${key}.jpg`);
                    fs.writeFileSync(file, await encodeRgbaToJpeg(rgba, g.size, g.size, { quality: q, chroma: key === 'color' ? '420' : '444' }));
                    store.putFile(file, { servedPath: `${SURFACES_SERVED_DIR}/${spec.id}/${key}.jpg`, origin: 'surface-texture-library', recipeId });
                    maps[key] = `${spec.id}/${key}.jpg`;
                }
                entries.set(spec.id, { ...g.entry, maps });
                console.log(JSON.stringify({ id: spec.id, s: Math.round((Date.now() - t0) / 1000), wrapBefore: +g.wrapBefore.toFixed(2), wrapAfter: +g.wrapAfter.toFixed(2), alignment: g.entry.heightAlignment, sizeM: g.entry.realSizeM, reliefM: g.entry.surface.reliefM, roughness: g.entry.surface.roughnessMean, critique: g.entry.critique, appearance: g.entry.appearance }));
            } catch (e) {
                // a failed entry leaves the index (its earlier version failed the same standard or was never judged by it)
                entries.delete(spec.id);
                failures.push(`${spec.id}: ${(e as Error).message}`);
                console.log(JSON.stringify({ id: spec.id, failed: (e as Error).message }));
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

    const index: SurfaceTextureIndex = {
        schema: SURFACE_TEXTURE_SCHEMA,
        about: 'Tileable surface materials for procedural rebuilds (ground, carriageways, walls, decks, roofs), chosen by appearance and real-world scale and tinted to the colour measured at the place. Generated by an image model (labelled generated, with model and prompt); described by continuous quantities only; appearance is for a model to read and is never branched on.',
        conventions: {
            colour: 'meanLinearRgb / spreadLinearRgb: mean and standard deviation of linear sRGB (Rec. 709, D65) over all pixels; meanLab / spreadLab: CIELAB (D65); meanLuminance: Rec. 709 Y.',
            tiling: 'Every map tiles: its seams were moved to the centre by a half offset and repaired there, so its edges are its own interior.',
            uv: 'UV origin bottom-left, v up (flipY). One tile spans realSizeM metres (x, y).',
            normal: 'Tangent space, OpenGL convention (+y up the image), from the height map at reliefM over realSizeM.',
            realSizeM: 'A vision reading of the texture\'s own features (brick, sett, slab, blade, stone); the size asked for is in sizeSource.',
            storage: 'Kept in the durable asset store next to the GLBs: /models/surfaces/<map path>; builds embed the maps they use in their GLB.'
        },
        surfaces: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
    const problems = validateSurfaceTextureIndex(index);
    if (problems.length) throw new Error(`index invalid: ${problems.join('; ')}`);
    fs.mkdirSync(out, { recursive: true });
    const indexFile = path.join(out, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
    store.putFile(indexFile, { servedPath: `${SURFACES_SERVED_DIR}/index.json`, origin: 'surface-texture-library' });
    console.log(JSON.stringify({ entries: index.surfaces.length, generated: todo.length - failures.length, failures, out }));
    if (failures.length) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
