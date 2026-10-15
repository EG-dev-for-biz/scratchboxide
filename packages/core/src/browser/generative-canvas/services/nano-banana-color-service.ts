/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { MissingInputError } from '../../../common/errors/pipeline-errors';

export interface ExtractedColorTone {
    name: string;
    hex: string;
    role?: string;
    percentage?: number;
}

/**
 * A shadow or highlight read from a reference. `temperature` is the model's own words ("warm", "cool-neutral",
 * "5600K", ...): it is quoted into the prompt as given, never mapped onto a fixed set.
 */
export interface ShadowHighlightProfile {
    tone: string;
    temperature: 'warm' | 'cool' | 'neutral' | (string & {});
    hex?: string;
    description?: string;
}

/** Contrast curve names with a written directive; any other description is used as given. */
export type ContrastCurve = 'natural' | 'cinematic' | 'high-contrast' | 'muted' | (string & {});

export interface ExtractedColorPalette {
    primaryTones: ExtractedColorTone[];
    accentTones: ExtractedColorTone[];
    shadowProfile: ShadowHighlightProfile;
    highlightProfile: ShadowHighlightProfile;
    lightingAtmosphere: string;
    contrastProfile?: ContrastCurve;
    rawSummary: string;
}

export interface ExtractPalettePromptOptions {
    referenceImageUrl?: string;
    referenceImagePath?: string;
    focusArea?: 'global' | 'background' | 'subject' | 'accents';
    format?: 'structured-json' | 'swatches' | 'markdown';
}

export interface ApplyPaletteOptions {
    targetImageUrl?: string;
    targetImagePath?: string;
    /** The palette read from the reference: an object, or the extraction model's answer (its JSON block is parsed). */
    palette: ExtractedColorPalette | string;
    preserveSkinTones?: boolean;
    contrastCurve?: ContrastCurve;
    saturationMultiplier?: number;
    /** The output canvas ratio; when omitted the prompt asks to keep the target image's own aspect ratio. */
    aspectRatio?: string;
    targetFocusArea?: string;
    customInstructions?: string;
}

export interface TwoStepColorTransferOptions {
    referenceImage: string;
    targetImage: string;
    /**
     * Phase 1's result: the palette the extraction model read from the reference (object or its raw answer). Required:
     * the plan never makes one up.
     */
    extractedPalette: ExtractedColorPalette | string;
    preserveSkinTones?: boolean;
    contrastCurve?: ContrastCurve;
    aspectRatio?: string;
    targetFocusArea?: string;
    customInstructions?: string;
    focusArea?: 'global' | 'background' | 'subject' | 'accents';
}

export interface ColorTransferPlan {
    success: boolean;
    phase1ExtractionPrompt: string;
    extractedPalette: ExtractedColorPalette;
    phase2ApplicationPrompt: string;
    markdownSwatches: string;
    telemetry: {
        referenceImage: string;
        targetImage: string;
        aspectRatio?: string;
        preserveSkinTones: boolean;
        contrastCurve?: string;
        geometryLocked: boolean;
        globalColorOverride: boolean;
        timestamp: string;
    };
}

/**
 * Phase 1: Build the multimodal extraction prompt.
 * Instructs Gemini / Nano Banana to analyze the reference image without hallucinating
 * or morphing geometry, producing a structured palette and lighting breakdown.
 */
export function buildExtractPalettePrompt(options: ExtractPalettePromptOptions = {}): string {
    const focusArea = options.focusArea || 'global';
    const focusDirective = focusArea === 'global'
        ? 'across the entire global frame'
        : `concentrating specifically on the ${focusArea}`;

    return [
        'Analyze this image and extract its complete color palette and lighting DNA with high optical fidelity.',
        `Examine the color distribution ${focusDirective}.`,
        'Provide a structured breakdown adhering strictly to the following schema:',
        '1. PRIMARY_TONES: Dominant base colors (color names, approximate 6-digit #HEX codes, estimated coverage %, and surface roles).',
        '2. ACCENT_TONES: Secondary and accent colors (color names, approximate 6-digit #HEX codes, and focal roles).',
        '3. SHADOW_PROFILE: Shadow tone hue, its colour temperature in your own words (e.g. warm, cool, neutral, cool-neutral, or a Kelvin value), and approximate #HEX.',
        '4. HIGHLIGHT_PROFILE: Highlight tone hue, its colour temperature in your own words (e.g. warm, cool, neutral, cool-neutral, or a Kelvin value), and approximate #HEX.',
        '5. LIGHTING_ATMOSPHERE: Atmospheric lighting mood, dynamic range, and key contrast characteristics.',
        'Output clean structured JSON enclosed in ```json ``` with keys: primaryTones, accentTones, shadowProfile, highlightProfile, lightingAtmosphere, and rawSummary.'
    ].join(' ');
}

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

