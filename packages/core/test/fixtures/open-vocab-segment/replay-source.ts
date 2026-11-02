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
 * fails loudly (naming the key and the nearest recorded request) for a request that was never recorded.
 *
 * Another platform does not make bit-identical requests: OpenCV draws the synthetic scenes through float paths that round
 * differently on x86 and ARM, and a video re-check's prompt carries the previous frame's mask box, which the segmenter's
 * float rounding can move by a pixel. So each recording also keeps its request's signature (each text, and each image's
 * size and thumbnail), and a request with no exact key replays the one recording it matches within that rounding:
 * thumbnails within THUMB_TOLERANCE levels in every cell, and texts equal but for numbers within NUMBER_TOLERANCE.
 */

import * as crypto from 'crypto';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { decodeImageToRgbaSync, type RgbaImage } from '../../../src/node/image-codec-ffmpeg';
import type { LocatorModelSource } from '../../../src/node/video/segment-target-locator';
import type { VisionGenAIClient } from '../../../src/node/gemini/vision-model-chain';

export interface RecordedAnswer {
    key: string;
    case: string;
    model: string;
    modelVersion?: string;
    text: string;
    recordedAt: string;
    /** What was asked, to know the same request made on another platform (requestSignature). */
    request?: RequestSignature;
}

/** Every part of every turn, in order: a text as itself, an image as its size and thumbnail. */
export interface RequestSignature {
    parts: Array<{ role: string; text: string } | { role: string; size: string; thumb: string }>;
}

/** A thumbnail cell's side in pixels: each cell is the mean of its pixels' colours, rounded (base64 RGB bytes). */
const THUMB_CELL = 32;
/** Levels a thumbnail cell may differ by on another platform (a few pixels a level apart move a cell's mean far less). */
const THUMB_TOLERANCE = 2;
/** A prompt's numbers may differ by this much (a hint box in thousandths of the image: 3 is under 2 px on these scenes). */
const NUMBER_TOLERANCE = 3;

type Contents = Array<{ role?: string; parts?: Array<Record<string, any>> }>;
const contentsOf = (params: GenerateContentParameters) => (Array.isArray(params.contents) ? params.contents : [params.contents]) as Contents;
const decodePart = (p: Record<string, any>): RgbaImage => decodeImageToRgbaSync(Buffer.from(p.inlineData.data, 'base64'));

export function requestKey(params: GenerateContentParameters): string {
    const h = crypto.createHash('sha256').update('segment-replay/v1');
    for (const c of contentsOf(params)) {
        h.update('\0r').update(c.role ?? '');
        for (const p of c.parts ?? []) {
            if (p.inlineData) {
                const img = decodePart(p);
                h.update('\0i').update(`${img.width}x${img.height}`).update(img.rgba);
            } else if (typeof p.text === 'string') {
                h.update('\0t').update(p.text);
            }
        }
    }
    return h.digest('hex');
}

function thumbnail(img: RgbaImage): string {
    const cw = Math.ceil(img.width / THUMB_CELL), ch = Math.ceil(img.height / THUMB_CELL);
    const sum = new Float64Array(cw * ch * 3), count = new Uint32Array(cw * ch);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const cell = Math.floor(y / THUMB_CELL) * cw + Math.floor(x / THUMB_CELL), i = (y * img.width + x) * 4;
        for (let c = 0; c < 3; c++) sum[cell * 3 + c] += img.rgba[i + c];
        count[cell]++;
    }
    return Buffer.from(Array.from(sum, (s, k) => Math.round(s / count[Math.floor(k / 3)]))).toString('base64');
}

export function requestSignature(params: GenerateContentParameters): RequestSignature {
    const parts: RequestSignature['parts'] = [];
    for (const c of contentsOf(params)) {
        for (const p of c.parts ?? []) {
            if (p.inlineData) {
                const img = decodePart(p);
                parts.push({ role: c.role ?? '', size: `${img.width}x${img.height}`, thumb: thumbnail(img) });
            } else if (typeof p.text === 'string') {
                parts.push({ role: c.role ?? '', text: p.text });
            }
        }
    }
    return { parts };
}

