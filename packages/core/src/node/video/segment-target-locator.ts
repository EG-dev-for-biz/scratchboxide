/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Turns a free-text description of something in an image ("the statue on the left pier", "the red car") into prompts
 * for the interactive segmenter: a box around it, points on it, and points on the things touching it that are not it.
 *
 * One vision call (the chat's model on the visible fallback chain, LOW thinking) answers strict JSON in Gemini's own
 * 0..1000 [y, x] convention; the answer is checked (ranges, an ordered box, positive points inside the box) and a
 * failing answer is asked once more with the problems listed. A "not found" answer is a SegmentTargetNotFoundError, and
 * an answer that still fails its checks is a GeneratorFailedError: no box or point is ever made up in its place.
 * The description is passed through as written; nothing here sorts targets into kinds.
 */

import type { Content, GenerateContentResponse } from '@google/genai';
import { GeneratorFailedError, SegmentTargetNotFoundError } from '../../common/errors/pipeline-errors';
import { VISION_CALL_POLICY, VisionModelChain, type VisionGenAIClient, type VisionAttempt } from '../gemini/vision-model-chain';
import { describeThinking } from '../gemini/thinking-config';

export const SEGMENT_LOCATOR_PROMPT_VERSION = 'segment-locator/v1';
/** LOW thinking on Gemini 4 (thinkingConfigFor), a 512-token budget on 3.x. */
export const SEGMENT_LOCATOR_THINKING_BUDGET = 512;
const MAX_POINTS = 8;
/** A positive point may sit this far (in 0..1000 units) outside the box before it counts as a problem. */
const BOX_TOLERANCE = 15;

/** [x, y] normalised to 0..1 of the image width / height. */
export type NormPoint = [number, number];
/** [x0, y0, x1, y1] normalised to 0..1. */
export type NormBox = [number, number, number, number];

export interface SegmentPrompts {
    positive: NormPoint[];
    negative: NormPoint[];
    box?: NormBox;
}

export interface LocatedTarget extends SegmentPrompts {
    box: NormBox;
    /** The model's short description of what it found. */
    label: string;
    model: string;
    thinking?: { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number };
    ms: number;
    /** Calls made (2 when the first answer was asked again). */
    calls: number;
    skippedModels: Array<{ model: string; reason: string }>;
    attempts: VisionAttempt[];
}

export interface LocateRequest {
    imageBytes: Buffer;
    mimeType: string;
    target: string;
    /** A region the target is known to be in (the user's box, or the previous frame's mask box on a video re-check). */
    hintBox?: NormBox;
    hintKind?: 'user-box' | 'previous-frame';
    /** A second image — a user photo or a generated reference — shown alongside the first as what the target should look like. Never the only evidence: the model is still told to mark only what the first image actually shows. */
    hintImage?: { bytes: Buffer; mimeType: string };
    signal?: AbortSignal;
}

const TOOL = 'vfx_segment_subject';

function f3(v: number): string {
    return (Math.round(v * 1000)).toString();
}

export function segmentLocatorPrompt(target: string, hintBox?: NormBox, hintKind?: LocateRequest['hintKind'], hasHintImage?: boolean): string {
    const hint = hintBox
        ? `\n${hintKind === 'previous-frame'
            ? 'In the previous video frame the target was inside'
            : 'The user says the target is inside'} box_2d [${f3(hintBox[1])}, ${f3(hintBox[0])}, ${f3(hintBox[3])}, ${f3(hintBox[2])}]; use it as a hint, but answer with what this image shows.`
        : '';
    const hintImageNote = hasHintImage
        ? '\nA second image follows the first: a reference for what the target should look like. Use it only to judge appearance (material, colour, style); mark what the FIRST image actually shows, not the reference itself, and only if the first image really does show the target.'
        : '';
    return [
        'Find the thing described below in the image and give prompts for an interactive segmenter that will cut it out.',
        `Target: ${JSON.stringify(target)}${hint}${hintImageNote}`,
        '',
        'Answer with JSON only, in this shape:',
        '{"found": true, "label": "<a few words for what you found>", "box_2d": [ymin, xmin, ymax, xmax], "positive": [[y, x], ...], "negative": [[y, x], ...]}',
        'or, when nothing in the image matches the description: {"found": false, "reason": "<why>"}',
        '',
        'Coordinates are integers from 0 to 1000, normalised to the image height (y) and width (x).',
        '- box_2d tightly encloses all of the target that is visible.',
        `- positive: 3 to 6 points well inside the target, on its own surface (not in gaps or holes, not on anything in front of it), spread over its different parts. At most ${MAX_POINTS}.`,
        `- negative: 0 to 6 points on things that touch, overlap or stand in front of the target but are not part of it (neighbouring things, occluders, what it stands on or against), each near the target's edge. At most ${MAX_POINTS}.`,
        '- If the description fits several things, choose the one it describes best.'
    ].join('\n');
}

/** The answer's text without thought parts. */
export function responseText(response: GenerateContentResponse): string {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter(p => typeof p.text === 'string' && !(p as { thought?: boolean }).thought).map(p => p.text).join('');
    return text || (typeof (response as { text?: unknown }).text === 'string' ? (response as { text: string }).text : '');
}

export type LocatorCheck =
    | { kind: 'found'; prompts: SegmentPrompts & { box: NormBox }; label: string }
    | { kind: 'not-found'; reason: string }
    | { kind: 'invalid'; problems: string[] };

function isPair(v: unknown): v is [number, number] {
    return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

/** Checks one answer; coordinates come back as normalised [x, y] / [x0, y0, x1, y1]. */
export function checkLocatorAnswer(text: string): LocatorCheck {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let answer: any;
    try {
        answer = JSON.parse(trimmed);
    } catch (err) {
        return { kind: 'invalid', problems: [`the answer is not JSON (${(err as Error).message})`] };
    }
    if (!answer || typeof answer !== 'object') return { kind: 'invalid', problems: ['the answer is not a JSON object'] };
    if (answer.found === false) return { kind: 'not-found', reason: typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : 'the model found nothing matching the description' };
    const problems: string[] = [];
    if (answer.found !== true) problems.push('"found" must be true or false');
    const inRange = (n: number) => n >= 0 && n <= 1000;
    const b = answer.box_2d;
    let box: [number, number, number, number] | undefined;
    if (!(Array.isArray(b) && b.length === 4 && b.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))) {
        problems.push('box_2d must be four numbers [ymin, xmin, ymax, xmax]');
    } else if (!b.every(inRange)) {
        problems.push(`box_2d ${JSON.stringify(b)} has values outside 0..1000`);
    } else if (!(b[0] < b[2] && b[1] < b[3])) {
        problems.push(`box_2d ${JSON.stringify(b)} is not ordered (ymin < ymax and xmin < xmax)`);
    } else {
        box = [b[0], b[1], b[2], b[3]];
    }
    const points = (key: 'positive' | 'negative', min: number): Array<[number, number]> => {
        const v = answer[key] ?? [];
        if (!Array.isArray(v)) { problems.push(`${key} must be a list of [y, x] points`); return []; }
        if (v.length < min) problems.push(`${key} needs at least ${min} point${min === 1 ? '' : 's'}`);
        if (v.length > MAX_POINTS) problems.push(`${key} has ${v.length} points; at most ${MAX_POINTS}`);
        const out: Array<[number, number]> = [];
        v.forEach((p: unknown, i: number) => {
            if (!isPair(p)) problems.push(`${key}[${i}] is not [y, x]`);
            else if (!p.every(inRange)) problems.push(`${key}[${i}] ${JSON.stringify(p)} is outside 0..1000`);
            else out.push(p);
        });
        return out;
    };
    const positive = points('positive', 1);
    const negative = points('negative', 0);
    if (box) {
        positive.forEach(([y, x], i) => {
            if (y < box![0] - BOX_TOLERANCE || y > box![2] + BOX_TOLERANCE || x < box![1] - BOX_TOLERANCE || x > box![3] + BOX_TOLERANCE) {
                problems.push(`positive[${i}] [${y}, ${x}] is outside box_2d`);
            }
        });
    }
    if (problems.length || !box) return { kind: 'invalid', problems };
    const norm = ([y, x]: [number, number]): NormPoint => [x / 1000, y / 1000];
    const clampIn = ([x, y]: NormPoint): NormPoint => [Math.min(Math.max(x, box![1] / 1000), box![3] / 1000), Math.min(Math.max(y, box![0] / 1000), box![2] / 1000)];
    return {
        kind: 'found',
        label: typeof answer.label === 'string' ? answer.label.trim().slice(0, 200) : '',
        prompts: {
            box: [box[1] / 1000, box[0] / 1000, box[3] / 1000, box[2] / 1000],
            positive: positive.map(norm).map(clampIn),
            negative: negative.map(norm)
        }
    };
}

/** The part of GeminiClient the locator uses (tests pass a fake client and candidate list). */
export interface LocatorModelSource {
    getGenAIClient(): Promise<VisionGenAIClient | undefined>;
    getModelCandidates(requestedModel?: string): string[];
}

/**
 * One locator per segmentation call: the chain picks the chat's model on its first call (a "model not found" moves on
 * to the next candidate, visibly) and keeps it for every re-check after.
 */
export class SegmentTargetLocator {
    private chain?: VisionModelChain<string>;

    constructor(private readonly source: LocatorModelSource, private readonly requestedModel?: string) {}

    private async getChain(signal?: AbortSignal): Promise<VisionModelChain<string>> {
        if (this.chain) return this.chain;
        const candidates = this.source.getModelCandidates(this.requestedModel).filter(m => typeof m === 'string' && m.trim());
        if (candidates.length === 0) throw new GeneratorFailedError('gemini', `${TOOL}: the chat has no vision model to find the target with`);
        const client = await this.source.getGenAIClient();
        if (!client) throw new GeneratorFailedError('gemini', `${TOOL}: no Google API key or service account is configured, so a described target cannot be found; give points or a box instead`);
        this.chain = new VisionModelChain<string>({
            client, candidates, signal,
            makeError: (stage, message) => new GeneratorFailedError('gemini', `${TOOL} (${stage}): ${message}`)
        });
        return this.chain;
    }

    async locate(req: LocateRequest): Promise<LocatedTarget> {
        const chain = await this.getChain(req.signal);
        const started = Date.now();
        const attemptsBefore = chain.attempts.length;
        const image = { inlineData: { mimeType: req.mimeType, data: req.imageBytes.toString('base64') } };
        const prompt = segmentLocatorPrompt(req.target, req.hintBox, req.hintKind, !!req.hintImage);
        const parts: unknown[] = req.hintImage
            ? [image, { text: prompt }, { inlineData: { mimeType: req.hintImage.mimeType, data: req.hintImage.bytes.toString('base64') } }]
            : [image, { text: prompt }];
        const contents: Content[] = [{ role: 'user', parts: parts as Content['parts'] }];
        const config = { responseMimeType: 'application/json', temperature: 0.1, ...(req.signal ? { abortSignal: req.signal } : {}) };
        let calls = 0;
        let last: LocatorCheck | undefined;
        let lastModel = chain.current;
        let thinking: LocatedTarget['thinking'];
        for (let round = 0; round < 2; round++) {
            const res = await chain.generate({ contents, config }, { stage: 'locate-target', thinkingBudget: SEGMENT_LOCATOR_THINKING_BUDGET, ...VISION_CALL_POLICY['locate-target'] });
            calls++;
            lastModel = res.model;
            thinking = res.thinking ? describeThinking(res.thinking) : undefined;
            const text = responseText(res.response);
            last = checkLocatorAnswer(text);
            if (last.kind === 'not-found') throw new SegmentTargetNotFoundError(TOOL, JSON.stringify(req.target), `${res.model} found nothing matching it: ${last.reason}`);
            if (last.kind === 'found') {
                return {
                    ...last.prompts, label: last.label, model: res.model, ...(thinking ? { thinking } : {}), ms: Date.now() - started, calls,
                    skippedModels: [...chain.skipped], attempts: chain.attempts.slice(attemptsBefore)
                };
            }
            contents.push({ role: 'model', parts: [{ text }] });
            contents.push({ role: 'user', parts: [{ text: `That answer cannot be used: ${last.problems.join('; ')}. Answer again with JSON only, in the shape asked for.` }] });
        }
        throw new GeneratorFailedError('gemini', `${TOOL}: ${lastModel} did not give usable prompts for ${JSON.stringify(req.target)} after ${calls} answers: ${(last as { problems: string[] }).problems.join('; ')}`);
    }
}
