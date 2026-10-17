/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The figure reading, one call per figure: a reply for one figure that comes back truncated (the stream ends without STOP,
 * mid-JSON) costs that figure another call, the other figures stand, and a figure that never comes back readable is a
 * problem of its own crop, not of the reading.
 */

import { describe, expect, it } from 'vitest';
import { readFigures, FIGURE_READ_ATTEMPTS, type FigureImage } from '../src/node/3d-engine/staged-location/figures';
import { VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import { bandJpeg, figuresReply, GREY, SKY, STONE } from './helpers/photo-ornament-fixtures';

const blob = (regionId: string) => ({ regionId, triangles: 400, min: [0, 0, 0], max: [1, 2, 1], centre: [0.5, 1, 0.5], axisDeg: 0, alongM: 0.6, acrossM: 0.4, heightM: 2, pedestal: { surfaceId: 's01', topY: 0, contactM: 0.5 } });
const image = (index: number, bytes: Buffer): FigureImage => ({
    index, blob: blob(`r${index}`) as unknown as FigureImage['blob'], bytes, mimeType: 'image/jpeg', widthPx: 320, heightPx: 240,
    view: { panoId: `P${index}`, eye: [0, 2, 20], headingDeg: 0, pitchDeg: 10, fovDeg: 40, aspectRatio: 'RATIO_3X4', distanceM: 20, regionId: `r${index}` } as unknown as FigureImage['view']
});

/** A client whose replies for the image with `truncated` bytes are cut mid-JSON (no finish reason) the first `cuts` times. */
function client(truncated: Buffer, cuts: number): { client: VisionGenAIClient; calls: number[] } {
    const calls: number[] = [];
    let seen = 0;
    return {
        calls,
        client: {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async (params: any) => {
                    const images = (params.contents[0].parts as any[]).filter(p => p.inlineData).map(p => p.inlineData.data as string);
                    calls.push(images.length);
                    const full = JSON.stringify(figuresReply(images.map((_, k) => k)));
                    const cut = images.includes(truncated.toString('base64')) && seen++ < cuts;
                    return (async function* () {
                        yield { candidates: [{ content: { parts: [{ text: cut ? full.slice(0, Math.floor(full.length / 2)) : full }] }, ...(cut ? {} : { finishReason: 'STOP' }) }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 } } as any;
                    })();
                }
            }
        } as unknown as VisionGenAIClient
    };
}

describe('figure reading, one call per figure', () => {
    it('a truncated reply costs its figure another call; every figure is read', async () => {
        const a = bandJpeg([SKY, STONE, GREY]), b = bandJpeg([STONE, SKY, GREY]);
        const fake = client(a, 2);
        const chain = new VisionModelChain<string>({ client: fake.client, candidates: ['gemini-4-argon'], sleep: async () => undefined });
        const r = await readFigures({ images: [image(0, a), image(1, b)], chain });
        expect([...r.parsed.readings.keys()].sort()).toEqual([0, 1]);
        expect(r.parsed.problems.size).toBe(0);
        // one image per call: figure 0 asked three times (two cut), figure 1 once
        expect(fake.calls.every(n => n === 1)).toBe(true);
        expect(r.calls).toBe(4);
    });

    it('a figure whose every attempt is cut is a problem of its crop; the other figure stands', async () => {
        const a = bandJpeg([SKY, STONE, GREY]), b = bandJpeg([STONE, SKY, GREY]);
        const fake = client(a, 99);
        const chain = new VisionModelChain<string>({ client: fake.client, candidates: ['gemini-4-argon'], sleep: async () => undefined });
        const r = await readFigures({ images: [image(0, a), image(1, b)], chain });
        expect([...r.parsed.readings.keys()]).toEqual([1]);
        expect(r.parsed.problems.get(0)![0]).toMatch(/its reading failed \(the reply is not valid JSON/);
        expect(r.calls).toBe(FIGURE_READ_ATTEMPTS + 1);
    });
});