/** Why `a` is not the recorded request `b` in its texts, or (`images`) in its images; undefined when they match within another platform's rounding. */
function signatureMismatch(a: RequestSignature, b: RequestSignature, what: 'texts' | 'images'): string | undefined {
    if (a.parts.length !== b.parts.length) return `${a.parts.length} parts, not ${b.parts.length}`;
    for (let i = 0; i < a.parts.length; i++) {
        const p = a.parts[i], q = b.parts[i];
        if (p.role !== q.role || ('text' in p) !== ('text' in q)) return `part ${i} is another kind of part`;
        if ('text' in p && 'text' in q) {
            if (what !== 'texts') continue;
            // numbers at the odd places of the split, the words between them at the even places
            const x = p.text.split(/(-?\d+(?:\.\d+)?)/), y = q.text.split(/(-?\d+(?:\.\d+)?)/);
            if (x.length !== y.length || x.some((t, k) => k % 2 === 0 && t !== y[k])) return `part ${i} is another text`;
            const k = x.findIndex((t, j) => j % 2 === 1 && Math.abs(Number(t) - Number(y[j])) > NUMBER_TOLERANCE);
            if (k >= 0) return `part ${i} has ${x[k]} where it had ${y[k]}`;
        } else if (!('text' in p) && !('text' in q) && what === 'images') {
            if (p.size !== q.size) return `part ${i} is a ${p.size} image, not ${q.size}`;
            const u = Buffer.from(p.thumb, 'base64'), v = Buffer.from(q.thumb, 'base64');
            let worst = 0;
            for (let j = 0; j < u.length; j++) worst = Math.max(worst, Math.abs(u[j] - v[j]));
            if (worst > THUMB_TOLERANCE) return `part ${i}'s thumbnail differs by up to ${worst} levels`;
        }
    }
    return undefined;
}

/** The recorded answer for a request: by its exact key, else the one recording it matches within another platform's rounding. */
function findRecorded(records: RecordedAnswer[], params: GenerateContentParameters): { rec?: RecordedAnswer; key: string; why?: string } {
    const key = requestKey(params);
    const exact = records.find(r => r.key === key && r.model === params.model);
    if (exact) return { rec: exact, key };
    const sig = requestSignature(params);
    const signed = records.filter(r => r.model === params.model && r.request).map(r => ({
        r, texts: signatureMismatch(sig, r.request!, 'texts'), images: signatureMismatch(sig, r.request!, 'images')
    }));
    const near = signed.filter(x => !x.texts && !x.images);
    if (near.length === 1) return { rec: near[0].r, key };
    if (near.length > 1) return { key, why: `it matches ${near.length} recordings (${near.map(x => x.r.case).join(', ')})` };
    const samePrompt = signed.find(x => !x.texts), sameImage = signed.find(x => !x.images);
    return {
        key, why: samePrompt ? `the recording of ${samePrompt.r.case} with its prompt differs: ${samePrompt.images}`
            : sameImage ? `the recording of ${sameImage.r.case} with its image differs: ${sameImage.texts}`
                : 'no recording has its prompt or its image'
    };
}

function response(text: string, modelVersion?: string): GenerateContentResponse {
    return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], modelVersion } as unknown as GenerateContentResponse;
}

export function replaySource(records: RecordedAnswer[], seen: string[] = []): LocatorModelSource {
    const models = Array.from(new Set(records.map(r => r.model)));
    const client: VisionGenAIClient = {
        models: {
            async generateContent(params) {
                const { rec, key, why } = findRecorded(records, params);
                if (!rec) {
                    const other = records.find(r => r.key === key);
                    if (other) throw new Error(`the recorded answer ${key} came from ${other.model}, not ${params.model}`);
                    throw new Error(`no recorded answer for request ${key} (model ${params.model}): ${why}; record it with the live script`);
                }
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
                        out.push({ key: requestKey(params), case: caseName(), model: params.model, modelVersion: res.modelVersion, text, recordedAt: new Date().toISOString(), request: requestSignature(params) });
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
                        const { rec, key } = findRecorded(records, params);
                        if (rec) { stats.used.add(rec.key); stats.replayed++; return response(rec.text, rec.modelVersion); }
                        stats.used.add(key);
                        const res = await client.models.generateContent(params);
                        const text = (res.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
                        records.push({ key, case: caseName(), model: params.model, modelVersion: res.modelVersion, text, recordedAt: new Date().toISOString(), request: requestSignature(params) });
                        stats.recorded++;
                        return res;
                    }
                }
            };
        }
    };
}
