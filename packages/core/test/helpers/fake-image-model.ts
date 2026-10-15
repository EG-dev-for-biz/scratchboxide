/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Test-only stand-in for the Google Gen AI client's image models. It answers each generateContent call with the
 * first PNG it was sent, recoloured (so geometry QC that compares edges with the blockout passes), or with a flat
 * colour. It records every call. Production code has no such generator; tests inject this client (for example with
 * vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient')) so no real model is ever reached.
 */

import { decodePng, encodePng } from '../../src/node/texture-processing';

export interface FakeImageCall {
    model: string;
    aspectRatio?: string;
    imageSize?: string;
}

export interface FakeImageModelOptions {
    /** Model id the fake reports in modelVersion (default: the id it was asked for). */
    modelVersion?: string;
    /** Answer with this flat colour instead of the recoloured input image. */
    flat?: [number, number, number];
    /** Size of a flat answer (default 64 x 64). */
    flatSize?: [number, number];
    /** Per-channel multipliers applied to the echoed input image (default a warm tint). */
    tint?: [number, number, number];
}

function firstInputPng(contents: unknown): Buffer | undefined {
    const parts: any[] = [];
    for (const entry of Array.isArray(contents) ? contents : [contents]) {
        if (entry && Array.isArray((entry as any).parts)) parts.push(...(entry as any).parts);
        else parts.push(entry);
    }
    const image = parts.find(p => p?.inlineData?.data && /png/.test(p.inlineData.mimeType || 'image/png'));
    return image ? Buffer.from(image.inlineData.data, 'base64') : undefined;
}

export function fakeImageModelClient(calls: FakeImageCall[] = [], options: FakeImageModelOptions = {}) {
    return {
        models: {
            generateContent: async ({ model, contents, config }: { model: string; contents: unknown; config?: any }) => {
                calls.push({ model, aspectRatio: config?.imageConfig?.aspectRatio, imageSize: config?.imageConfig?.imageSize });
                let png: Buffer;
                const input = options.flat ? undefined : firstInputPng(contents);
                if (input) {
                    const decoded = decodePng(input);
                    const tint = options.tint || [1.05, 0.95, 0.8];
                    const out = Buffer.from(decoded.rgba);
                    for (let i = 0; i < out.length; i += 4) {
                        for (let k = 0; k < 3; k++) out[i + k] = Math.min(255, Math.round(out[i + k] * tint[k]));
                    }
                    png = encodePng(decoded.width, decoded.height, out);
                } else {
                    const [w, h] = options.flatSize || [64, 64];
                    const color = options.flat || [128, 128, 128];
                    const rgba = Buffer.alloc(w * h * 4);
                    for (let i = 0; i < w * h; i++) {
                        rgba[i * 4] = color[0]; rgba[i * 4 + 1] = color[1]; rgba[i * 4 + 2] = color[2]; rgba[i * 4 + 3] = 255;
                    }
                    png = encodePng(w, h, rgba);
                }
                return {
                    modelVersion: options.modelVersion || model,
                    candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }]
                };
            }
        }
    };
}
