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
import { bakeDecal, decalAsset, generateDecalImage, DECAL_DEFAULT_STRENGTH } from '../../3d-engine/asset-decal';
import { genAiEnhanceClient } from '../../3d-engine/staged-location/texture-enhance';
import { decodeImageInMemory } from '../../3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../../texture-processing';
import { buildFacadeTextureFromImage } from '../../3d-engine/staged-location/facade-texture/facade-texture';
import { genAiPlateClient } from '../../3d-engine/staged-location/pipeline-e/enhance';
import { visionFacadeCounter } from '../../3d-engine/staged-location/pipeline-e/plate-identity';
import { VisionModelChain } from '../vision-model-chain';
import { FALLBACK_GEMINI_MODELS } from '../gemini-client';

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
        name: 'asset_decal',
        description: 'Lays a decal on a 3D asset (a GLB): any image over the asset\'s own materials, baked into the GLB as a decal node a few millimetres off the faces it covers, so any glTF viewer and the app show it. What it shows is up to you: your own image (a logo, a sign, a poster, a photo, a texture with transparency), or an image painted by an image model from your description (grime and weathering, graffiti, a mural, ivy, rust streaks, lettering, damage, wet patches...), optionally read from a reference photo of the real thing. Where it goes is numbers you choose: the faces (by slope, by part name, by the compass direction they face), and the mapping (once across them, repeated every N metres, or one patch of a given size at a given place). Opacity comes from the image\'s own transparency, else from how far each pixel is from the white it was painted on; colour is the image\'s own unless you give one colour. A generated decal is labelled generated, your own image photo-inferred. Writes a new GLB and returns its path.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Local path of the asset GLB (relative paths resolve against the workspace).' },
                imageUrl: { type: 'STRING', description: 'Optional: the decal image itself (URL, data URI or file path), used as given; e.g. a decal asset made by decal_generate. When absent the image is painted from `description`.' },
                description: { type: 'STRING', description: 'Optional: what to paint, in your own words (e.g. "a century of city soot and rain streaks", "faded red graffiti tags along the bottom metre", "a hand-painted Victorian shop sign reading ROOKERY in gold", "ivy climbing from the base"). Default: city weathering.' },
                referenceImageUrl: { type: 'STRING', description: 'Optional photo the painted decal should be read from or look like (a Street View frame, a survey station, a photo).' },
                colour: { type: 'STRING', description: 'Optional "#RRGGBB": a one-colour decal (the image gives only its opacity), e.g. black soot, rust orange, moss green.' },
                strength: { type: 'NUMBER', description: 'Optional overall opacity, 0 to 1 (default 0.8).' },
                headingDeg: { type: 'NUMBER', description: 'Optional: only faces facing this compass heading (0 north, 90 east, 180 south, 270 west), within headingToleranceDeg.' },
                headingToleranceDeg: { type: 'NUMBER', description: 'Optional tolerance for headingDeg (default 45).' },
                patchCentre: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional [across, up]: place ONE patch, its centre as fractions of the covered faces (across 0 = left, 1 = right, seen from outside; up 0 = bottom, 1 = top). Needs patchSizeM.' },
                patchSizeM: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional [width, height] of the patch in metres.' },
                tileM: { type: 'NUMBER', description: 'Optional: repeat the image every this many metres instead of stretching it once.' },
                includeParts: { type: 'STRING', description: 'Optional: only nodes whose name contains this text (case-insensitive).' },
                excludeParts: { type: 'STRING', description: 'Optional: nodes whose name contains this text are left clear (default: openings and glass).' },
                maxNormalY: { type: 'NUMBER', description: 'Optional: faces whose normal points up or down by more than this get none (0 = only vertical faces, 1 = every face). Default 0.3.' },
                offsetM: { type: 'NUMBER', description: 'Optional distance off the surface in metres (default 0.01).' },
                name: { type: 'STRING', description: 'Optional name of the decal node (default "decal").' },
                model: { type: 'STRING', description: 'Optional image model id for a painted decal.' },
                outputPath: { type: 'STRING', description: 'Optional output GLB path. Default: next to the input as <name>_decal.glb.' }
            },
            required: ['glbPath']
        }
    },
    {
        name: 'decal_generate',
        description: 'Makes decal assets: transparent PNG images of anything you describe (a sign, a logo, graffiti, a mural, a poster, ivy, rust streaks, stains, cracks, soot, road markings, numbers, a texture that tiles...), painted by an image model on white and cut out (the opacity is each pixel\'s distance from the white), optionally modelled on a reference photo. Each comes with a JSON sidecar recording its real-world size, whether it tiles, what it shows and its provenance (generated). They are files you keep and reuse: lay one on a model with asset_decal (its imageUrl), show it, or put it in a document. Each image is a separate billed call: make only the decals asked for.',
        parameters: {
            type: 'OBJECT',
            properties: {
                description: { type: 'STRING', description: 'What the decal shows, in your own words. Required unless referenceImageUrl alone says it.' },
                referenceImageUrl: { type: 'STRING', description: 'Optional photo it should be read from or look like (URL, data URI or file path).' },
                sizeM: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional [width, height] in metres the decal spans in the world (default [2, 2]); sets its aspect and is recorded for placing it.' },
                tiles: { type: 'BOOLEAN', description: 'Optional: paint it to tile seamlessly (default false).' },
                colour: { type: 'STRING', description: 'Optional "#RRGGBB": a one-colour decal (the painting gives only its shape and opacity).' },
                count: { type: 'NUMBER', description: 'Optional number of variants (default 1, at most 4).' },
                name: { type: 'STRING', description: 'Optional short name for the files.' },
                model: { type: 'STRING', description: 'Optional image model id.' },
                outputDir: { type: 'STRING', description: 'Optional folder. Default: the app-served build/generated-images/decals.' }
            }
        }
    },
    {
        name: 'facade_texture_build',
        description: 'Builds a realistic texture of one building wall from a straight-on (rectified) picture of it: a survey plate, a 3D-tiles ortho, a rectified photo. The facade texture builder redraws the wall with an image model, keeping its framing, then keeps the redraw only when it is the same wall (identity gate: storeys and bays counted on both, colour family, framing, edge alignment) and a good texture (quality score: no seam, no smeared strip, little left empty); what the score faults is redrawn by generative infill. Flat mid-grey texels of the input (or a given mask) are drawn as the wall continues. Every texel written is labelled generated. Writes a PNG and a JSON record of every check, and says why when the wall is refused.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'URL, base64 data URI, or local filepath of the straight-on PNG or JPEG wall picture.' },
                widthM: { type: 'NUMBER', description: 'The wall\'s width in metres (the picture\'s full width).' },
                heightM: { type: 'NUMBER', description: 'Optional wall height in metres (default: from the picture\'s aspect).' },
                locationName: { type: 'STRING', description: 'Optional name or address of the building, for the prompt (default "the building").' },
                referencePath: { type: 'STRING', description: 'Optional finished texture of a neighbouring wall of the same building, the reference for materials and colour.' },
                unseenMaskPath: { type: 'STRING', description: 'Optional mask of the same size: pixels brighter than mid-grey are drawn as the wall continues (unseen, occluded). Default: the picture\'s flat mid-grey pixels.' },
                audit: { type: 'BOOLEAN', description: 'Optional region audit against the input (default false): use it when the input is a sharp, trustworthy picture; leave it off for melted or partial inputs.' },
                countStoreysAndBays: { type: 'BOOLEAN', description: 'Optional (default true): count storeys and bays on the input and the redraw with a vision model, and refuse a redraw that changes them.' },
                model: { type: 'STRING', description: 'Optional image model id; otherwise the default image models are tried in order.' },
                outputPath: { type: 'STRING', description: 'Optional output PNG path (relative paths resolve against the workspace). Default: next to a local input as <name>_facade.png, else facade_<timestamp>.png in the workspace. The record is written beside it as .json.' }
            },
            required: ['imagePath', 'widthM']
        }
    }
];

