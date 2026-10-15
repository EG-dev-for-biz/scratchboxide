/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultStationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { GeneratorFailedError } from '../src/common/errors/pipeline-errors';

function withoutGoogleKeys<T>(run: () => T): T {
    const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
        return run();
    } finally {
        if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
        if (saved.k !== undefined) process.env.GOOGLE_API_KEY = saved.k;
    }
}

describe('Pipelines refuse to substitute invented output', () => {
    it('station image generation has no procedural painter to fall back to: the default generator is the image model', () => {
        withoutGoogleKeys(() => {
            // Built with a media service that must not be reached here; asking for the old painter changes nothing.
            const mediaService = { generateImage: async () => { throw new Error('not called'); } };
            expect(createDefaultStationImageGenerator({ mediaService }).name).toBe('google-nano-banana');
            expect(createDefaultStationImageGenerator({ mediaService, allowProceduralGenerator: true } as any).name).toBe('google-nano-banana');
        });
    });

    it('the survey pipeline can be built without credentials, and only fails when a station actually needs a new image', () => {
        withoutGoogleKeys(() => {
            expect(() => new SurveySplatPipelineService()).not.toThrow();
        });
    });

    it('panorama depth fails with the generator error when the depth model cannot run; there is no synthetic room', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-depth-'));
        const img = path.join(outDir, 'pano.png');
        fs.writeFileSync(img, Buffer.from('not a real image'));
        const service = new PanoramaDepthService('/nonexistent/panorama_depth.py');
        await expect(service.generatePanoramaDepth(img, { outDir })).rejects.toBeInstanceOf(GeneratorFailedError);
        await expect(service.generatePanoramaDepth(img, { outDir, allowHeuristicFallback: true } as any)).rejects.toThrow(/Depth model failed/);
        expect(fs.readdirSync(outDir).filter(f => f.endsWith('.depth.f32'))).toEqual([]);
    });
});
