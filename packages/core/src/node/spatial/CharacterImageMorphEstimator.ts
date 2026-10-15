/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import {
    CharacterMorphRequest,
    CharacterMorphResponse,
    CharacterAnatomicalRatios,
    CharacterImageSource
} from '../../common/character-morph-protocol';
import { CharacterSilhouetteSolver } from './CharacterSilhouetteSolver';
import { GeminiClient, DEFAULT_GEMINI_MODEL } from '../gemini/gemini-client';

/** The single-view proportions the model must state; none is filled in for it. */
const REQUIRED_RATIOS = ['headsTall', 'shoulderToHipRatio', 'waistCinchRatio', 'bustVolumeScore', 'legToTorsoRatio', 'muscularityScore', 'genderDimorphism'] as const;

export class CharacterImageMorphEstimator {
    private geminiClient: GeminiClient;

    constructor(geminiClient?: GeminiClient) {
        this.geminiClient = geminiClient ?? new GeminiClient();
    }

    /**
     * Estimates anatomical proportions and 8-mode PCA blendshapes (\vec{\beta})
     * from one or more character concept art images.
     */
    public async estimateMorphFromImages(
        request: CharacterMorphRequest
    ): Promise<CharacterMorphResponse> {
        if (!request.images || request.images.length === 0) {
            return { success: false, error: 'No character images were provided, so there is nothing to measure.' };
        }

        try {
            // 1. Process image payloads into base64 inline parts
            const processedImages = await Promise.all(
                request.images.map(img => this.normalizeImagePayload(img))
            );

            // 2. Synthesize multimodal prompt for Gemini Vision
            const prompt = this.buildPrompt(request);

            // 3. Multimodal inference via GeminiClient (same credential rule as chat)
            const answer = await this.invokeVisionModel(prompt, processedImages);
            if (!answer.text) {
                return { success: false, error: `${DEFAULT_GEMINI_MODEL} returned an empty reply.` };
            }

            // 4. Parse structured anatomical deduction
            const parsed = this.parseVisionJson(answer.text);
            if (!parsed) {
                return { success: false, error: `${DEFAULT_GEMINI_MODEL} did not return the proportions JSON.` };
            }

            // 5. Multi-view fusion if view breakdown exists; otherwise the model's own single-view ratios, all of them.
            let ratios: CharacterAnatomicalRatios;
            if (parsed.views && Array.isArray(parsed.views) && parsed.views.length > 0) {
                ratios = CharacterSilhouetteSolver.fuseMultiViewObservations(parsed.views);
            } else {
                const missing = REQUIRED_RATIOS.filter(k => typeof parsed[k] !== 'number' || !Number.isFinite(parsed[k]));
                if (missing.length > 0) {
                    return { success: false, error: `${DEFAULT_GEMINI_MODEL}'s reply lacks ${missing.join(', ')}, so no proportions were measured.` };
                }
                ratios = {
                    headsTall: parsed.headsTall,
                    shoulderToHipRatio: parsed.shoulderToHipRatio,
                    waistCinchRatio: parsed.waistCinchRatio,
                    bustVolumeScore: parsed.bustVolumeScore,
                    legToTorsoRatio: parsed.legToTorsoRatio,
                    muscularityScore: parsed.muscularityScore,
                    genderDimorphism: parsed.genderDimorphism,
                    ...(typeof parsed.headWidthToHeightRatio === 'number' ? { headWidthToHeightRatio: parsed.headWidthToHeightRatio } : {})
                };
            }

            // 6. Solve for 8-mode PCA \vec{\beta}
            const betas = CharacterSilhouetteSolver.solveBetasFromRatios(ratios, request.heightMeters);

            return {
                success: true,
                ratios,
                betas,
                ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
                ...(typeof parsed.explanation === 'string' ? { explanation: parsed.explanation } : {}),
                ...(typeof parsed.matchedArchetype === 'string' ? { matchedArchetype: parsed.matchedArchetype } : {}),
                modelUsed: DEFAULT_GEMINI_MODEL,
                credential: answer.credential,
                ...(answer.credentialNote ? { credentialNote: answer.credentialNote } : {})
            };
        } catch (err: any) {
            return { success: false, error: `The character proportions could not be measured: ${err?.message || String(err)}` };
        }
    }

