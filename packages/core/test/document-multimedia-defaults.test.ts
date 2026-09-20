import { describe, it, expect } from 'vitest';
import { synthesizeComprehensiveDocument } from '../src/browser/generative-canvas/document-synthesis-engine';
import { synthesizeDefaultDocument } from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';

describe('Document Multimedia Defaults and On-Demand Toolbar Creation', () => {
    it('defaults chat synthesis to clean editorial text with zero unsolicited media blocks', () => {
        const result = synthesizeDefaultDocument('create a document about black holes and spacetime geometry');
        expect(result.artifact).toBeDefined();
        const doc = result.artifact?.data;
        expect(doc).toBeDefined();

        const hasLocation = doc.sections.some((s: any) => s.type === 'location-image');
        const hasVideo = doc.sections.some((s: any) => s.type === 'video');
        const hasSvg = doc.sections.some((s: any) => s.type === 'svg-diagram');

        expect(hasLocation).toBe(false);
        expect(hasVideo).toBe(false);
        expect(hasSvg).toBe(false);

        // Substantive text content is still fully populated
        expect(doc.sections.some((s: any) => s.type === 'heading')).toBe(true);
        expect(doc.sections.some((s: any) => s.type === 'paragraph')).toBe(true);
        expect(doc.sections.some((s: any) => s.type === 'table')).toBe(true);
        expect(doc.sections.some((s: any) => s.type === 'callout')).toBe(true);
    });

    it('generates multimedia blocks when the prompt explicitly requests them', () => {
        const result = synthesizeDefaultDocument('create a document about solar eclipses with media and illustrations');
        expect(result.artifact).toBeDefined();
        const doc = result.artifact?.data;
        expect(doc).toBeDefined();

        const hasLocation = doc.sections.some((s: any) => s.type === 'location-image');
        const hasVideo = doc.sections.some((s: any) => s.type === 'video');
        const hasSvg = doc.sections.some((s: any) => s.type === 'svg-diagram');

        expect(hasLocation || hasVideo || hasSvg).toBe(true);
    });

    it('honors includeMedia option directly in synthesizeComprehensiveDocument', () => {
        const textOnlyDoc = synthesizeComprehensiveDocument('quantum mechanics', undefined, undefined, { includeMedia: false });
        expect(textOnlyDoc.sections.some(s => s.type === 'location-image')).toBe(false);
        expect(textOnlyDoc.sections.some(s => s.type === 'video')).toBe(false);
        expect(textOnlyDoc.sections.some(s => s.type === 'svg-diagram')).toBe(false);

        const mediaDoc = synthesizeComprehensiveDocument('quantum mechanics', undefined, undefined, { includeMedia: true });
        expect(mediaDoc.sections.some(s => s.type === 'location-image')).toBe(true);
        expect(mediaDoc.sections.some(s => s.type === 'video')).toBe(true);
        expect(mediaDoc.sections.some(s => s.type === 'svg-diagram')).toBe(true);
    });
});
