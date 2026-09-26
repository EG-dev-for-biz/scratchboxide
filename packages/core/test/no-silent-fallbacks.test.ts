/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultStationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';

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
    it('station image generation without Google credentials throws unless the procedural painter is requested', () => {
        withoutGoogleKeys(() => {
            expect(() => createDefaultStationImageGenerator()).toThrow(/GEMINI_API_KEY|allowProceduralGenerator/);
            const painter = createDefaultStationImageGenerator({ allowProceduralGenerator: true });
            expect(painter.name).toBe('architectural-photoreal-generator');
        });
    });

    it('the survey pipeline can be built without credentials, and only fails when a station actually needs a new image', () => {
        withoutGoogleKeys(() => {
            expect(() => new SurveySplatPipelineService()).not.toThrow();
        });
    });

    it('panorama depth fails loudly when the depth model cannot run, unless the heuristic room is requested', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-depth-'));
        const img = path.join(outDir, 'pano.png');
        fs.writeFileSync(img, Buffer.from('not a real image'));
        const service = new PanoramaDepthService('/nonexistent/panorama_depth.py');
        await expect(service.generatePanoramaDepth(img, { outDir })).rejects.toThrow(/depth/i);
        const heuristic = await service.generatePanoramaDepth(img, { outDir, allowHeuristicFallback: true });
        expect(heuristic.modelUsed).toBe('typescript-fallback-heuristic');
    });

    it('a cached station plate is reported as not re-checked rather than given typed-in QC scores', () => {
        const qc = SurveySplatPipelineService.cachedPlateQc();
        expect(qc.passed).toBe(false);
        expect(Number.isNaN(qc.overlapPercent)).toBe(true);
        expect(Number.isNaN(qc.residualPx)).toBe(true);
        expect(qc.reason).toMatch(/not re-run|not re-checked/i);
    });
});
