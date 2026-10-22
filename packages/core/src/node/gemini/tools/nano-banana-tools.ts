/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    buildApplyPalettePrompt,
    validateExtractedPalette,
    type ExtractedColorPalette
} from '../../../browser/generative-canvas/services/nano-banana-color-service';
import * as fs from 'fs-extra';
import * as path from 'path';
import { InvalidInputError, MediaModelUnavailableError, MissingInputError } from '../../../common/errors/pipeline-errors';
import {
    IMAGE_MODEL_ALIASES,
    IMAGE_MODEL_ASPECT_RATIOS,
    IMAGE_MODEL_PRIORITY,
    resolveRequestedModels,
    type SkippedMediaModel
} from '../../../common/media-generation-protocol';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import { generateImageWithModels } from '../../google-media-generation-service';
import { readImageDimensions, sniffImageFormat } from '../../image-codec-ffmpeg';
import { defaultDurableAssetStore } from '../../asset-store/durable-asset-store';
import type { ToolDeclaration, ToolHandler } from './types';
import { infillImageHoles } from '../../image-hole-infill';
import { bakeGritDecal, generateGritMap, GRIT_DEFAULT_STRENGTH } from '../../3d-engine/grit-decal';
import { readTileTriangles } from '../../3d-engine/staged-location/tile-texture-transfer';
import { genAiEnhanceClient } from '../../3d-engine/staged-location/texture-enhance';
import { decodeImageInMemory } from '../../3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../../texture-processing';

const TOOL = 'nano_banana_apply_color_palette';

/**
 * Reads an input image for an image-model call: a data URI, an http(s) URL, or a file path (relative paths resolve
 * against the workspace). `tool` and `arg` name the caller in the error when the image cannot be read.
 */
async function loadInputImage(
    ref: string,
    workspaceRoot: string | undefined,
    signal: AbortSignal | undefined,
    tool: string,
    arg: string
): Promise<{ data: Buffer; mimeType: string; localPath?: string }> {
    const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(ref);
    let data: Buffer;
    let localPath: string | undefined;
    if (dataUri) {
        data = dataUri[2] ? Buffer.from(dataUri[3], 'base64') : Buffer.from(decodeURIComponent(dataUri[3]), 'binary');
    } else if (/^https?:\/\//i.test(ref)) {
        let res: Response;
        try {
            res = await fetch(ref, { signal });
        } catch (err) {
            throw new MissingInputError(tool, arg, `could not download ${ref} (${(err as Error).message})`);
        }
        if (!res.ok) throw new MissingInputError(tool, arg, `downloading ${ref} answered HTTP ${res.status}`);
        data = Buffer.from(await res.arrayBuffer());
    } else {
        localPath = path.isAbsolute(ref) ? ref : path.resolve(workspaceRoot || process.cwd(), ref);
        if (!(await fs.pathExists(localPath))) throw new MissingInputError(tool, arg, `no file at ${localPath}`);
        data = await fs.readFile(localPath);
    }
    const format = sniffImageFormat(data);
    if (format === 'unknown') throw new MissingInputError(tool, arg, `${ref.slice(0, 80)} is not a JPEG, PNG or WebP image`);
    return { data, mimeType: `image/${format}`, localPath };
}

/** The palette tool's target image. */
function loadTargetImage(ref: string, workspaceRoot: string | undefined, signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string; localPath?: string }> {
    return loadInputImage(ref, workspaceRoot, signal, TOOL, 'targetImageUrl');
}

function extensionFor(mimeType: string): string {
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'image/webp') return '.webp';
    return '.png';
}

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asBoolean(val: unknown, defaultVal = false): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return defaultVal;
}

/**
 * The palette exactly as the caller gave it (an object or its JSON text). Every part the application prompt maps is
 * required; temperatures and contrast are the caller's own words. Nothing is filled in.
 */
