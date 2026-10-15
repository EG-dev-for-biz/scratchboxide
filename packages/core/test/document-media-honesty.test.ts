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
import { MarkdownDocumentPrimitive, SectionMediaNotice, formatCoordinates, newEmptySection, newLocationSection, sectionMediaFailure, sectionMediaFromJob } from '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
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
    it('credits a generated image to the model that actually made it, and claims no fallback it cannot see', () => {
        expect(sectionMediaFromJob(job('gemini-3-pro-image'), '/media/job-1', false)).toEqual({
            imageUrl: '/media/job-1', thumbnailUrl: '/media/job-1', videoUrl: undefined,
            attribution: 'Generated with gemini-3-pro-image', mediaError: undefined
        });
        // A versioned id from the API is the same model; nothing compares it to a requested id string.
        expect(sectionMediaFromJob(job('gemini-3.1-flash-image-preview'), '/media/job-1', false).attribution)
            .toBe('Generated with gemini-3.1-flash-image-preview');
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

    it('a new location section has no place, coordinates, photo or credit until someone gives them', () => {
        const sec = newLocationSection('loc-1');
        expect(sec).toEqual({ id: 'loc-1', type: 'location-image' });
        const html = renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data: { title: 'Quarterly Revenue Review', sections: [sec] } }));
        expect(html).toContain('data-testid="sb-doc-media-missing"');
        expect(html).toContain('Untitled location');
        expect(html).not.toContain('unsplash');
        expect(html).not.toContain('San Francisco');
        expect(html).not.toContain('Historical Landmark');
        expect(html).not.toMatch(/<img[^>]+sb-location-image-element/);
    });

    it('an inserted section is empty: nothing is written into it from the document\'s keywords', () => {
        const types = ['heading', 'paragraph', 'editorial-image', 'video', 'svg-diagram', 'citation', 'callout', 'table', 'checklist', 'code', 'location-image'] as const;
        const sections = types.map((t, i) => newEmptySection(`s${i}`, t));
        for (const sec of sections) {
            const text = JSON.stringify(sec);
            expect(text, sec.type).not.toMatch(/1776|Zero-Trust|Attention Is All You Need|Strategic|Architecture|Revolution|unsplash|verified/i);
        }
        expect(sections.find(s => s.type === 'citation')?.citationItems).toEqual([]);
        // A 1776 document still gets empty inserts (the theme detector no longer picks canned text).
        const html = renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data: { title: 'The importance of 1776', sections } }));
        expect(html).not.toMatch(/Historical Turning Point|Common Sense Published|Delaware Crossing|Verified Sources|Enlightenment political theory/);
    });

    it('a citation list is called verified only when every source carries verification', () => {
        const render = (items: any[]) => renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data: { title: 'Refs', sections: [{ id: 'c', type: 'citation', citationItems: items } as any] } }));
        expect(render([{ id: 'a', sourceTitle: 'Model-cited paper', url: 'https://example.org/a' }])).not.toContain('Verified Sources');
        expect(render([{ id: 'g', sourceTitle: 'Grounded page', url: 'https://example.org/g', verified: true }])).toContain('Verified Sources');
    });

    it('location coordinates name the hemisphere their sign puts them in', () => {
        expect(formatCoordinates({ lat: 37.7749, lng: -122.4194 })).toBe('37.7749° N, 122.4194° W');
        expect(formatCoordinates({ lat: -33.8568, lng: 151.2153 })).toBe('33.8568° S, 151.2153° E');
        const html = renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, {
            data: { title: 'Trip', sections: [{ id: 'l', type: 'location-image', locationName: 'Sydney Opera House', coordinates: { lat: -33.8568, lng: 151.2153 } } as any] }
        }));
        expect(html).toContain('33.8568° S, 151.2153° E');
        expect(html).not.toContain('Historical Landmark');
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
