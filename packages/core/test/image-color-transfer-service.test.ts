import { describe, it, expect } from 'vitest';
import {
    ImageColorTransferService,
    transferImageColor
} from '../src/node/image/ImageColorTransferService';

describe('ImageColorTransferService (2D Image-to-Image Color Transfer API)', () => {
    it('generates a valid two-stage prompt plan in plan-only mode', async () => {
        const result = await transferImageColor({
            referenceImage: 'sunset_rome.jpg',
            targetImage: 'colosseum_noon.jpg',
            mode: 'plan-only',
            contrastCurve: 'cinematic',
            preserveSkinTones: true
        });

        expect(result.success).toBe(true);
        expect(result.telemetry.mode).toBe('plan-only');
        expect(result.telemetry.preservedGeometry).toBe(true);
        expect(result.plan).toBeDefined();
        expect(result.plan.phase1ExtractionPrompt).toContain('extract its complete color palette');
        expect(result.plan.phase2ApplicationPrompt).toContain('100% identical composition');
        expect(result.palette.shadowProfile.hex).toBe('#0F172A');
        expect(result.palette.highlightProfile.hex).toBe('#FEF3C7');
    });

    it('extracts structured palette from reference image descriptor', async () => {
        const palette = await ImageColorTransferService.extractPalette('sunset_rome.jpg');
        expect(palette.primaryTones.length).toBeGreaterThan(0);
        expect(palette.primaryTones[0].hex).toBe('#1E293B');
        expect(palette.shadowProfile.temperature).toBe('cool');
        expect(palette.highlightProfile.temperature).toBe('warm');
    });

    it('validates plan prompt constraints for geometry locking', async () => {
        const result = await ImageColorTransferService.transferColor({
            referenceImage: 'ref.png',
            targetImage: 'target.png',
            mode: 'plan-only',
            contrastCurve: 'high-contrast'
        });

        expect(result.plan.phase2ApplicationPrompt).toContain('Keep all objects, characters, buildings');
        expect(result.plan.phase2ApplicationPrompt).toContain('high-contrast');
    });
});