function requireCompletePalette(raw: unknown): ExtractedColorPalette {
    const tool = 'nano_banana_apply_color_palette';
    let palette: unknown = raw;
    if (typeof raw === 'string') {
        try {
            palette = JSON.parse(raw);
        } catch {
            throw new MissingInputError(tool, 'palette', 'give the palette as a JSON object (primaryTones, accentTones, shadowProfile, highlightProfile, lightingAtmosphere), not free text');
        }
    }
    return validateExtractedPalette(palette, tool);
}

export const NANO_BANANA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'nano_banana_apply_color_palette',
        description: 'Recolors a target image to a given color palette with an image model (Nano Banana), using a global color override prompt that asks the model to keep the geometry and composition unchanged (Method 2 Step 2). Writes the edited image to disk and returns its path, the model that answered and the prompt sent. The palette must be complete (read it from the reference image yourself): it is used as given, never filled in. Fails with an error when no image model is available.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetImageUrl: {
                    type: 'STRING',
                    description: 'URL, base64 data URI, or local filepath of the target image whose geometry/structure will be preserved.'
                },
                palette: {
                    type: 'OBJECT',
                    description: 'Complete palette object: primaryTones and accentTones ([{ name, hex: "#RRGGBB", role? }], at least one each), shadowProfile and highlightProfile ({ tone, temperature, hex? }, the temperature in your own words, e.g. "cool", "warm-neutral", "5600K"), lightingAtmosphere (sentence) and optionally contrastProfile.'
                },
                preserveSkinTones: {
                    type: 'BOOLEAN',
                    description: 'When true, protects natural human facial and skin tones from unnatural color shifting.'
                },
                contrastCurve: {
                    type: 'STRING',
                    description: 'Optional contrast grading in your own words ("cinematic", "natural", "high-contrast" and "muted" have written-out directives). When omitted the palette\'s contrastProfile is used; with neither, no contrast directive is added.'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Optional aspect ratio of the output canvas (e.g. "16:9"). When omitted the prompt asks to keep the target image\'s own aspect ratio.'
                },
                targetFocusArea: {
                    type: 'STRING',
                    description: 'Optional selective recoloring region (e.g. "entire image", "background only", "wardrobe only").'
                },
                customInstructions: {
                    type: 'STRING',
                    description: 'Optional additional artistic styling directives or mood modifiers.'
                },
                model: {
                    type: 'STRING',
                    description: 'Optional image model id. When given, only that model is used; otherwise the default image models are tried in order. The result names the model that answered.'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Optional output file path (relative paths resolve against the workspace). Default: next to a local target as <name>_palette.<ext>, else palette_applied_<timestamp>.<ext> in the workspace.'
                }
            },
            required: ['targetImageUrl', 'palette']
        }
    }
];