export const imageGenerationHandlers: Record<string, ToolHandler> = {
    decal_generate: async (args, ctx) => {
        const TOOL_ID = 'decal_generate';
        const description = asString(args.description).trim();
        const refArg = asString(args.referenceImageUrl);
        if (!description && !refArg) throw new MissingInputError(TOOL_ID, 'description', 'describe the decal, or give a reference photo of it');
        const sz = Array.isArray(args.sizeM) && args.sizeM.length === 2 && args.sizeM.every((x: unknown) => typeof x === 'number' && x > 0) ? [args.sizeM[0], args.sizeM[1]] as [number, number] : [2, 2] as [number, number];
        const tiles = asBoolean(args.tiles, false);
        const count = Math.max(1, Math.min(GENERATE_IMAGE_MAX_COUNT, Math.round(typeof args.count === 'number' ? args.count : 1)));
        const cv = asString(args.colour), cm = cv ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cv) : null;
        if (cv && !cm) throw new InvalidInputError(TOOL_ID, 'colour', `"${cv}" is not a #RRGGBB colour`);
        const colour = cm ? [parseInt(cm[1], 16), parseInt(cm[2], 16), parseInt(cm[3], 16)] as [number, number, number] : undefined;
        const ref = refArg ? await loadInputImage(refArg, ctx?.workspaceRoot, ctx?.signal, TOOL_ID, 'referenceImageUrl') : undefined;
        const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
        let genai: unknown;
        try {
            genai = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const repoRoot = resolveRepoRoot();
        const outArg = asString(args.outputDir);
        const dir = outArg ? (path.isAbsolute(outArg) ? outArg : path.resolve(ctx?.workspaceRoot || process.cwd(), outArg)) : path.join(repoRoot, GENERATED_IMAGES_DIR, 'decals');
        await fs.ensureDir(dir);
        const stem = `${imageFileStem(asString(args.name) || undefined, description || 'decal')}_${Date.now().toString(36)}`;
        const decals = [];
        for (let k = 0; k < count; k++) {
            const painted = await generateDecalImage({ client: genai, models, ...(description ? { description } : {}), ...(ref ? { reference: { bytes: new Uint8Array(ref.data), mimeType: ref.mimeType } } : {}), widthM: sz[0], heightM: sz[1], tiles, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
            const asset = decalAsset(painted.image, { description: description || `read from ${refArg}`, sizeM: sz, tiles, label: 'generated', method: `painted by ${painted.modelUsed} on white and cut out by distance from white`, model: painted.modelUsed, ...(refArg ? { reference: refArg } : {}) }, colour);
            const file = path.join(dir, `${stem}${count > 1 ? `_${k + 1}` : ''}.png`);
            await fs.writeFile(file, asset.png);
            await fs.writeFile(file.replace(/\.png$/, '.json'), JSON.stringify(asset.meta, null, 1));
            const url = servedGeneratedImageUrl(file, repoRoot);
            decals.push({ path: file, sidecar: file.replace(/\.png$/, '.json'), ...(url ? { url } : {}), sizeM: sz, pixels: asset.meta.pixels, modelUsed: painted.modelUsed });
        }
        return {
            resultPayload: { success: true, decals, provenance: { label: 'generated' } },
            summaryResult: `Made ${decals.length} decal${decals.length === 1 ? '' : 's'} (${sz[0]} x ${sz[1]} m${tiles ? ', tiling' : ''}): ${decals.map(d => d.path).join(', ')}. Lay one on a model with asset_decal (imageUrl).`
        };
    },
    asset_decal: async (args, ctx) => {
        const TOOL_ID = 'asset_decal';
        const glbArg = asString(args.glbPath);
        if (!glbArg) throw new MissingInputError(TOOL_ID, 'glbPath', 'give the asset GLB');
        const glbPath = path.isAbsolute(glbArg) ? glbArg : path.resolve(ctx?.workspaceRoot || process.cwd(), glbArg);
        if (!(await fs.pathExists(glbPath))) throw new MissingInputError(TOOL_ID, 'glbPath', `no file at ${glbPath}`);
        const glb = new Uint8Array(await fs.readFile(glbPath));
        const hex = (arg: string) => {
            const v = asString(args[arg]);
            if (!v) return undefined;
            const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
            if (!m) throw new InvalidInputError(TOOL_ID, arg, `"${v}" is not a #RRGGBB colour`);
            return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] as [number, number, number];
        };
        const num = (arg: string) => (typeof args[arg] === 'number' && Number.isFinite(args[arg]) ? args[arg] as number : undefined);
        const pair = (arg: string) => { const v = args[arg]; return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1]] as [number, number] : undefined; };
        const centre = pair('patchCentre'), size = pair('patchSizeM');
        if ((centre && !size) || (size && !centre)) throw new InvalidInputError(TOOL_ID, centre ? 'patchSizeM' : 'patchCentre', 'a patch needs both patchCentre and patchSizeM');
        const include = asString(args.includeParts).toLowerCase(), exclude = asString(args.excludeParts).toLowerCase();
        const keep = (n: string) => { const l = n.toLowerCase(); return (!include || l.includes(include)) && (exclude ? !l.includes(exclude) : !/opening|glass/.test(l)); };
        const placement = {
            ...(num('maxNormalY') !== undefined ? { maxNormalY: num('maxNormalY') } : {}), ...(num('headingDeg') !== undefined ? { headingDeg: num('headingDeg') } : {}),
            ...(num('headingToleranceDeg') !== undefined ? { headingToleranceDeg: num('headingToleranceDeg') } : {}), ...(num('tileM') !== undefined ? { tileM: num('tileM') } : {}),
            ...(centre && size ? { patch: { centre, sizeM: size } } : {}), ...(num('offsetM') !== undefined ? { offsetM: num('offsetM') } : {})
        };
        // the decal image: given, or painted at the size it will cover
        const imageArg = asString(args.imageUrl), description = asString(args.description) || undefined;
        let image, label: 'generated' | 'photo-inferred', modelUsed: string | undefined, method: string;
        if (imageArg) {
            const img = await loadInputImage(imageArg, ctx?.workspaceRoot, ctx?.signal, TOOL_ID, 'imageUrl');
            try { image = decodeImageInMemory(new Uint8Array(img.data)); } catch (err) { throw new InvalidInputError(TOOL_ID, 'imageUrl', `the image is not a PNG or JPEG (${(err as Error).message})`); }
            label = 'photo-inferred';
            method = `the given image ${imageArg}`;
        } else {
            // the size it will cover: the patch, a tile, or the covered faces (a dry bake measures them)
            const probe = bakeDecal(glb, { width: 4, height: 4, rgba: new Uint8Array(64).fill(255) }, { ...placement, keep });
            if (!probe.decalTriangles) throw new InvalidInputError(TOOL_ID, 'glbPath', 'no face of the asset matches the placement asked for');
            const [wM, hM] = size ?? (placement.tileM ? [placement.tileM, placement.tileM] : [probe.widthM, probe.heightM]);
            const refArg = asString(args.referenceImageUrl);
            const ref = refArg ? await loadInputImage(refArg, ctx?.workspaceRoot, ctx?.signal, TOOL_ID, 'referenceImageUrl') : undefined;
            const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
            let genai: unknown;
            try {
                genai = await new GoogleMediaCredentialsService().createClient();
            } catch (err) {
                throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
            }
            const painted = await generateDecalImage({ client: genai, models, ...(description ? { description } : {}), ...(ref ? { reference: { bytes: new Uint8Array(ref.data), mimeType: ref.mimeType } } : {}), widthM: wM, heightM: hM, tiles: !!placement.tileM, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
            image = painted.image; modelUsed = painted.modelUsed; label = 'generated';
            method = `${description ?? 'city weathering'}${refArg ? `, read from ${refArg}` : ''}, painted by ${painted.modelUsed}`;
        }
        const strength = num('strength') ?? DECAL_DEFAULT_STRENGTH, colour = hex('colour');
        const baked = bakeDecal(glb, image, { ...placement, keep, strength, label, method, ...(colour ? { colour } : {}), ...(asString(args.name) ? { name: asString(args.name) } : {}) });
        if (!baked.decalTriangles) throw new InvalidInputError(TOOL_ID, 'glbPath', 'no face of the asset matches the placement asked for');
        const requestedOut = asString(args.outputPath);
        const outputPath = requestedOut
            ? (path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedOut))
            : path.join(path.dirname(glbPath), `${path.basename(glbPath, path.extname(glbPath))}_decal.glb`);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, baked.glb);
        return {
            resultPayload: { success: true, glbPath, outputPath, decalTriangles: baked.decalTriangles, coveredWidthM: Math.round(baked.widthM * 10) / 10, coveredHeightM: Math.round(baked.heightM * 10) / 10, strength, ...(modelUsed ? { modelUsed } : {}), provenance: { label, method } },
            summaryResult: `Baked a decal (${baked.decalTriangles} triangles, ${label}: ${method}) into ${outputPath}.`
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
    facade_texture_build: async (args, ctx) => {
        const FACADE = 'facade_texture_build';
        const imagePath = asString(args.imagePath);
        if (!imagePath) throw new MissingInputError(FACADE, 'imagePath', 'give the straight-on picture of the wall');
        const widthM = Number(args.widthM);
        if (!(widthM > 0)) throw new MissingInputError(FACADE, 'widthM', 'give the wall\'s width in metres');
        const src = await loadInputImage(imagePath, ctx?.workspaceRoot, ctx?.signal, FACADE, 'imagePath');
        let image;
        try { image = decodeImageInMemory(new Uint8Array(src.data)); } catch (err) { throw new InvalidInputError(FACADE, 'imagePath', `the image is not a PNG or JPEG (${(err as Error).message})`); }
        const heightM = Number(args.heightM) > 0 ? Number(args.heightM) : widthM * image.height / image.width;
        const load = async (p: string, field: string) => { try { return decodeImageInMemory(new Uint8Array((await loadInputImage(p, ctx?.workspaceRoot, ctx?.signal, FACADE, field)).data)); } catch (err) { if (err instanceof InvalidInputError || err instanceof MissingInputError) throw err; throw new InvalidInputError(FACADE, field, `the image is not a PNG or JPEG (${(err as Error).message})`); } };
        const referencePath = asString(args.referencePath);
        const reference = referencePath ? await load(referencePath, 'referencePath') : undefined;
        let unseenMask: Uint8Array | undefined;
        const maskPath = asString(args.unseenMaskPath);
        if (maskPath) {
            const m = await load(maskPath, 'unseenMaskPath');
            if (m.width !== image.width || m.height !== image.height) throw new InvalidInputError(FACADE, 'unseenMaskPath', `the mask is ${m.width} x ${m.height}, the image ${image.width} x ${image.height}`);
            unseenMask = new Uint8Array(m.width * m.height);
            for (let i = 0; i < unseenMask.length; i++) unseenMask[i] = m.rgba[i * 4] + m.rgba[i * 4 + 1] + m.rgba[i * 4 + 2] > 3 * 128 ? 1 : 0;
        }
        const models = resolveRequestedModels(asString(args.model) || undefined, IMAGE_MODEL_PRIORITY);
        let genai: unknown;
        try {
            genai = await new GoogleMediaCredentialsService().createClient();
        } catch (err) {
            throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        const counter = args.countStoreysAndBays === false ? undefined : visionFacadeCounter(new VisionModelChain<string>({ client: genai as never, candidates: FALLBACK_GEMINI_MODELS, ...(ctx?.signal ? { signal: ctx.signal } : {}) } as never));
        const res = await buildFacadeTextureFromImage({
            image, widthM, heightM, locationName: asString(args.locationName) || 'the building', client: genAiPlateClient(genai), models,
            infill: { client: genAiEnhanceClient(genai), models }, ...(reference ? { reference } : {}), ...(unseenMask ? { unseenMask } : {}),
            ...(counter ? { counter } : {}), audit: args.audit === true, ...(ctx?.signal ? { signal: ctx.signal } : {})
        });
        const requestedOut = asString(args.outputPath);
        const outputPath = requestedOut
            ? (path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ctx?.workspaceRoot || process.cwd(), requestedOut))
            : src.localPath
                ? path.join(path.dirname(src.localPath), `${path.basename(src.localPath, path.extname(src.localPath))}_facade.png`)
                : path.join(ctx?.workspaceRoot || process.cwd(), `facade_${Date.now()}.png`);
        const record = {
            accepted: res.accepted, why: res.why, ...(res.model ? { modelUsed: res.model } : {}), widthM, heightM: Math.round(heightM * 100) / 100, coveredShare: Math.round(res.coveredShare * 1000) / 1000,
            ...(res.chamferPx !== undefined ? { chamferPx: res.chamferPx, lostShare: res.lostShare } : {}), ...(res.identity ? { identity: res.identity } : {}),
            ...(res.quality ? { quality: res.quality } : {}), ...(res.infill ? { infill: res.infill } : {}), ...(res.audit ? { audit: { flaggedShare: res.audit.flaggedShare, regions: res.audit.regions.length } } : {}),
            provenance: { label: 'generated', method: 'facade texture builder: redrawn from the input picture by an image model, kept through the identity gate and the quality score' }
        };
        await fs.ensureDir(path.dirname(outputPath));
        const recordPath = outputPath.replace(/\.png$/i, '') + '.json';
        await fs.writeFile(recordPath, JSON.stringify(record, null, 1));
        if (res.accepted && res.texture) await fs.writeFile(outputPath, encodePng(res.texture.width, res.texture.height, Buffer.from(res.texture.rgba)));
        return {
            resultPayload: { success: res.accepted, imagePath, ...(res.accepted ? { outputPath } : {}), recordPath, ...record },
            summaryResult: res.accepted
                ? `Built the facade texture of ${imagePath} (${widthM} x ${heightM.toFixed(1)} m) with ${res.model} (labelled generated) -> ${outputPath}; record ${recordPath}.`
                : `The facade texture of ${imagePath} was refused: ${res.why}. Nothing written but the record ${recordPath}.`
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