    /**
     * Normalizes image source (file path, data URI, or raw base64) into standard base64 and mime type.
     */
    private async normalizeImagePayload(src: CharacterImageSource): Promise<{ base64: string; mimeType: string }> {
        let raw = src.imageData.trim();
        let mimeType = src.mimeType || 'image/png';

        if (raw.startsWith('data:')) {
            const commaIdx = raw.indexOf(',');
            if (commaIdx !== -1) {
                const header = raw.substring(0, commaIdx);
                const match = header.match(/data:(.*?);base64/);
                if (match) mimeType = match[1];
                raw = raw.substring(commaIdx + 1);
            }
        } else if (raw.length < 1024 && (fs.existsSync(raw) || path.isAbsolute(raw))) {
            const buf = await fs.readFile(raw);
            raw = buf.toString('base64');
            const ext = path.extname(raw).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.webp') mimeType = 'image/webp';
        }

        return { base64: raw, mimeType };
    }

    private buildPrompt(request: CharacterMorphRequest): string {
        return `You are Scratchbox IDE's Spatial Character Anatomy & Morph Deduction Engine.
Analyze the provided 2D character concept art / drawing / illustration and extract accurate anatomical proportions and silhouette measurements.

CONTEXT / HINTS:
- Gender Hint: ${request.genderHint || 'auto'}
- Style Hint: ${request.styleHint || 'auto'}
- Target Metric Stature: ${request.heightMeters ? request.heightMeters + 'm' : 'Standard'}

REQUIRED EXTRACTIONS:
1. headsTall: Total body height measured in head-height units (e.g. 4.0-5.5 = Chibi, 6.0-7.0 = Manga, 7.3-7.6 = Standard Drawing Figure, 8.0-9.0 = Heroic).
2. shoulderToHipRatio: Biacromial shoulder width divided by pelvic width (>1.15 = V-taper, 1.0-1.08 = balanced, <0.96 = Hourglass).
3. waistCinchRatio: Narrowest waist width divided by maximum pelvic width (0.55-0.70 = feminine hourglass cinch, 0.75-0.88 = athletic column).
4. bustVolumeScore: Anterior bust / chest projection [0.0 = flat male pectoral plate, 0.4-0.6 = moderate teardrop, 0.8-1.0 = voluminous].
5. legToTorsoRatio: Inseam leg length divided by torso height (0.95 = compact, 1.02 = realistic, 1.25 = long-legged anime).
6. muscularityScore: Muscular definition [-1.0 = slender/lithe, 0.0 = standard drawing figure, +1.0 = heavily muscled].
7. genderDimorphism: Morphological dimorphism [-1.0 = full feminine curves, 0.0 = neutral drawing figure, +1.0 = masculine planes].
8. matchedArchetype: Descriptive string of the character style.
9. explanation: 2-3 sentence rationale describing the detected visual silhouettes.

Respond STRICTLY with valid JSON in this exact structure:
{
  "headsTall": number,
  "shoulderToHipRatio": number,
  "waistCinchRatio": number,
  "bustVolumeScore": number,
  "legToTorsoRatio": number,
  "muscularityScore": number,
  "genderDimorphism": number,
  "headWidthToHeightRatio": number,
  "confidence": number,
  "matchedArchetype": string,
  "explanation": string
}`;
    }

    /** The vision model's reply text and the credential that answered; a failed request throws its error. */
    private async invokeVisionModel(
        prompt: string,
        images: Array<{ base64: string; mimeType: string }>
    ): Promise<{ text: string; credential: 'vertex' | 'api-key'; credentialNote?: string }> {
        const contents: any[] = [
            {
                role: 'user',
                parts: [
                    { text: prompt },
                    ...images.map(img => ({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.base64
                        }
                    }))
                ]
            }
        ];

        const { json, credential, credentialNote } = await this.geminiClient.requestGenerateContent(
            DEFAULT_GEMINI_MODEL,
            contents,
            undefined,
            { temperature: 0.1, maxOutputTokens: 1024 }
        );
        return { text: json?.candidates?.[0]?.content?.parts?.[0]?.text || '', credential, ...(credentialNote ? { credentialNote } : {}) };
    }

    private parseVisionJson(text: string): any | null {
        try {
            // Strip markdown fences if present
            let cleaned = text.trim();
            if (cleaned.startsWith('```json')) {
                cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
            } else if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
            }
            return JSON.parse(cleaned);
        } catch {
            return null;
        }
    }
}
