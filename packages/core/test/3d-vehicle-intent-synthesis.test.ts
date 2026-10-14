import { describe, it, expect } from 'vitest';
import { detect3DSceneTheme } from '../src/browser/generative-canvas/procedural-3d-synthesizer';

describe('3D Intent Classification & Vehicle Synthesis', () => {
    it('detects vehicle theme from automotive prompts', () => {
        expect(detect3DSceneTheme('build me a 3d car')).toBe('vehicle');
        expect(detect3DSceneTheme('render sports car')).toBe('vehicle');
        expect(detect3DSceneTheme('procedural hypercar model')).toBe('vehicle');
    });
});
