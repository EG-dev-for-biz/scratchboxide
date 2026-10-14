/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Document images are generated images or nothing, credited to the model that made them.
 *
 * A failed image job used to put a hard-coded catalog image (NANO_BANANA_IMAGE_CATALOG) into the section with the
 * credit "Generated with Nano Banana Pro"; sections without an image showed an Unsplash stock photo credited to
 * "Nano Banana Synthesis"; a successful job was always credited to "Google Nano Banana 2" whatever model answered.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownDocumentPrimitive, SectionMediaNotice, sectionMediaFailure, sectionMediaFromJob } from '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
import { synthesizeContextualNanoBananaPrompt } from '../src/browser/generative-canvas/nano-banana-service';
import * as nanoBanana from '../src/browser/generative-canvas/nano-banana-service';
import { generateMotivatedEditorialImageSection, generateMotivatedVideoSection } from '../src/browser/generative-canvas/document-synthesis-engine';
import type { MarkdownDocumentData } from '../src/browser/generative-canvas/canvas-types';
import type { MediaGenerationJob } from '../src/common/media-generation-protocol';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const job = (modelUsed: string): MediaGenerationJob => ({
    id: 'job-1', status: 'completed', request: { kind: 'image', prompt: 'p', workspaceRoot: '/tmp' } as any,
    createdAt: 'now', updatedAt: 'now', modelUsed,
    result: { asset: { id: 'a', uri: 'file:///a.png' } as any, modelUsed }
});

describe('document image sections', () => {
    it('credits a generated image to the model that actually made it', () => {
        expect(sectionMediaFromJob(job('gemini-3-pro-image'), '/media/job-1', false, 'gemini-3-pro-image')).toEqual({
            imageUrl: '/media/job-1', thumbnailUrl: '/media/job-1', videoUrl: undefined,
            attribution: 'Generated with gemini-3-pro-image', mediaError: undefined
        });
        expect(sectionMediaFromJob(job('gemini-3.1-flash-image'), '/media/job-1', false, 'gemini-3-pro-image').attribution)
            .toBe('Generated with gemini-3.1-flash-image (requested gemini-3-pro-image, which did not answer)');
    });

    it('a failed job records the job\'s error and changes no image', () => {
        const patch = sectionMediaFailure(new Error('RESOURCE_EXHAUSTED: quota exceeded for gemini-3-pro-image'), false);
        expect(patch).toEqual({ mediaError: 'Image generation failed: RESOURCE_EXHAUSTED: quota exceeded for gemini-3-pro-image' });
        expect(patch).not.toHaveProperty('imageUrl');
        expect(patch).not.toHaveProperty('attribution');
    });

    it('the curated catalog is gone and prompts carry no image', () => {
        expect((nanoBanana as any).NANO_BANANA_IMAGE_CATALOG).toBeUndefined();
        expect((nanoBanana as any).lookupCuratedNanoBananaImage).toBeUndefined();
        const synth = synthesizeContextualNanoBananaPrompt({ docTitle: '1776', sectionTitle: 'Signing of the Declaration' });
        expect(Object.keys(synth).sort()).toEqual(['prompt', 'styleLabel']);
        for (const sec of [generateMotivatedEditorialImageSection('1776-revolution', 'Crossing'), generateMotivatedVideoSection('1776-revolution')]) {
            expect(sec.imageUrl).toBeUndefined();
            expect(sec.thumbnailUrl).toBeUndefined();
            expect(sec.attribution).toBeUndefined();
        }
    });

    const docWith = (section: Record<string, unknown>): MarkdownDocumentData => ({ title: 'Doc', sections: [{ id: 's1', type: 'editorial-image', imageTitle: 'Harbor at dawn', ...section } as any] });

    it('a section without an image says so, with no stock photo or model credit', () => {
        const html = renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data: docWith({}) }));
        expect(html).toContain('data-testid="sb-doc-media-missing"');
        expect(html).not.toContain('unsplash');
        expect(html).not.toContain('Nano Banana Synthesis');
        expect(html).not.toMatch(/<img[^>]+sb-editorial-image-element/);
    });

    it('a section whose generation failed shows the error', () => {
        const html = renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data: docWith({ mediaError: 'Image generation failed: 503 UNAVAILABLE' }) }));
        expect(html).toContain('data-testid="sb-doc-media-error"');
        expect(html).toContain('Image generation failed: 503 UNAVAILABLE');
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the failed-generation notice', htmlScreenshotChrome), async () => {
        const html = renderToStaticMarkup(React.createElement(SectionMediaNotice, { kind: 'image', error: 'Image generation failed: RESOURCE_EXHAUSTED: quota exceeded for gemini-3-pro-image' }));
        const shot = await saveHtmlScreenshot('document_image_generation_failed', `<div style="width:520px;margin:16px">${html}</div>`, { width: 560, height: 170, background: '#0f0f12' });
        const { data } = decodePng(shot.png);
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 40 && data[i] > data[i + 1] * 1.6 && data[i] > data[i + 2] * 1.6) red++;
        expect(red).toBeGreaterThan(2000);
    });
});