/**
 * Checks that a palette is complete and normalises hex codes ("#RRGGBB"). Every part the application prompt maps is
 * required (at least one primary and one accent tone, shadow and highlight tone and temperature, the lighting
 * sentence); a missing part is a MissingInputError naming it. Nothing is filled in.
 */
export function validateExtractedPalette(raw: unknown, context = 'palette'): ExtractedColorPalette {
    if (!raw || typeof raw !== 'object') {
        throw new MissingInputError(context, 'palette', 'give the palette as a JSON object (primaryTones, accentTones, shadowProfile, highlightProfile, lightingAtmosphere)');
    }
    const p = raw as any;
    const tones = (list: unknown, key: string): ExtractedColorTone[] => {
        if (!Array.isArray(list) || list.length === 0) {
            throw new MissingInputError(context, `palette.${key}`, 'needs at least one { name, hex: "#RRGGBB" } tone');
        }
        return list.map((t: any, i: number) => {
            if (!t || typeof t.name !== 'string' || !t.name.trim() || typeof t.hex !== 'string' || !HEX_COLOR.test(t.hex.trim())) {
                throw new MissingInputError(context, `palette.${key}[${i}]`, 'needs a name and a hex colour "#RRGGBB"');
            }
            const hex = t.hex.trim().toUpperCase();
            return {
                name: t.name.trim(),
                hex: hex.startsWith('#') ? hex : `#${hex}`,
                ...(typeof t.role === 'string' && t.role.trim() ? { role: t.role.trim() } : {}),
                ...(typeof t.percentage === 'number' ? { percentage: t.percentage } : {})
            };
        });
    };
    const profile = (value: any, key: string): ShadowHighlightProfile => {
        if (!value || typeof value.tone !== 'string' || !value.tone.trim() || typeof value.temperature !== 'string' || !value.temperature.trim()) {
            throw new MissingInputError(context, `palette.${key}`, 'needs { tone, temperature } (temperature in your own words, e.g. "cool", "warm-neutral", "5600K")');
        }
        if (value.hex !== undefined && (typeof value.hex !== 'string' || !HEX_COLOR.test(value.hex.trim()))) {
            throw new MissingInputError(context, `palette.${key}.hex`, 'must be "#RRGGBB" when given');
        }
        const hex = typeof value.hex === 'string' ? value.hex.trim().toUpperCase() : undefined;
        return {
            tone: value.tone.trim(),
            temperature: value.temperature.trim(),
            ...(hex ? { hex: hex.startsWith('#') ? hex : `#${hex}` } : {}),
            ...(typeof value.description === 'string' ? { description: value.description } : {})
        };
    };
    const primaryTones = tones(p.primaryTones, 'primaryTones');
    const accentTones = tones(p.accentTones, 'accentTones');
    const shadowProfile = profile(p.shadowProfile, 'shadowProfile');
    const highlightProfile = profile(p.highlightProfile, 'highlightProfile');
    if (typeof p.lightingAtmosphere !== 'string' || !p.lightingAtmosphere.trim()) {
        throw new MissingInputError(context, 'palette.lightingAtmosphere', 'needs a sentence describing the lighting');
    }
    return {
        primaryTones,
        accentTones,
        shadowProfile,
        highlightProfile,
        lightingAtmosphere: p.lightingAtmosphere.trim(),
        ...(typeof p.contrastProfile === 'string' && p.contrastProfile.trim() ? { contrastProfile: p.contrastProfile.trim() } : {}),
        rawSummary: typeof p.rawSummary === 'string' ? p.rawSummary : ''
    };
}

/**
 * Parses the extraction model's answer: the JSON object in it (a ```json block or a bare object) must hold a complete
 * palette. An answer without one, or with parts missing, is a MissingInputError; no colours are guessed from the
 * prose and no stock palette stands in.
 */
export function parseExtractedPalette(analysisText: string): ExtractedColorPalette {
    if (!analysisText || typeof analysisText !== 'string' || !analysisText.trim()) {
        throw new MissingInputError('palette extraction', 'the model\'s answer', 'the answer is empty');
    }
    const block = analysisText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate = block ? block[1] : analysisText.slice(analysisText.indexOf('{'), analysisText.lastIndexOf('}') + 1);
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate.trim());
    } catch {
        throw new MissingInputError('palette extraction', 'a JSON palette', 'the answer holds no parseable JSON object; ask the model again for the structured palette');
    }
    const palette = validateExtractedPalette(parsed, 'palette extraction');
    return { ...palette, rawSummary: palette.rawSummary || analysisText.slice(0, 300) };
}

