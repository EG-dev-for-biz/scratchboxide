/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fakes for the photo-ornament tests: synthetic decodable JPEGs with known colours (no Street View pixel is ever in the
 * repo), a grounding stand-in, and a vision client that REPLAYS recorded-shaped replies. The replies are shaped like
 * the real ones: the cornice measurement is transcribed from the gemini-4-argon LOW-thinking probe (dentil count 18,
 * pitch 0.36 m, width 0.22 m, depth 0.25 m, gap ratio 0.64; a five-band cornice profile; frieze roundel and
 * medallion sizes). Only numbers and words, no image bytes.
 */
import * as jpegJs from 'jpeg-js';
import type { VisionGenAIClient } from '../../src/node/gemini/vision-model-chain';

export const STONE: [number, number, number] = [201, 182, 152];
export const GREY: [number, number, number] = [118, 120, 126];
export const SKY: [number, number, number] = [150, 176, 214];

/** A decodable JPEG of horizontal bands (top to bottom) of the given colours with a small deterministic texture. */
export function bandJpeg(bands: Array<[number, number, number]>, width = 320, height = 240): Buffer {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const c = bands[Math.min(bands.length - 1, Math.floor((y / height) * bands.length))];
        for (let x = 0; x < width; x++) {
            const j = ((x * 5 + y * 3) % 5) - 2;
            const i = (y * width + x) * 4;
            data[i] = c[0] + j; data[i + 1] = c[1] + j; data[i + 2] = c[2] + j; data[i + 3] = 255;
        }
    }
    return Buffer.from(jpegJs.encode({ width, height, data }, 92).data);
}

/** The survey reply of one call over four faces, in the shape the model writes (kinds are the model's own words). */
export function surveyReply(faceCount = 4): { faces: any[] } {
    const faces = [
        {
            image: 0,
            elements: [
                { kind: 'dentil cornice', box: [210, 40, 262, 960], sizeRatio: [0.014, 0.03], repeat: { count: 18, pitchRatio: 0.05, axis: 'h' }, material: 'cut stone with a smooth finish', weathering: 'light soiling in the recesses', confidence: 82 },
                { kind: 'frieze roundel wreaths', box: [290, 90, 370, 910], sizeRatio: [0.07, 0.08], repeat: { count: 6, pitchRatio: 0.15, axis: 'h' }, material: 'carved stone relief', weathering: 'streaked', confidence: 64 },
                { kind: 'spandrel medallion', box: [420, 130, 520, 330], sizeRatio: [0.2, 0.1], material: 'carved stone relief', weathering: 'weathered edges', confidence: 58 }
            ],
            materials: [{ description: 'pale marble ashlar, laid in courses', where: 'the whole face', weathering: 'grey soiling under the cornice' }]
        },
        { image: 1, elements: [{ kind: 'stone course lines', box: [300, 100, 900, 900], material: 'ashlar', weathering: 'even', confidence: 70 }], materials: [{ description: 'pale marble ashlar' }] },
        { image: 2, elements: [], materials: [] },
        { image: 3, elements: [{ kind: 'recessed arched opening', box: [350, 380, 960, 620], material: 'dressed stone', weathering: 'sooty', confidence: 77 }], materials: [{ description: 'dressed stone', where: 'the opening' }] }
    ];
    return { faces: faces.slice(0, faceCount) };
}

/** A pass-2 reading of the north cornice crease (S02) and the spandrel (S01), compact slot-relative form. */
export function corniceReply(): object {
    return {
        elements: [
            // dentils: 18 at 0.36 m pitch along the edge, 0.22 m wide, 0.25 m deep
            { slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [20, 360, 18] } }, conf: 78, depthBasis: 'shadow in the gaps', ev: [[0, 120, 60, 260, 940]], label: 'dentils' },
            // a five-band cornice profile swept along the whole crease
            { slot: 'S02', op: { sweep: { t: [0, 1000], profile: [0, 0, 60, 0, 60, 40, 140, 40, 140, 110, 220, 110, 220, 180, 0, 180] } }, conf: 66, depthBasis: 'silhouette against the sky', ev: [[0, 100, 40, 280, 960]], label: 'cornice' },
            { slot: 'S01', op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180] } }, conf: 62, depthBasis: 'rim highlight', ev: [[0, 300, 120, 470, 260]], label: 'medallion' }
        ],
        corrections: [],
        emptySlots: [{ slot: 'S03', why: 'no image shows it' }]
    };
}

export interface RoutedCall { kind: 'survey' | 'ornament' | 'other'; params: any }

/** A vision client that answers by the kind of request: the survey prompt gets `survey`, anything else `ornament`. */
export function routedVisionClient(replies: { survey?: object | Error; ornament?: object | Error }, record: RoutedCall[] = []): VisionGenAIClient {
    return {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                const text0 = JSON.stringify(params.contents?.[0]?.parts?.filter((p: any) => p.text).map((p: any) => p.text) ?? []);
                const kind: RoutedCall['kind'] = /surveying one real structure/.test(text0) ? 'survey' : /reading architectural ornament/.test(text0) ? 'ornament' : 'other';
                record.push({ kind, params });
                const reply = kind === 'survey' ? replies.survey : replies.ornament;
                if (reply instanceof Error) throw reply;
                if (!reply) throw new Error(`no ${kind} reply configured`);
                const text = JSON.stringify(reply);
                return (async function* () { yield { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 800, thoughtsTokenCount: 120 } } as any; })();
            }
        }
    };
}