export const nanoBananaHandlers: Record<string, ToolHandler> = {
    nano_banana_apply_color_palette: async (args, ctx) => {
        const targetImageUrl = asString(args.targetImageUrl);
        if (!targetImageUrl) throw new MissingInputError(TOOL, 'targetImageUrl', 'give the image to recolor');
        if (args.palette === undefined || args.palette === null || args.palette === '') {
            throw new MissingInputError(TOOL, 'palette', 'give the complete palette to apply');
        }
        const palette = requireCompletePalette(args.palette);

        const preserveSkinTones = asBoolean(args.preserveSkinTones, false);
        const contrastCurve = asString(args.contrastCurve) || undefined;
        const aspectRatio = asString(args.aspectRatio) || undefined;
        const targetFocusArea = asString(args.targetFocusArea) || undefined;
        const customInstructions = asString(args.customInstructions) || undefined;

        const applicationPrompt = buildApplyPalettePrompt({
            targetImageUrl,
            palette,
            preserveSkinTones,
            contrastCurve,
            aspectRatio,
            targetFocusArea,
            customInstructions
        });

        const target = await loadTargetImage(targetImageUrl, ctx?.workspaceRoot, ctx?.signal);
        const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
        let client: any;
        try {
            client = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const answer = await generateImageWithModels(client, {
            models,
            contents: [
                { text: applicationPrompt },
                { inlineData: { data: target.data.toString('base64'), mimeType: target.mimeType } }
            ],
            ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
            signal: ctx?.signal
        });

        const ext = extensionFor(answer.mimeType);
        const requestedOut = asString(args.outputPath);
        const outputPath = requestedOut
            ? (path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedOut))
            : target.localPath
                ? path.join(path.dirname(target.localPath), `${path.basename(target.localPath, path.extname(target.localPath))}_palette${ext}`)
                : path.join(ctx?.workspaceRoot || process.cwd(), `palette_applied_${Date.now()}${ext}`);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, answer.data);
        const dims = readImageDimensions(answer.data);

        return {
            resultPayload: {
                success: true,
                targetImageUrl,
                outputPath,
                mimeType: answer.mimeType,
                ...(dims ? { width: dims.width, height: dims.height } : {}),
                modelUsed: answer.modelUsed,
                skippedModels: answer.skippedModels,
                modelNote: answer.modelNote,
                applicationPrompt,
                preserveSkinTones,
                contrastCurve,
                aspectRatio
            },
            summaryResult: `Recolored ${targetImageUrl} to the palette (${palette.primaryTones.length} base and ${palette.accentTones.length} accent tones) with ${answer.modelUsed} -> ${outputPath}. ${answer.modelNote}`
        };
    }
};

// ----------------------------------------------------------------------
// generate_image: pictures from a prompt (storyboard frames, concept art, references, edits of a given image)
// ----------------------------------------------------------------------

const GENERATE_IMAGE = 'generate_image';

/** The most images one call makes; each is its own billed model call. */
export const GENERATE_IMAGE_MAX_COUNT = 4;

/** Where generate_image writes by default, under the repository root: gitignored (`build/`) and served by the app. */
export const GENERATED_IMAGES_DIR = 'build/generated-images';

/** The URL prefix the app serves GENERATED_IMAGES_DIR at (desktop-app/server/app.ts; the Vite dev server proxies /build). */
export const GENERATED_IMAGES_ROUTE = '/build/generated-images/';

/** The Nano Banana Lite model id: faster and cheaper than the default list, used when the caller asks for speed. */
export const FAST_IMAGE_MODEL = IMAGE_MODEL_ALIASES['nano-banana-lite'];

/** The repository root: the nearest ancestor of this module that holds packages/core and a package.json (as the Python runner finds it). */
export function resolveRepoRoot(): string {
    let cur = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, 'packages/core')) && fs.existsSync(path.join(cur, 'package.json'))) {
            return cur;
        }
        cur = path.dirname(cur);
    }
    return process.cwd();
}

/**
 * The URL the app serves an image file at, when the file is inside GENERATED_IMAGES_DIR (any depth). Undefined for a
 * file written anywhere else: the app has no route for it, and the result says so instead of inventing a URL.
 */
