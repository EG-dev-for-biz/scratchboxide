import { describe, it, expect } from 'vitest';
import { SegmentTargetLocator, segmentLocatorPrompt, type LocatorModelSource } from '../src/node/video/segment-target-locator';
import type { VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';

function foundResponse(label: string): GenerateContentResponse {
    return { text: JSON.stringify({ found: true, label, box_2d: [100, 100, 900, 900], positive: [[500, 500]], negative: [] }) } as unknown as GenerateContentResponse;
}

function sourceWithClient(client: VisionGenAIClient): LocatorModelSource {
    return { getGenAIClient: async () => client, getModelCandidates: () => ['gemini-2.5-flash'] };
}

describe('segmentLocatorPrompt: the hint-image sentence', () => {
    it('is absent without a hint image', () => {
        expect(segmentLocatorPrompt('the glass window panes')).not.toContain('second image');
    });
    it('is present, and tells the model to still mark only the first image, when one is given', () => {
        const prompt = segmentLocatorPrompt('the glass window panes', undefined, undefined, true);
        expect(prompt).toContain('second image');
        expect(prompt).toMatch(/mark what the FIRST image actually shows/);
    });
});

describe('SegmentTargetLocator.locate: a hint image is sent as a second part, never in place of the frame', () => {
    it('sends only the frame image and the prompt when no hint image is given', async () => {
        const calls: GenerateContentParameters[] = [];
        const client: VisionGenAIClient = { models: { generateContent: async params => { calls.push(params); return foundResponse('a window'); } } };
        const locator = new SegmentTargetLocator(sourceWithClient(client));
        await locator.locate({ imageBytes: Buffer.from('frame-bytes'), mimeType: 'image/png', target: 'the glass window panes' });

        expect(calls.length).toBeGreaterThan(0);
        const parts = calls[0].contents![0].parts!;
        expect(parts).toHaveLength(2);
        expect((parts[0] as { inlineData?: { data: string } }).inlineData?.data).toBe(Buffer.from('frame-bytes').toString('base64'));
        expect((parts[1] as { text: string }).text).not.toContain('second image');
    });

    it('sends the frame, the prompt, then the hint image, and the prompt names it — the frame is still what gets marked', async () => {
        const calls: GenerateContentParameters[] = [];
        const client: VisionGenAIClient = { models: { generateContent: async params => { calls.push(params); return foundResponse('a window'); } } };
        const locator = new SegmentTargetLocator(sourceWithClient(client));
        const hintImage = { bytes: Buffer.from('hint-bytes'), mimeType: 'image/jpeg' };
        await locator.locate({ imageBytes: Buffer.from('frame-bytes'), mimeType: 'image/png', target: 'the glass window panes', hintImage });

        expect(calls.length).toBeGreaterThan(0);
        const parts = calls[0].contents![0].parts!;
        expect(parts).toHaveLength(3);
        expect((parts[0] as { inlineData?: { mimeType: string; data: string } }).inlineData?.mimeType).toBe('image/png');
        expect((parts[0] as { inlineData?: { data: string } }).inlineData?.data).toBe(Buffer.from('frame-bytes').toString('base64'));
        expect((parts[1] as { text: string }).text).toContain('second image');
        expect((parts[2] as { inlineData?: { mimeType: string; data: string } }).inlineData?.mimeType).toBe('image/jpeg');
        expect((parts[2] as { inlineData?: { data: string } }).inlineData?.data).toBe(Buffer.from('hint-bytes').toString('base64'));
    }, 20_000);
});
