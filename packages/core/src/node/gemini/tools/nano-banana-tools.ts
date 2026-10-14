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
    type ExtractedColorPalette
} from '../../../browser/generative-canvas/services/nano-banana-color-service';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asBoolean(val: unknown, defaultVal = false): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return defaultVal;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TEMPERATURES = ['warm', 'cool', 'neutral'];

/**
 * The palette exactly as the caller gave it (an object or its JSON text). Every part the application prompt
 * maps is required: the prompt builder would otherwise fill gaps with its own stock colors.
 */
function requireCompletePalette(raw: unknown): ExtractedColorPalette {
    const tool = 'nano_banana_apply_color_palette';
    let palette: any = raw;
    if (typeof raw === 'string') {
        try {
            palette = JSON.parse(raw);
        } catch {
            throw new MissingInputError(tool, 'palette', 'give the palette as a JSON object (primaryTones, accentTones, shadowProfile, highlightProfile, lightingAtmosphere), not free text');
        }
    }
    if (!palette || typeof palette !== 'object') {
        throw new MissingInputError(tool, 'palette', 'give the palette as a JSON object');
    }
    const tones = (list: unknown, key: string) => {
        if (!Array.isArray(list) || list.length === 0 || !list.every(t => t && typeof t.name === 'string' && HEX_COLOR.test(String(t.hex)))) {
            throw new MissingInputError(tool, `palette.${key}`, 'needs at least one { name, hex: "#RRGGBB" } tone');
        }
    };
    tones(palette.primaryTones, 'primaryTones');
    tones(palette.accentTones, 'accentTones');
    for (const key of ['shadowProfile', 'highlightProfile']) {
        const profile = palette[key];
        if (!profile || typeof profile.tone !== 'string' || !TEMPERATURES.includes(profile.temperature)) {
            throw new MissingInputError(tool, `palette.${key}`, 'needs { tone, temperature: "warm" | "cool" | "neutral" }');
        }
    }
    if (typeof palette.lightingAtmosphere !== 'string' || !palette.lightingAtmosphere.trim()) {
        throw new MissingInputError(tool, 'palette.lightingAtmosphere', 'needs a sentence describing the lighting');
    }
    return { rawSummary: '', ...palette } as ExtractedColorPalette;
}

export const NANO_BANANA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'nano_banana_apply_color_palette',
        description: 'Construct the precision global color override prompt that applies a given color palette to a target image with strict non-negotiable geometry locking (Method 2 Step 2). It returns the prompt text for an image model; it does not edit the image. The palette must be complete (read it from the reference image yourself): it is used as given, never filled in.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetImageUrl: {
                    type: 'STRING',
                    description: 'URL, base64 data URI, or local filepath of the target image whose geometry/structure will be preserved.'
                },
                palette: {
                    type: 'OBJECT',
                    description: 'Complete palette object: primaryTones and accentTones ([{ name, hex: "#RRGGBB", role? }], at least one each), shadowProfile and highlightProfile ({ tone, temperature: "warm" | "cool" | "neutral", hex? }) and lightingAtmosphere (sentence).'
                },
                preserveSkinTones: {
                    type: 'BOOLEAN',
                    description: 'When true, protects natural human facial and skin tones from unnatural color shifting.'
                },
                contrastCurve: {
                    type: 'STRING',
                    description: 'Contrast grading curve to apply: "cinematic", "natural", "high-contrast", or "muted". Defaults to "cinematic".'
                },
                aspectRatio: {
                    type: 'STRING',
                    description: 'Aspect ratio of the output canvas (e.g. "16:9", "1:1", "4:3", "9:16"). Defaults to "16:9".'
                },
                targetFocusArea: {
                    type: 'STRING',
                    description: 'Optional selective recoloring region (e.g. "entire image", "background only", "wardrobe only").'
                },
                customInstructions: {
                    type: 'STRING',
                    description: 'Optional additional artistic styling directives or mood modifiers.'
                }
            },
            required: ['targetImageUrl', 'palette']
        }
    }
];

export const nanoBananaHandlers: Record<string, ToolHandler> = {
    nano_banana_apply_color_palette: (args, _ctx) => {
        const targetImageUrl = asString(args.targetImageUrl);
        if (!targetImageUrl) throw new Error('nano_banana_apply_color_palette: "targetImageUrl" argument is required.');
        if (args.palette === undefined || args.palette === null || args.palette === '') {
            throw new MissingInputError('nano_banana_apply_color_palette', 'palette', 'give the complete palette to apply');
        }
        const palette = requireCompletePalette(args.palette);

        const preserveSkinTones = asBoolean(args.preserveSkinTones, false);
        const contrastCurve = (asString(args.contrastCurve) || 'cinematic') as 'natural' | 'cinematic' | 'high-contrast' | 'muted';
        const aspectRatio = asString(args.aspectRatio) || '16:9';
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

        return {
            resultPayload: {
                success: true,
                targetImageUrl,
                applicationPrompt,
                preserveSkinTones,
                contrastCurve,
                aspectRatio,
                geometryLocked: true,
                globalColorOverride: true
            },
            summaryResult: `Constructed the Nano Banana global color override prompt for ${targetImageUrl} (${palette.primaryTones.length} base and ${palette.accentTones.length} accent tones, geometry locked). The image itself is not edited yet.`
        };
    }
};