export function servedGeneratedImageUrl(filePath: string, repoRoot: string = resolveRepoRoot()): string | undefined {
    const dir = path.resolve(repoRoot, GENERATED_IMAGES_DIR);
    const rel = path.relative(dir, path.resolve(filePath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return GENERATED_IMAGES_ROUTE + rel.split(path.sep).map(encodeURIComponent).join('/');
}

/** A file-name stem from the caller's name or the prompt's first words: ASCII letters, digits and underscores only. */
function imageFileStem(name: string | undefined, prompt: string): string {
    const source = (name || prompt.split(/\s+/).slice(0, 6).join(' ')).toLowerCase();
    const stem = source.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return stem || 'image';
}

function asStringList(val: unknown): string[] {
    if (typeof val === 'string') return val.trim() ? [val.trim()] : [];
    if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
    return [];
}

/** A generated image, as the tool reports it. */
export interface GeneratedImageRecord {
    index: number;
    path: string;
    /** The app URL to show it at; absent when the file is outside the served generated-images folder. */
    url?: string;
    mimeType: string;
    width?: number;
    height?: number;
    byteLength: number;
    modelUsed: string;
    modelVersion?: string;
    skippedModels: SkippedMediaModel[];
    modelNote: string;
}

export const IMAGE_GENERATION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: GENERATE_IMAGE,
        description: 'Makes one or more pictures from a text prompt with a Google image model (Nano Banana by default): storyboard frames, concept art, reference plates, illustrations for a document, or an edit of given reference images (pass them in referenceImages and describe the change). Each image is written as a real file and the result gives its path and the app URL to show it at (put ![title](url) in your reply or in a markdown-document image section). The result names the model and credential that answered and why any earlier model was skipped; every image is labelled provenance "generated". It fails with an error, and writes nothing, when no image model or credential is available. Each image is a separate billed call: make only the images the user asked for.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'What the picture shows, in full sentences: subject, setting, light, framing, lens, textures, mood, and any exact text in double quotes. For an edit, describe the change to make to the reference images.'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: `Output aspect ratio: one of ${IMAGE_MODEL_ASPECT_RATIOS.map(([label]) => label).join(', ')}. Default 16:9. Any other value is an error (the models accept only these).`
                },
                referenceImages: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional images the model sees with the prompt: workspace file paths (relative to the workspace), absolute paths, http(s) URLs or data URIs. Use them to edit a picture or to keep a character, product or style consistent across frames.'
                },
                model: {
                    type: 'STRING',
                    description: 'Optional image model id (or product name: nano-banana-2, nano-banana-pro, nano-banana-lite). When given, only that model is used. Default: the standard image models in order, gemini-3.1-flash-image first, moving to the next only when a model is not served; the result says which one answered.'
                },
                fast: {
                    type: 'BOOLEAN',
                    description: 'When true and no model is given, ask Nano Banana Lite (gemini-3.1-flash-lite-image) first for speed over quality, then the standard models.'
                },
                count: {
                    type: 'NUMBER',
                    description: `How many pictures to make from the prompt (1 to ${GENERATE_IMAGE_MAX_COUNT}; default 1). Each is a separate model call.`
                },
                name: {
                    type: 'STRING',
                    description: 'Optional file-name stem, e.g. "storyboard_frame_01_opening". Default: the first words of the prompt. A timestamp and, for several images, an index are appended.'
                },
                outputDir: {
                    type: 'STRING',
                    description: `Optional folder to write into (relative paths resolve against the workspace). Default: the app's generated-images folder (${GENERATED_IMAGES_DIR} under the repository), the only folder the app serves at a URL.`
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'image_infill_holes',
        description: 'Fills the holes in an image generatively: the pixels a mask marks, or the flat regions of one colour (by default white, as a re-projected view leaves where nothing was seen) at least minHolePixels large. The holes and the pixels around them go to an image model with the holes in magenta; the answer is kept only when it reproduces the real pixels around the holes and joins them at the rim, and only hole pixels are replaced. The fill is labelled generated. When the answer is rejected the image is left as it was and the result says why. Writes a PNG and returns its path.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'URL, base64 data URI, or local filepath of the PNG or JPEG image with holes.' },
                maskPath: { type: 'STRING', description: 'Optional mask image of the same size: pixels brighter than mid-grey are holes. When given, holeColour is ignored.' },
                holeColour: { type: 'STRING', description: 'Optional "#RRGGBB" colour of the holes when there is no mask (default "#ffffff").' },
                minHolePixels: { type: 'NUMBER', description: 'Optional smallest flat region that counts as a hole (default 64 pixels).' },
                model: { type: 'STRING', description: 'Optional image model id. When given, only that model is used; otherwise the default image models are tried in order.' },
                outputPath: { type: 'STRING', description: 'Optional output PNG path (relative paths resolve against the workspace). Default: next to a local input as <name>_infilled.png, else infilled_<timestamp>.png in the workspace.' }
            },
            required: ['imagePath']
        }
    },
    {
        name: 'asset_grit_decal',
        description: 'Gives a 3D asset (a GLB) surface grit: an image model reads the weathering in a reference photo (a Street View frame, a survey station, a photo of the object), or paints the weathering described, as ONE large grayscale map that does not tile, which is baked into the GLB as a decal: a thin skin 1 cm off every near-vertical face, black with the map as its opacity, so any glTF viewer shows it over the asset\'s own materials. Openings and glass are left clean. The decal is labelled generated. Writes a new GLB and returns its path.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Local path of the asset GLB to decal (relative paths resolve against the workspace).' },
                referenceImageUrl: { type: 'STRING', description: 'Optional URL, base64 data URI, or local filepath of a photo showing the real surface and its weathering; without one the weathering is painted from the description alone.' },
                weathering: { type: 'STRING', description: 'Optional description, in your own words, of the weathering to paint (e.g. "light dust only", "rust streaks running down from the ironwork", "damp and moss at the base", "a century of city soot"). Default: city soot, rain streaks and blotches, heavier at the base and under the top edge.' },
                grimeColour: { type: 'STRING', description: 'Optional "#RRGGBB" colour of the grit (default black soot; e.g. rust orange or moss green).' },
                strength: { type: 'NUMBER', description: 'Optional opacity of the heaviest grit, 0 to 1 (default 0.8).' },
                includeParts: { type: 'STRING', description: 'Optional: only nodes whose name contains this text (case-insensitive) get grit.' },
                excludeParts: { type: 'STRING', description: 'Optional: nodes whose name contains this text get none (default: openings and glass).' },
                maxNormalY: { type: 'NUMBER', description: 'Optional: faces whose normal points up or down by more than this (0 = only vertical faces, 1 = every face including roofs) get none. Default 0.3 (walls).' },
                offsetM: { type: 'NUMBER', description: 'Optional distance of the decal off the surface in metres (default 0.01).' },
                model: { type: 'STRING', description: 'Optional image model id. When given, only that model is used; otherwise the default image models are tried in order.' },
                outputPath: { type: 'STRING', description: 'Optional output GLB path. Default: next to the input as <name>_grit.glb.' }
            },
            required: ['glbPath']
        }
    }
];

