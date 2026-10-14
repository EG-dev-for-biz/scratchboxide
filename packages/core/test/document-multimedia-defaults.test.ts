import { describe, it, expect } from 'vitest';
import { synthesizeComprehensiveDocument } from '../src/browser/generative-canvas/document-synthesis-engine';

describe('Document Multimedia Defaults and On-Demand Toolbar Creation', () => {
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
