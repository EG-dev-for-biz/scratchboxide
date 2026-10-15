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
import { MarkdownDocumentPrimitive, SectionHeading, SectionMediaNotice, formatCoordinates, newEmptySection, newLocationSection, sectionGenerationPrompt, sectionMediaFailure, sectionMediaFromJob, documentMediaCredit } from '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
import { synthesizeContextualNanoBananaPrompt } from '../src/browser/generative-canvas/nano-banana-service';
import * as nanoBanana from '../src/browser/generative-canvas/nano-banana-service';
import { generateMotivatedEditorialImageSection, generateMotivatedVideoSection } from '../src/browser/generative-canvas/document-synthesis-engine';
import type { MarkdownDocumentData, MarkdownSection } from '../src/browser/generative-canvas/canvas-types';
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
            attribution: 'Generated with gemini-3-pro-image.', mediaError: undefined
        });
        expect(sectionMediaFromJob(job('gemini-3.1-flash-image-preview'), '/media/job-1', false).attribution)
            .toBe('Generated with gemini-3.1-flash-image-preview.');
    });

    it('names the requested model too when the model that answered is another id, without claiming why', () => {
        const asked = (modelUsed: string, modelPriority: string[]): MediaGenerationJob => ({ ...job(modelUsed), request: { ...job(modelUsed).request, modelPriority } });
        // A video section asks Omni first; Veo answered. The credit no longer reads as if Veo was asked for.
        expect(documentMediaCredit(asked('veo-3.1-generate-preview', ['google/omni-1.1', 'gemini-omni-flash-video', 'veo-3.1-generate-preview'])))
            .toBe('Generated with veo-3.1-generate-preview (requested google/omni-1.1).');
        expect(documentMediaCredit(asked('gemini-3-pro-image', ['gemini-3-pro-image', 'gemini-3.1-flash-image']))).toBe('Generated with gemini-3-pro-image.');
        expect(documentMediaCredit({ request: { kind: 'image', prompt: 'p' } as any })).toBeUndefined();
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

describe('a section\'s image is generated from its own prompt', () => {
    // Regenerate on a section without a prompt used to compose one from the document's keywords
    // (synthesizeContextualNanoBananaPrompt): a "Lexington, Kentucky Bourbon Trail" document got Captain John Parker's
    // minutemen, a "Retail security staffing plan" got a Zero-Trust Ed25519 schematic, credited "Generated with <model>".
    const sec = (fields: Partial<MarkdownSection>): MarkdownSection => ({ id: 's', type: 'editorial-image', ...fields } as MarkdownSection);

    it('a section with no prompt cannot be generated: it says so, and nothing is composed from the document', () => {
        for (const section of [newEmptySection('a', 'editorial-image'), newEmptySection('b', 'image'), sec({ imageTitle: 'Distillery tour', caption: 'Lexington, Kentucky' })]) {
            const out = sectionGenerationPrompt(section);
            expect(out, section.id).toEqual({ error: 'This section has no image prompt. Describe the image you want in the prompt to generate it.' });
        }
        expect(sectionGenerationPrompt(newEmptySection('v', 'video'))).toEqual({ error: 'This section has no video prompt. Describe the video you want in the prompt to generate it.' });
        expect((sectionGenerationPrompt(newLocationSection('l')) as { error: string }).error).toContain('needs a 3D tiles render');
        // Picking a style does not invent a subject either.
        expect('error' in sectionGenerationPrompt(sec({ imageTitle: 'Night shift guards' }), 'oil-painting')).toBe(true);
    });

    it('runs exactly the prompt the section has', () => {
        expect(sectionGenerationPrompt(sec({ prompt: 'A copper pot still in a Kentucky rickhouse' }))).toEqual({
            prompt: 'A copper pot still in a Kentucky rickhouse', patch: { visualPrompt: 'A copper pot still in a Kentucky rickhouse' }
        });
        // The model's visualPrompt is the section's prompt when the user wrote none.
        const modelPrompt = sectionGenerationPrompt(sec({ visualPrompt: 'Barrels stacked nine high' })) as { prompt: string };
        expect(modelPrompt.prompt).toBe('Barrels stacked nine high');
        expect(modelPrompt.prompt).not.toMatch(/Parker|minutemen|Zero-Trust|Ed25519/);
    });

    it('a picked style restyles the section\'s own words, and another pick replaces it instead of stacking', () => {
        const first = sectionGenerationPrompt(sec({ prompt: 'A copper pot still' }), 'oil-painting') as { prompt: string; patch: Partial<MarkdownSection> };
        expect(first.prompt.startsWith('A copper pot still. Medium: ')).toBe(true);
        expect(first.prompt).toContain('oil painting');
        expect(first.patch).toMatchObject({ prompt: 'A copper pot still', stylePreset: 'Classical Oil Painting', visualPrompt: first.prompt });
        const second = sectionGenerationPrompt(sec({ ...first.patch }), 'cinematic-film') as { prompt: string; patch: Partial<MarkdownSection> };
        expect(second.prompt.startsWith('A copper pot still. Medium: ')).toBe(true);
        expect(second.prompt).not.toContain('oil painting');
        expect(second.patch.stylePreset).toBe('Cinematic Editorial Film');
        // Regenerate without a pick runs the styled prompt last used again.
        expect((sectionGenerationPrompt(sec({ ...second.patch })) as { prompt: string }).prompt).toBe(second.prompt);
        expect(sectionGenerationPrompt(sec({ prompt: 'x' }), 'no-such-style')).toEqual({ error: 'Unknown style "no-such-style".' });
    });
});

describe('the document view shows only what the document holds', () => {
    const render = (data: MarkdownDocumentData, readOnly = false) => renderToStaticMarkup(React.createElement(MarkdownDocumentPrimitive, { data, readOnly }));
    const CANNED = /Executive Overview|Key Technical Pillars|Implementation Details/;

    it('an empty heading shows no made-up heading: a hint where it can be edited, nothing when read-only', () => {
        for (const level of [1, 2, 3] as const) {
            const doc: MarkdownDocumentData = { title: 'Plan', sections: [{ id: 'h', type: 'heading', level, content: '' }] };
            const editable = render(doc);
            expect(editable, `level ${level}`).not.toMatch(CANNED);
            expect(editable).toContain('data-testid="sb-doc-empty-heading"');
            const readOnly = render(doc, true);
            expect(readOnly).not.toMatch(CANNED);
            expect(readOnly).not.toContain('sb-doc-empty-heading');
            expect(readOnly.match(/<h[1-6][\s>]/g)).toHaveLength(1); // only the document title
        }
        expect(render({ title: 'Plan', sections: [newEmptySection('n', 'heading')] })).not.toMatch(CANNED);
    });

    it('a heading is shown as written, even when it reads like a placeholder', () => {
        for (const content of ['Heading text...', 'New section heading', 'Background']) {
            const html = renderToStaticMarkup(React.createElement(SectionHeading, { level: 2, content, readOnly: true }));
            expect(html).toBe(`<h3 class="sb-doc-h2">${content}</h3>`);
        }
    });

    it('an AI callout credits no model it has no record of', () => {
        const html = render({ title: 'Notes', sections: [{ id: 'c', type: 'callout', calloutType: 'ai', content: 'Selected excerpt.', aiProvenance: { isCollapsed: false } } as any] });
        expect(html).not.toContain('Gemini 2.5 Pro');
        expect(html).toContain('No model recorded');
        const credited = render({ title: 'Notes', sections: [{ id: 'c', type: 'callout', calloutType: 'ai', content: 'x', aiProvenance: { model: 'gemini-3.8-flash' } } as any] });
        expect(credited).toContain('gemini-3.8-flash');
    });
});
