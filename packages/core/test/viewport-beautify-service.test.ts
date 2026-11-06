/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's quick AI Beautify (viewport-beautify-service.ts): the prompt it builds for a scene staged at a real
 * place versus one that is not, that it always keeps the scene's own light (never the even-overcast survey light),
 * and that beautifyViewportFrame sends the frame inline (never through the asset store) and never substitutes an
 * image when the model call fails. No credentials are reachable here (tests never bill): the media service is a stub.
 */

import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import {
    beautifyViewportFrame,
    buildViewportBeautifyPrompt,
    KEEP_SCENE_LIGHT_SENTENCE,
    QUICK_BEAUTIFY_IMAGE_MODELS,
    QUICK_BEAUTIFY_IMAGE_SIZE,
    type ViewportBeautifyDeps
} from '../src/node/spatial/viewport-beautify-service';
import type { ImageGenerationRequest, MediaAssetRef, MediaGenerationResult } from '../src/common/media-generation-protocol';
import { IMAGE_MODEL_ALIASES, IMAGE_MODEL_PRIORITY } from '../src/common/media-generation-protocol';

const FRAME = { bytes: encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(200), 4), mimeType: 'image/png' as const };

describe('buildViewportBeautifyPrompt', () => {
    it('names the real place, its coordinates and heading when the scene has a geoAnchor', () => {
        const { prompt, aspectRatio } = buildViewportBeautifyPrompt({
            sceneName: 'Empire State Building, 350 5th Av...',
            place: { name: 'Empire State Building', lat: 40.748817, lng: -73.985428 },
            headingDeg: 190,
            width: 1920,
            height: 1080
        });
        expect(prompt).toContain('Empire State Building');
        expect(prompt).toContain('40.748817');
        expect(prompt).toContain('facing 190°');
        expect(prompt).toContain('malformed 3D photogrammetry render');
        expect(aspectRatio).toBe('16:9');
    });

    it('names no place, coordinates or heading for a scene with no geoAnchor (buildClayRenderBeautifyPrompt)', () => {
        const { prompt } = buildViewportBeautifyPrompt({ sceneName: 'A sculpted prop', width: 1024, height: 1024 });
        expect(prompt).toContain('A sculpted prop');
        expect(prompt).not.toMatch(/-?\d+\.\d{6},\s*-?\d+\.\d{6}/);
        expect(prompt).not.toContain('facing');
        expect(prompt).toContain('3D clay rendering');
    });

    it('always keeps the scene\'s own light, with or without a place (AGENTS.md §4: the deliverable keeps its own light)', () => {
        const withPlace = buildViewportBeautifyPrompt({ sceneName: 'x', place: { lat: 1, lng: 2 }, width: 16, height: 9 });
        const withoutPlace = buildViewportBeautifyPrompt({ sceneName: 'x', width: 16, height: 9 });
        expect(withPlace.prompt).toContain(KEEP_SCENE_LIGHT_SENTENCE);
        expect(withoutPlace.prompt).toContain(KEEP_SCENE_LIGHT_SENTENCE);
        // never the even-overcast survey sentence, which contradicts "keep the light"
        expect(withPlace.prompt).not.toContain('bright overcast sky');
        expect(withoutPlace.prompt).not.toContain('bright overcast sky');
    });

    it('picks the nearest accepted aspect ratio from the captured frame size', () => {
        expect(buildViewportBeautifyPrompt({ sceneName: 'x', width: 1280, height: 720 }).aspectRatio).toBe('16:9');
        expect(buildViewportBeautifyPrompt({ sceneName: 'x', width: 1080, height: 1920 }).aspectRatio).toBe('9:16');
        expect(buildViewportBeautifyPrompt({ sceneName: 'x', width: 1000, height: 1000 }).aspectRatio).toBe('1:1');
    });
});

describe('QUICK_BEAUTIFY_IMAGE_MODELS / QUICK_BEAUTIFY_IMAGE_SIZE', () => {
    it('asks the fast Lite model first, then the standard models, at 1K (the fastest supported quick pass)', () => {
        expect(QUICK_BEAUTIFY_IMAGE_MODELS[0]).toBe(IMAGE_MODEL_ALIASES['nano-banana-lite']);
        expect(QUICK_BEAUTIFY_IMAGE_MODELS.slice(1)).toEqual(IMAGE_MODEL_PRIORITY);
        expect(QUICK_BEAUTIFY_IMAGE_SIZE).toBe('1K');
    });
});

function stubDeps(gen: (req: ImageGenerationRequest, options?: { signal?: AbortSignal; inlineSource?: { data: Buffer; mimeType: string } }) => Promise<MediaGenerationResult>): ViewportBeautifyDeps {
    const answerBytes = encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(10), 4);
    return {
        mediaService: { generateImage: gen },
        assetStore: { resolve: (_root: string, asset: MediaAssetRef) => asset.uri },
        workspaceRoot: '/workspace',
        readFile: async () => answerBytes
    };
}

describe('beautifyViewportFrame', () => {
    it('sends the frame inline (never through sourceAsset/the asset store) and returns a PNG naming the model used', async () => {
        let seenInline: { data: Buffer; mimeType: string } | undefined;
        let seenRequest: ImageGenerationRequest | undefined;
        const deps = stubDeps(async (req, options) => {
            seenRequest = req;
            seenInline = options?.inlineSource;
            return { asset: { uri: 'mem://x', contentHash: 'h', mimeType: 'image/png', byteLength: 4 }, modelUsed: 'gemini-3.1-flash-lite-image' };
        });
        const out = await beautifyViewportFrame(FRAME, { sceneName: 'My Scene', width: 800, height: 450 }, deps);
        expect(seenInline?.data.equals(FRAME.bytes)).toBe(true);
        expect(seenRequest?.sourceAsset).toBeUndefined();
        expect(seenRequest?.imageSize).toBe('1K');
        expect(seenRequest?.modelPriority).toEqual([...QUICK_BEAUTIFY_IMAGE_MODELS]);
        expect(out.modelUsed).toBe('gemini-3.1-flash-lite-image');
        expect(out.png[0]).toBe(0x89);
        expect(out.png[1]).toBe(0x50);
    });

    it('throws the model\'s own error rather than returning a placeholder image', async () => {
        const deps = stubDeps(async () => {
            throw new Error('no Gemini API key configured');
        });
        await expect(beautifyViewportFrame(FRAME, { sceneName: 'x', width: 16, height: 9 }, deps)).rejects.toThrow('no Gemini API key configured');
    });

    it('rejects an empty frame before calling the model', async () => {
        let called = false;
        const deps = stubDeps(async () => {
            called = true;
            return { asset: { uri: 'mem://x', contentHash: 'h', mimeType: 'image/png', byteLength: 0 }, modelUsed: 'x' };
        });
        await expect(beautifyViewportFrame({ bytes: Buffer.alloc(0), mimeType: 'image/png' }, { sceneName: 'x', width: 16, height: 9 }, deps)).rejects.toThrow('empty');
        expect(called).toBe(false);
    });
});
