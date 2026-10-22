/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Search-grounded reference images of a real place: a Gemini image model with Google Search turned on looks the subject up
 * (its queries and sources are kept) and draws a faithful reference of it from the view asked for, with a short written
 * account of what it found. It answers what a scan cannot resolve: what tops a dome, how many ribs it has, a facade's
 * window rhythm and ornament, what a paving or cladding really looks like (the Flinders Street Station dome, 2026-10-22: the
 * scan showed a 2 m spike; both models found a windowed lantern crowned by a small cupola and a finial, and many raised ribs).
 *
 * A reference is a generated image, not a photograph and never a measurement: the scan and the vector data decide
 * geometry and size; a reference decides unresolved detail only where independent references (one per model) agree and the
 * scan does not contradict them. Every reference is labelled generated with its basis, queries and sources.
 */

import type { SkippedMediaModel } from '../../common/media-generation-protocol';

/** Independent references come from different models (the same model asked twice tends to repeat itself). */
export const GROUNDED_REFERENCE_MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-image'];

export interface GroundedReferenceRequest {
    /** The real place, as a name or address ("Flinders Street Station, Melbourne"). */
    place: string;
    /** What to show ("the dome and its lantern", "the facade facing Swanston Street", "the plaza paving close up"). */
    subject: string;
    /** Where the view is from ("from Flinders Street at eye level", "straight on, orthographic", "from above"). */
    view?: string;
    /** Questions the written account must answer ("what stands on the lantern", "how the dome surface is divided"). */
    questions?: string[];
    aspectRatio?: string;
}

export interface GroundedReference {
    model: string;
    modelVersion?: string;
    image?: { data: Buffer; mimeType: string };
    /** The model's written account of what it found. */
    account: string;
    queries: string[];
    sources: Array<{ title?: string; uri?: string }>;
}

export interface GroundedReferenceResult {
    references: GroundedReference[];
    /** Models that gave no reference, with why. */
    skipped: SkippedMediaModel[];
    prompt: string;
    provenance: { label: 'generated'; basis: 'search-grounded reference'; note: string };
}

export function groundedReferencePrompt(req: GroundedReferenceRequest): string {
    const questions = req.questions?.length ? ` Then answer in a short paragraph: ${req.questions.join('; ')}.` : ' Then describe in a short paragraph what you found about its form, materials and details.';
    return `Use Google Search to find real photographs of ${req.subject} of ${req.place}, and make an accurate photographic reference image of it`
        + `${req.view ? `, seen ${req.view}` : ''}. Be faithful to the real place as it is today: its proportions, divisions, ornament, materials and colours; `
        + 'do not invent or embellish anything you did not find. Even daylight, no people or vehicles in front of the subject.' + questions;
}

/** The surface of @google/genai's client used here (injectable for tests). */
export interface GroundedReferenceClient {
    models: { generateContent(request: any): Promise<any> };
}

/**
 * One reference per model, asked in parallel. A model that fails or answers without an image is recorded as skipped with
 * why; the result fails only when no model gave a reference.
 */
export async function fetchGroundedReferences(client: GroundedReferenceClient, req: GroundedReferenceRequest, opts: { models?: string[]; signal?: AbortSignal } = {}): Promise<GroundedReferenceResult> {
    const prompt = groundedReferencePrompt(req);
    const models = opts.models?.length ? opts.models : GROUNDED_REFERENCE_MODELS;
    const skipped: SkippedMediaModel[] = [];
    const answers = await Promise.all(models.map(async (model): Promise<GroundedReference | undefined> => {
        try {
            const r = await client.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    tools: [{ googleSearch: {} }],
                    ...(req.aspectRatio ? { imageConfig: { aspectRatio: req.aspectRatio } } : {}),
                    ...(opts.signal ? { abortSignal: opts.signal } : {})
                }
            });
            const cand = r?.candidates?.[0];
            const parts: any[] = cand?.content?.parts ?? [];
            const img = parts.find(p => p?.inlineData?.data);
            const account = parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text.trim()).join(' ').trim();
            const g = cand?.groundingMetadata ?? {};
            const queries: string[] = [...(g.webSearchQueries ?? []), ...(g.imageSearchQueries ?? [])].filter((q: unknown): q is string => typeof q === 'string');
            const sources = (g.groundingChunks ?? []).map((c: any) => ({ title: c?.web?.title ?? c?.image?.title, uri: c?.web?.uri ?? c?.image?.uri })).filter((s: { title?: string; uri?: string }) => s.title || s.uri);
            if (!img) {
                skipped.push({ model, code: 'unsupported', reason: `no image in the answer${cand?.finishReason ? ` (${cand.finishReason})` : ''}` });
                return undefined;
            }
            return { model, modelVersion: r?.modelVersion, image: { data: Buffer.from(img.inlineData.data, 'base64'), mimeType: img.inlineData.mimeType || 'image/png' }, account, queries, sources };
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            skipped.push({ model, code: 'unsupported', reason: (e as Error).message.slice(0, 240) });
            return undefined;
        }
    }));
    const references = answers.filter((a): a is GroundedReference => !!a);
    if (!references.length) throw new Error(`No model gave a search-grounded reference: ${skipped.map(s => `${s.model}: ${s.reason}`).join('; ')}`);
    return {
        references, skipped, prompt,
        provenance: { label: 'generated', basis: 'search-grounded reference', note: 'Drawn by an image model from what Google Search found; a reference for detail the scan cannot resolve, never a measurement. Use what independent references agree on and the scan does not contradict.' }
    };
}
