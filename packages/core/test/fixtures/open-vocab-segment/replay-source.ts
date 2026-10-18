/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Recorded vision answers for the open-vocabulary segmentation tests: a request is keyed by the decoded pixels of its
 * image and the text of every turn, so an answer recorded once from the live model replays for the same image and
 * prompt with no model call. `recordingSource` wraps a live source and records; `replaySource` answers from records and
 * fails loudly (naming the key) for a request that was never recorded.
 */

import * as crypto from 'crypto';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { decodeImageToRgbaSync } from '../../../src/node/image-codec-ffmpeg';
import type { LocatorModelSource } from '../../../src/node/video/segment-target-locator';
import type { VisionGenAIClient } from '../../../src/node/gemini/vision-model-chain';

export interface RecordedAnswer {
    key: string;
    case: string;
    model: string;
    modelVersion?: string;
    text: string;
    recordedAt: string;
}

export function requestKey(params: GenerateContentParameters): string {
    const h = crypto.createHash('sha256').update('segment-replay/v1');
    const contents = (Array.isArray(params.contents) ? params.contents : [params.contents]) as Array<{ role?: string; parts?: Array<Record<string, any>> }>;
    for (const c of contents) {
        h.update('\0r').update(c.role ?? '');
        for (const p of c.parts ?? []) {
            if (p.inlineData) {
                const img = decodeImageToRgbaSync(Buffer.from(p.inlineData.data, 'base64'));
                h.update('\0i').update(`${img.width}x${img.height}`).update(img.rgba);
            } else if (typeof p.text === 'string') {
                h.update('\0t').update(p.text);
            }
        }
    }
    return h.digest('hex');
}

function response(text: string, modelVersion?: string): GenerateContentResponse {
    return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], modelVersion } as unknown as GenerateContentResponse;
}

export function replaySource(records: RecordedAnswer[], seen: string[] = []): LocatorModelSource {
    const byKey = new Map(records.map(r => [r.key, r]));
    const models = Array.from(new Set(records.map(r => r.model)));
    const client: VisionGenAIClient = {
        models: {
            async generateContent(params) {
                const key = requestKey(params);
                const rec = byKey.get(key);
                if (!rec) throw new Error(`no recorded answer for request ${key} (model ${params.model}); record it with the live script`);
                if (rec.model !== params.model) throw new Error(`the recorded answer ${key} came from ${rec.model}, not ${params.model}`);
                seen.push(rec.case);
                return response(rec.text, rec.modelVersion);
            }
        }
    };
    return { getGenAIClient: async () => client, getModelCandidates: () => models.length ? models : ['no-recorded-model'] };
}

/** A fixed answer for every request (tests of the answer checks). */
export function scriptedSource(answers: string[], model = 'scripted-vision-model', calls: GenerateContentParameters[] = []): LocatorModelSource {
    let i = 0;
    const client: VisionGenAIClient = {
        models: {
            async generateContent(params) {
                calls.push(params);
                return response(answers[Math.min(i++, answers.length - 1)]);
            }
        }
    };
    return { getGenAIClient: async () => client, getModelCandidates: () => [model] };
}

export function recordingSource(live: LocatorModelSource, caseName: () => string, out: RecordedAnswer[]): LocatorModelSource {
    return {
        getModelCandidates: (m?: string) => live.getModelCandidates(m),
        getGenAIClient: async () => {
            const client = await live.getGenAIClient();
            if (!client) return undefined;
            return {
                vertexai: client.vertexai,
                models: {
                    async generateContent(params: GenerateContentParameters) {
                        const res = await client.models.generateContent(params);
                        const text = (res.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
                        out.push({ key: requestKey(params), case: caseName(), model: params.model, modelVersion: res.modelVersion, text, recordedAt: new Date().toISOString() });
                        return res;
                    }
                }
            };
        }
    };
}

/** Replays recorded answers and asks the live source (recording its answer) only for a request never recorded. */
export function replayOrRecordSource(live: LocatorModelSource, records: RecordedAnswer[], caseName: () => string, stats = { replayed: 0, recorded: 0, used: new Set<string>() }): LocatorModelSource {
    return {
        getModelCandidates: (m?: string) => live.getModelCandidates(m),
        getGenAIClient: async () => {
            const client = await live.getGenAIClient();
            if (!client) return undefined;
            return {
                vertexai: client.vertexai,
                models: {
                    async generateContent(params: GenerateContentParameters) {
                        const key = requestKey(params);
                        stats.used.add(key);
                        const rec = records.find(r => r.key === key && r.model === params.model);
                        if (rec) { stats.replayed++; return response(rec.text, rec.modelVersion); }
                        const res = await client.models.generateContent(params);
                        const text = (res.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
                        records.push({ key, case: caseName(), model: params.model, modelVersion: res.modelVersion, text, recordedAt: new Date().toISOString() });
                        stats.recorded++;
                        return res;
                    }
                }
            };
        }
    };
}