export const imageGenerationHandlers: Record<string, ToolHandler> = {
    asset_grit_decal: async (args, ctx) => {
        const GRIT = 'asset_grit_decal';
        const glbArg = asString(args.glbPath);
        if (!glbArg) throw new MissingInputError(GRIT, 'glbPath', 'give the asset GLB to decal');
        const glbPath = path.isAbsolute(glbArg) ? glbArg : path.resolve(ctx?.workspaceRoot || process.cwd(), glbArg);
        if (!(await fs.pathExists(glbPath))) throw new MissingInputError(GRIT, 'glbPath', `no file at ${glbPath}`);
        const refArg = asString(args.referenceImageUrl);
        const ref = refArg ? await loadInputImage(refArg, ctx?.workspaceRoot, ctx?.signal, GRIT, 'referenceImageUrl') : undefined;
        const weathering = asString(args.weathering) || undefined;
        const hexArg = asString(args.grimeColour);
        const hm = hexArg ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexArg) : null;
        if (hexArg && !hm) throw new InvalidInputError(GRIT, 'grimeColour', `"${hexArg}" is not a #RRGGBB colour`);
        const include = asString(args.includeParts).toLowerCase(), exclude = asString(args.excludeParts).toLowerCase();
        const keep = (n: string) => { const l = n.toLowerCase(); return (!include || l.includes(include)) && (exclude ? !l.includes(exclude) : !/opening|glass/.test(l)); };
        const glb = new Uint8Array(await fs.readFile(glbPath));
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        const tris = readTileTriangles(glb);
        for (let i = 0; i < tris.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tris.positions[i + k]); hi[k] = Math.max(hi[k], tris.positions[i + k]); }
        const widthM = Math.max(hi[0] - lo[0], hi[2] - lo[2]), heightM = hi[1] - lo[1];
        const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
        let genai: unknown;
        try {
            genai = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const map = await generateGritMap({ client: genai, models, ...(ref ? { reference: { bytes: new Uint8Array(ref.data), mimeType: ref.mimeType } } : {}), ...(weathering ? { weathering } : {}), widthM, heightM, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
        const strength = typeof args.strength === 'number' ? args.strength : GRIT_DEFAULT_STRENGTH;
        const baked = bakeGritDecal(glb, map.map, {
            strength, keep, ...(hm ? { colour: [parseInt(hm[1], 16), parseInt(hm[2], 16), parseInt(hm[3], 16)] as [number, number, number] } : {}),
            ...(typeof args.maxNormalY === 'number' ? { maxNormalY: args.maxNormalY } : {}), ...(typeof args.offsetM === 'number' ? { offsetM: args.offsetM } : {}),
            method: `${weathering ?? 'city grime'}${refArg ? ` read from ${refArg}` : ''}, painted by ${map.modelUsed} as one non-tiling map per surface`
        });
        const requestedOut = asString(args.outputPath);
        const outputPath = requestedOut
            ? (path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedOut))
            : path.join(path.dirname(glbPath), `${path.basename(glbPath, path.extname(glbPath))}_grit.glb`);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, baked.glb);
        return {
            resultPayload: { success: true, glbPath, outputPath, decalTriangles: baked.decalTriangles, widthM: Math.round(widthM * 10) / 10, heightM: Math.round(heightM * 10) / 10, strength, modelUsed: map.modelUsed, modelNote: map.modelNote, provenance: { label: 'generated', method: 'grime decal from a reference photo' } },
            summaryResult: `Baked a grit decal (${baked.decalTriangles} wall triangles, grime by ${map.modelUsed}, labelled generated) into ${outputPath}.`
        };
    },
    image_infill_holes: async (args, ctx) => {
        const INFILL = 'image_infill_holes';
        const imagePath = asString(args.imagePath);
        if (!imagePath) throw new MissingInputError(INFILL, 'imagePath', 'give the image with holes');
        const src = await loadInputImage(imagePath, ctx?.workspaceRoot, ctx?.signal, INFILL, 'imagePath');
        let image;
        try { image = decodeImageInMemory(new Uint8Array(src.data)); } catch (err) { throw new InvalidInputError(INFILL, 'imagePath', `the image is not a PNG or JPEG (${(err as Error).message})`); }
        let mask: Uint8Array | undefined;
        const maskPath = asString(args.maskPath);
        if (maskPath) {
            const m = decodeImageInMemory(new Uint8Array((await loadInputImage(maskPath, ctx?.workspaceRoot, ctx?.signal, INFILL, 'maskPath')).data));
            if (m.width !== image.width || m.height !== image.height) throw new InvalidInputError(INFILL, 'maskPath', `the mask is ${m.width} x ${m.height}, the image ${image.width} x ${image.height}`);
            mask = new Uint8Array(m.width * m.height);
            for (let i = 0; i < mask.length; i++) mask[i] = m.rgba[i * 4] + m.rgba[i * 4 + 1] + m.rgba[i * 4 + 2] > 3 * 128 ? 1 : 0;
        }
        const hex = asString(args.holeColour);
        const hm = hex ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
        if (hex && !hm) throw new InvalidInputError(INFILL, 'holeColour', `"${hex}" is not a #RRGGBB colour`);
        const colour = hm ? [parseInt(hm[1], 16), parseInt(hm[2], 16), parseInt(hm[3], 16)] as [number, number, number] : undefined;
        const minPixels = typeof args.minHolePixels === 'number' && args.minHolePixels > 0 ? Math.round(args.minHolePixels) : undefined;
        const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
        let genai: unknown;
        try {
            genai = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const res = await infillImageHoles({ image, client: genAiEnhanceClient(genai), models, ...(mask ? { mask } : {}), ...(colour ? { colour } : {}), ...(minPixels ? { minPixels } : {}), ...(ctx?.signal ? { signal: ctx.signal } : {}) });
        const requestedOut = asString(args.outputPath);
        const outputPath = requestedOut
            ? (path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedOut))
            : src.localPath
                ? path.join(path.dirname(src.localPath), `${path.basename(src.localPath, path.extname(src.localPath))}_infilled.png`)
                : path.join(ctx?.workspaceRoot || process.cwd(), `infilled_${Date.now()}.png`);
        const accepted = res.decision === 'accepted';
        if (accepted) {
            await fs.ensureDir(path.dirname(outputPath));
            await fs.writeFile(outputPath, encodePng(res.image.width, res.image.height, Buffer.from(res.image.rgba)));
        }
        return {
            resultPayload: {
                success: accepted, imagePath, ...(accepted ? { outputPath } : {}), decision: res.decision, ...(res.reason ? { reason: res.reason } : {}),
                holePixels: res.holePixels, filledPixels: res.filledPixels, width: image.width, height: image.height,
                ...(res.modelUsed ? { modelUsed: res.modelUsed } : {}), ...(res.metrics ? { metrics: res.metrics } : {}), ...(res.provenance ? { provenance: res.provenance } : {})
            },
            summaryResult: accepted
                ? `Filled ${res.filledPixels} hole pixels of ${imagePath} with ${res.modelUsed} (labelled generated) -> ${outputPath}.`
                : res.decision === 'no_holes' ? `No holes found in ${imagePath}${mask ? ' (the mask is empty)' : ''}; nothing written.`
                : `The holes of ${imagePath} were not filled: ${res.reason ?? res.decision}. The image is unchanged; nothing written.`
        };
    },
    [GENERATE_IMAGE]: async (args, ctx) => {
        const prompt = asString(args.prompt).trim();
        if (!prompt) throw new MissingInputError(GENERATE_IMAGE, 'prompt', 'describe the picture to make');

        const aspectRatio = asString(args.aspectRatio).trim() || '16:9';
        if (!IMAGE_MODEL_ASPECT_RATIOS.some(([label]) => label === aspectRatio)) {
            throw new InvalidInputError(GENERATE_IMAGE, 'aspectRatio', `"${aspectRatio}" is not one the image models accept; use one of ${IMAGE_MODEL_ASPECT_RATIOS.map(([label]) => label).join(', ')}`);
        }

        const rawCount = args.count === undefined || args.count === null || args.count === '' ? 1 : Number(args.count);
        if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > GENERATE_IMAGE_MAX_COUNT) {
            throw new InvalidInputError(GENERATE_IMAGE, 'count', `give a whole number from 1 to ${GENERATE_IMAGE_MAX_COUNT} (got ${String(args.count)})`);
        }
        const count = rawCount;

        const references = asStringList(args.referenceImages);
        const referenceParts: Array<{ inlineData: { data: string; mimeType: string } }> = [];
        for (const ref of references) {
            const image = await loadInputImage(ref, ctx?.workspaceRoot, ctx?.signal, GENERATE_IMAGE, 'referenceImages');
            referenceParts.push({ inlineData: { data: image.data.toString('base64'), mimeType: image.mimeType } });
        }

        const requestedModel = asString(args.model).trim() || undefined;
        const models = requestedModel
            ? resolveRequestedModels(requestedModel, IMAGE_MODEL_PRIORITY)
            : resolveRequestedModels(undefined, asBoolean(args.fast, false) ? [FAST_IMAGE_MODEL, ...IMAGE_MODEL_PRIORITY] : IMAGE_MODEL_PRIORITY);

        const requestedDir = asString(args.outputDir).trim();
        const outputDir = requestedDir
            ? (path.isAbsolute(requestedDir) ? requestedDir : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedDir))
            : path.resolve(resolveRepoRoot(), GENERATED_IMAGES_DIR);

        let client: any;
        try {
            client = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const credential: 'vertex-ai' | 'api-key' = client?.vertexai ? 'vertex-ai' : 'api-key';

        const stem = `${imageFileStem(asString(args.name).trim() || undefined, prompt)}_${Date.now()}`;
        const contents = [{ text: prompt }, ...referenceParts];
        const images: GeneratedImageRecord[] = [];
        await fs.ensureDir(outputDir);
        for (let index = 0; index < count; index++) {
            ctx?.reportProgress?.(count > 1 ? `Generating image ${index + 1} of ${count}` : 'Generating image', index / count);
            const answer = await generateImageWithModels(client, {
                models,
                contents,
                imageConfig: { aspectRatio },
                signal: ctx?.signal
            });
            const ext = extensionFor(answer.mimeType);
            const filePath = path.join(outputDir, `${stem}${count > 1 ? `_${index + 1}` : ''}${ext}`);
            await fs.writeFile(filePath, answer.data);
            const servedUrl = servedGeneratedImageUrl(filePath);
            // the durable copy outside this checkout, with the prompt as its recipe (asset-store)
            if (servedUrl) {
                try {
                    const store = defaultDurableAssetStore();
                    if (store) {
                        const recipeId = `generate_image:${stem}`;
                        store.putRecipe({ id: recipeId, kind: 'generate_image', workspace: ctx?.workspaceRoot, body: { prompt, aspectRatio, count, referenceImages: references, models, name: asString(args.name).trim() || undefined } });
                        store.putFile(filePath, { servedPath: servedUrl, origin: 'generate_image', workspace: ctx?.workspaceRoot, recipeId, mime: answer.mimeType });
                    }
                } catch (err) {
                    console.warn(`[generate_image] ${servedUrl} was written but not recorded in the asset store: ${(err as Error).message}`);
                }
            }
            const dims = readImageDimensions(answer.data);
            images.push({
                index: index + 1,
                path: filePath,
                url: servedUrl,
                mimeType: answer.mimeType,
                ...(dims ? { width: dims.width, height: dims.height } : {}),
                byteLength: answer.data.length,
                modelUsed: answer.modelUsed,
                ...(answer.modelVersion ? { modelVersion: answer.modelVersion } : {}),
                skippedModels: answer.skippedModels,
                modelNote: answer.modelNote
            });
        }

        const modelsUsed = Array.from(new Set(images.map(i => i.modelUsed)));
        const first = images[0];
        const markdown = images
            .map(i => (i.url ? `![${asString(args.name).trim() || prompt.slice(0, 60)}${count > 1 ? ` (${i.index})` : ''}](${i.url})` : ''))
            .filter(Boolean)
            .join('\n');
        const unservedNote = images.some(i => !i.url)
            ? ` ${images.filter(i => !i.url).length} file(s) are outside ${GENERATED_IMAGES_DIR}, so the app has no URL for them; use the paths.`
            : '';
        const summary = `Generated ${images.length} image${images.length === 1 ? '' : 's'} (${aspectRatio}) with ${modelsUsed.join(', ')} via ${credential} -> ${images.map(i => i.path).join(', ')}. ${first.modelNote}${unservedNote}`;

        return {
            resultPayload: {
                success: true,
                provenance: 'generated',
                prompt,
                aspectRatio,
                count: images.length,
                referenceImages: references,
                requestedModels: models,
                modelUsed: first.modelUsed,
                modelsUsed,
                credential,
                skippedModels: first.skippedModels,
                modelNote: first.modelNote,
                outputDir,
                images,
                markdown,
                summary
            },
            summaryResult: summary
        };
    }
};