/**
 * Phase 2: Build the exact Nano Banana application prompt.
 * Enforces:
 * 1. MANDATORY GLOBAL COLOR OVERRIDE keyword (forces total re-coloration).
 * 2. STRICT GEOMETRY LOCKING rules (100% preserves composition, outlines, and perspective).
 * 3. EXPLICIT PALETTE MAPPING (maps dominant, accents, shadows, and highlights).
 * 4. DISCARDS ORIGINAL COLOR VALUES of the target image entirely.
 */
export function buildApplyPalettePrompt(options: ApplyPaletteOptions): string {
    const paletteObj = typeof options.palette === 'string'
        ? parseExtractedPalette(options.palette)
        : validateExtractedPalette(options.palette, 'buildApplyPalettePrompt');

    const contrastCurve = options.contrastCurve || paletteObj.contrastProfile;
    const targetArea = options.targetFocusArea ? `specifically targeting the ${options.targetFocusArea}` : 'globally across all image layers';

    const primaryStr = paletteObj.primaryTones.map(t => `${t.name} (${t.hex}${t.role ? ` - ${t.role}` : ''})`).join(', ');
    const accentStr = paletteObj.accentTones.map(t => `${t.name} (${t.hex}${t.role ? ` - ${t.role}` : ''})`).join(', ');

    // Shadow & highlight directives, in the palette's own words
    const describe = (p: ShadowHighlightProfile) => `${p.tone} (${p.temperature} temperature${p.hex ? `, ${p.hex}` : ''})`;
    const shadowDesc = describe(paletteObj.shadowProfile);
    const highlightDesc = describe(paletteObj.highlightProfile);

    // Skin tones rule
    const skinToneRule = options.preserveSkinTones
        ? ' EXCEPTION FOR HUMAN SUBJECTS: Preserve natural human skin tones, facial pigments, and organic ocular tones, keeping them lifelike and uncorrupted by unnatural color shifts.'
        : '';

    // Saturation modifier
    const saturationDirective = options.saturationMultiplier && options.saturationMultiplier !== 1.0
        ? ` Apply a saturation scaling factor of ${options.saturationMultiplier.toFixed(2)}x to the transferred color grade.`
        : '';

    // Contrast directive: written-out wording for the named curves, the caller's own words otherwise, none when unset
    const contrastDirectives: Record<string, string> = {
        cinematic: 'Apply cinematic contrast curve with soft highlight rolloff and rich deep blacks.',
        natural: 'Apply natural linear contrast with unclipped highlights and true midtone fidelity.',
        'high-contrast': 'Apply dramatic high-contrast grading with sharp delineation between light and shadow.',
        muted: 'Apply low-contrast muted grading with lifted shadows and soft filmic pastel midtones.'
    };
    const contrastStr = contrastCurve
        ? ` ${Object.prototype.hasOwnProperty.call(contrastDirectives, contrastCurve) ? contrastDirectives[contrastCurve] : `Apply ${contrastCurve} contrast grading.`}`
        : '';

    const canvas = options.aspectRatio
        ? `Canvas Aspect Ratio: Strictly maintain ${options.aspectRatio}.`
        : 'Canvas Aspect Ratio: Keep the target image\'s own aspect ratio.';
    const custom = options.customInstructions ? ` ${options.customInstructions.trim()}` : '';

    return [
        `Using the uploaded target image as the strict composition and structural blueprint, apply a GLOBAL COLOR OVERRIDE ${targetArea}.`,
        'CRITICAL GEOMETRY & STRUCTURAL LOCKING — NON-NEGOTIABLE:',
        '(1) Preserve the exact 100% identical composition, perspective, camera angle, focal length, framing, and horizon line of the target image.',
        '(2) Keep all objects, characters, buildings, outlines, silhouettes, and fine structural lines exactly in their original pixel coordinates — do NOT pan, zoom, crop, warp, recompose, or introduce new objects.',
        '(3) Completely discard and ignore the target image\'s original color values, tints, and previous lighting.',
        'PALETTE MAPPING SPECIFICATION:',
        `- Dominant Base Tones: Map ${primaryStr} across ambient background, environmental fill, and major surfaces.`,
        `- Accent & Specular Tones: Map ${accentStr} strictly to key focal accents, dynamic specular highlights, and active elements.`,
        `- Shadows: Map dark regions and ambient occlusion to ${shadowDesc}.`,
        `- Highlights: Map direct illumination and illuminated surfaces to ${highlightDesc}.`,
        `- Atmosphere & Contrast: ${paletteObj.lightingAtmosphere}.${contrastStr}${saturationDirective}`,
        `${canvas}${skinToneRule}${custom}`,
        'Harmonized color grading, professional master color grading, clean artifact-free rendering.'
    ].join(' ');
}

