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
import { MediaModelUnavailableError, MissingInputError } from '../../../common/errors/pipeline-errors';
import { IMAGE_MODEL_PRIORITY, resolveRequestedModels } from '../../../common/media-generation-protocol';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import { generateImageWithModels } from '../../google-media-generation-service';
import { readImageDimensions, sniffImageFormat } from '../../image-codec-ffmpeg';
import type { ToolDeclaration, ToolHandler } from './types';

const TOOL = 'nano_banana_apply_color_palette';

/** Reads the target image: a data URI, an http(s) URL, or a file path (relative paths resolve against the workspace). */
async function loadTargetImage(ref: string, workspaceRoot: string | undefined, signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string; localPath?: string }> {
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
            throw new MissingInputError(TOOL, 'targetImageUrl', `could not download ${ref} (${(err as Error).message})`);
        }
        if (!res.ok) throw new MissingInputError(TOOL, 'targetImageUrl', `downloading ${ref} answered HTTP ${res.status}`);
        data = Buffer.from(await res.arrayBuffer());
    } else {
        localPath = path.isAbsolute(ref) ? ref : path.resolve(workspaceRoot || process.cwd(), ref);
        if (!(await fs.pathExists(localPath))) throw new MissingInputError(TOOL, 'targetImageUrl', `no file at ${localPath}`);
        data = await fs.readFile(localPath);
    }
    const format = sniffImageFormat(data);
    if (format === 'unknown') throw new MissingInputError(TOOL, 'targetImageUrl', `${ref.slice(0, 80)} is not a JPEG, PNG or WebP image`);
    return { data, mimeType: `image/${format}`, localPath };
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