/**
 * Format extracted palette into rich GitHub markdown with visual color cards.
 */
export function formatPaletteAsMarkdown(palette: ExtractedColorPalette): string {
    const lines: string[] = [];

    lines.push('### 🎨 Extracted Nano Banana Color Palette & Lighting DNA');
    lines.push('');
    lines.push(`**Atmospheric Mood:** ${palette.lightingAtmosphere}`);
    if (palette.contrastProfile) lines.push(`**Contrast Profile:** \`${palette.contrastProfile}\``);
    lines.push('');
    lines.push('| Category | Tone Name | HEX Code | Role | Temperature |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');

    for (const tone of palette.primaryTones) {
        lines.push(`| **Primary Base** | ${tone.name} | \`${tone.hex}\` | ${tone.role || '—'} | — |`);
    }
    for (const tone of palette.accentTones) {
        lines.push(`| **Accent** | ${tone.name} | \`${tone.hex}\` | ${tone.role || '—'} | — |`);
    }
    lines.push(`| **Shadow Profile** | ${palette.shadowProfile.tone} | \`${palette.shadowProfile.hex || '—'}\` | Shadow / AO | ${palette.shadowProfile.temperature} |`);
    lines.push(`| **Highlight Profile** | ${palette.highlightProfile.tone} | \`${palette.highlightProfile.hex || '—'}\` | Direct Illumination | ${palette.highlightProfile.temperature} |`);

    return lines.join('\n');
}

/**
 * Method 2 as a plan: the Phase 1 extraction prompt for the reference, and the Phase 2 application prompt built from
 * the palette the extraction model actually read (options.extractedPalette). Without that palette there is no plan.
 */
export function executeTwoStepColorTransfer(options: TwoStepColorTransferOptions): ColorTransferPlan {
    if (options?.extractedPalette === undefined || options.extractedPalette === null || options.extractedPalette === '') {
        throw new MissingInputError('executeTwoStepColorTransfer', 'extractedPalette',
            'run the Phase 1 prompt on the reference image with an image-understanding model and pass its palette; none is made up');
    }
    const phase1Prompt = buildExtractPalettePrompt({
        referenceImageUrl: options.referenceImage,
        focusArea: options.focusArea
    });
    const extractedPalette = typeof options.extractedPalette === 'string'
        ? parseExtractedPalette(options.extractedPalette)
        : validateExtractedPalette(options.extractedPalette, 'executeTwoStepColorTransfer');

    const phase2Prompt = buildApplyPalettePrompt({
        targetImageUrl: options.targetImage,
        palette: extractedPalette,
        preserveSkinTones: options.preserveSkinTones,
        contrastCurve: options.contrastCurve,
        aspectRatio: options.aspectRatio,
        targetFocusArea: options.targetFocusArea,
        customInstructions: options.customInstructions
    });

    return {
        success: true,
        phase1ExtractionPrompt: phase1Prompt,
        extractedPalette,
        phase2ApplicationPrompt: phase2Prompt,
        markdownSwatches: formatPaletteAsMarkdown(extractedPalette),
        telemetry: {
            referenceImage: options.referenceImage,
            targetImage: options.targetImage,
            aspectRatio: options.aspectRatio,
            preserveSkinTones: !!options.preserveSkinTones,
            contrastCurve: options.contrastCurve || extractedPalette.contrastProfile,
            geometryLocked: true,
            globalColorOverride: true,
            timestamp: new Date().toISOString()
        }
    };
}

/**
 * NanoBananaColorService Facade
 */
export class NanoBananaColorService {
    static readonly buildExtractPalettePrompt = buildExtractPalettePrompt;
    static readonly parseExtractedPalette = parseExtractedPalette;
    static readonly validateExtractedPalette = validateExtractedPalette;
    static readonly buildApplyPalettePrompt = buildApplyPalettePrompt;
    static readonly formatPaletteAsMarkdown = formatPaletteAsMarkdown;
    static readonly transferColor = executeTwoStepColorTransfer;
}
