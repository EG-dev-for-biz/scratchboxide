/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The quality gate: before a chat turn that made files ends, an independent reviewer checks them against a bar set
 * from the request, and the agent revises until the bar is met or says plainly what is not (user ask, 2026-11-06:
 * "accomplishing the goal to a quality bar is important"). Found in the live app test that day: a cut-out reply said
 * the car was "cleanly captured" while the matte it showed did not match the cut-out, a "4-second video" was a zoom
 * on one still labelled 4K, and the end-of-turn visual check that scored such results ran after the reply, advisory.
 *
 *  1. The bar: checkable criteria read from the request alone, before anything made is looked at (`deriveCriteria`).
 *  2. Facts first: what code can measure about each file (size, alpha, motion between frames: `measureDeliverable`).
 *  3. The reviewer: a separate vision call with fresh context, given the request, the bar, the facts, the files and
 *     the agent's claims, never its verdict; it answers met or not met per criterion, with where and why.
 *  4. The loop: streaming.ts sends unmet criteria back as feedback, at most MAX_GATE_ROUNDS times, then asks for a
 *     final reply that names what is still unmet. A reply never claims a criterion the reviewer failed.
 *
 * Criteria are open vocabulary from the request (AGENTS.md §1): nothing here branches on a kind of task.
 * `SCRATCHBOX_QUALITY_GATE=0` turns the gate off.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { GoogleGenAI } from '@google/genai';
import { decodeImageToRgba, readImageDimensions, resolveFfmpegPath } from '../image-codec-ffmpeg';
import { downscaleForVision } from '../vision-image-downscale';
import { thinkingConfigFor } from './thinking-config';

const execFileAsync = promisify(execFile);

/** Revision rounds the reviewer can send back before the agent must report what is unmet. */
export const MAX_GATE_ROUNDS = 2;
/** The files a review looks at, newest first (each is an image the reviewer is shown, or a video's three frames). */
export const MAX_REVIEWED_FILES = 4;
/** Images one review call carries. */
const MAX_REVIEW_IMAGES = 8;
/** The reviewer: the cheapest capable vision model (the facade reader's, chosen 2026-10-29 for speed and cost). */
export const QUALITY_GATE_MODEL = 'gemini-3.8-flash';
const GATE_THINKING_BUDGET = 1024;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const MODEL_EXT = new Set(['.glb', '.gltf']);

/** On unless SCRATCHBOX_QUALITY_GATE=0; under a test runner off unless SCRATCHBOX_QUALITY_GATE=1 (tests never bill). */
export function qualityGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.SCRATCHBOX_QUALITY_GATE === '1') return true;
    if (env.SCRATCHBOX_QUALITY_GATE === '0') return false;
    return !(env.VITEST || env.SCRATCHBOX_TEST === '1');
}

/** The part of GeminiClient the gate uses (as the visual check's VisionModelClient). */
export interface GateModelClient {
    getGenAIClient(): Promise<Pick<GoogleGenAI, 'models'> | undefined>;
}

export interface Deliverable {
    path: string;
    kind: 'image' | 'video' | 'model';
    /** What code measured about the file, as short "name: value" facts for the reviewer. */
    facts: string[];
    /** Images the reviewer is shown for it: the image itself, or a video's first, middle and last frames. */
    frames: string[];
}

export interface GateVerdict {
    criterion: string;
    met: boolean;
    where?: string;
    reason: string;
}

export type GateReview =
    | { status: 'reviewed'; criteria: string[]; verdicts: GateVerdict[]; modelUsed: string; files: string[] }
    | { status: 'unavailable'; criteria: string[]; error: string; modelUsed: string; files: string[] };

// ----------------------------------------------------------------------
// Which files a turn made
// ----------------------------------------------------------------------

/**
 * The media files a tool result names (any string value, at any depth up to 5, ending in an image, video or glTF
 * extension, plus modelImages paths), resolved against the given roots and kept only when the file exists.
 */
export function deliverablePathsFromResult(result: unknown, roots: string[], exists: (p: string) => boolean = fs.existsSync): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    const consider = (value: string) => {
        const ext = path.extname(value.split('?')[0]).toLowerCase();
        if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext) && !MODEL_EXT.has(ext)) return;
        if (/^(https?:|data:|blob:)/i.test(value) || value.includes('node_modules')) return;
        const candidates = path.isAbsolute(value) && exists(value)
            ? [value]
            : roots.map(r => path.resolve(r, value.replace(/^\/+/, '')));
        for (const c of candidates) {
            if (!seen.has(c) && exists(c)) {
                seen.add(c);
                found.push(c);
                return;
            }
        }
    };
    const walk = (node: unknown, depth: number) => {
        if (depth > 5 || node == null) return;
        if (typeof node === 'string') {
            if (node.length < 1024) consider(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const v of node.slice(0, 64)) walk(v, depth + 1);
            return;
        }
        if (typeof node === 'object') {
            for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
        }
    };
    walk(result, 0);
    return found;
}

// ----------------------------------------------------------------------
// What code can measure
// ----------------------------------------------------------------------

async function probeVideo(file: string): Promise<{ width?: number; height?: number; duration?: number; frames?: number; fps?: number }> {
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=width,height,nb_read_packets,r_frame_rate:format=duration', '-of', 'json', file], { timeout: 30_000 });
    const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; nb_read_packets?: string; r_frame_rate?: string }>; format?: { duration?: string } };
    const s = j.streams?.[0] ?? {};
    const [num, den] = (s.r_frame_rate || '').split('/').map(Number);
    return {
        width: s.width,
        height: s.height,
        duration: j.format?.duration ? Number(j.format.duration) : undefined,
        frames: s.nb_read_packets ? Number(s.nb_read_packets) : undefined,
        fps: num && den ? num / den : undefined
    };
}

/** A frame at `seconds` as a PNG file, and its 64 x 36 grey thumbnail for measuring motion. */
async function grabFrame(file: string, seconds: number, outDir: string, name: string): Promise<{ png: string; grey: Buffer }> {
    const ffmpeg = resolveFfmpegPath();
    const png = path.join(outDir, `${name}.png`);
    await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-ss', seconds.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', png], { timeout: 30_000 });
    if (!fs.existsSync(png)) throw new Error(`no frame at ${seconds.toFixed(2)} s`);
    const { stdout } = await execFileAsync(ffmpeg, ['-v', 'error', '-ss', seconds.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'], { timeout: 30_000, encoding: 'buffer', maxBuffer: 1 << 20 });
    return { png, grey: stdout as unknown as Buffer };
}

/** Mean absolute difference of two grey thumbnails, 0..255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
    return sum / n;
}

/** The facts code can state about one file, and the frames the reviewer sees for it. A file that cannot be read says so. */
export async function measureDeliverable(file: string, scratchDir: string): Promise<Deliverable> {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    if (IMAGE_EXT.has(ext)) {
        const facts: string[] = [];
        try {
            const buf = fs.readFileSync(file);
            const dims = readImageDimensions(buf);
            if (dims) facts.push(`size: ${dims.width} x ${dims.height} px`);
            if (ext === '.png') {
                const img = await decodeImageToRgba(buf);
                let lo = 255, hi = 0, opaque = 0;
                const n = img.width * img.height;
                for (let i = 3; i < img.rgba.length; i += 4) {
                    const a = img.rgba[i];
                    if (a < lo) lo = a;
                    if (a > hi) hi = a;
                    if (a > 127) opaque++;
                }
                facts.push(lo === 255 ? 'transparency: none (every pixel opaque)' : `transparency: alpha ${lo}-${hi}, ${(100 * opaque / n).toFixed(1)}% of pixels opaque`);
            } else {
                facts.push('transparency: none (format has no alpha)');
            }
        } catch (err) {
            facts.push(`unreadable: ${(err as Error).message}`);
        }
        return { path: file, kind: 'image', facts, frames: [file] };
    }
    if (VIDEO_EXT.has(ext)) {
        const facts: string[] = [];
        const frames: string[] = [];
        try {
            const v = await probeVideo(file);
            if (v.width && v.height) facts.push(`size: ${v.width} x ${v.height} px`);
            if (v.duration !== undefined) facts.push(`duration: ${v.duration.toFixed(2)} s`);
            if (v.fps) facts.push(`frame rate: ${v.fps.toFixed(2)} fps`);
            if (v.frames !== undefined) facts.push(`frames: ${v.frames}`);
            const d = v.duration ?? 0;
            const dir = fs.mkdtempSync(path.join(scratchDir, 'gate-'));
            const stem = name.replace(/[^a-z0-9]+/gi, '_');
            const first = await grabFrame(file, 0, dir, `${stem}_first`);
            const mid = await grabFrame(file, d / 2, dir, `${stem}_middle`);
            // a seek within a frame or two of the end returns no frame: the last tenth stands for the end
            const last = await grabFrame(file, d * 0.9, dir, `${stem}_last`);
            frames.push(first.png, mid.png, last.png);
            facts.push(`change first->middle: ${meanAbsDiff(first.grey, mid.grey).toFixed(1)}/255, middle->last: ${meanAbsDiff(mid.grey, last.grey).toFixed(1)}/255 (mean grey difference of 64x36 thumbnails)`);
        } catch (err) {
            facts.push(`unreadable: ${(err as Error).message}`);
        }
        return { path: file, kind: 'video', facts, frames };
    }
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* reported as 0 */ }
    return { path: file, kind: 'model', facts: [`file size: ${(size / 1e6).toFixed(2)} MB (a 3D file: judge it from the renders shown, if any)`], frames: [] };
}

// ----------------------------------------------------------------------
// The bar and the reviewer
// ----------------------------------------------------------------------

const CRITERIA_INSTRUCTION = `You set the acceptance bar for a creative production task before anyone looks at the result.
From the user's request alone, write 2 to 6 criteria a reviewer can check by looking at the delivered files and their measured facts.
Each criterion is one short sentence stating something that must be true of the result: what must be present and complete, the form asked for (for example transparency, motion, duration, resolution), and the qualities the request names (materials, lighting, condition, style).
Only what the request asks for or plainly implies; no extra wishes. Return JSON: {"criteria": ["..."]}.`;

const REVIEW_INSTRUCTION = `You are an independent reviewer of a production result. You did not make it.
Judge each acceptance criterion only from the images shown and the measured facts. The maker's claims are given so you can check them: a claim is not evidence, and a fact or image that contradicts a claim means the criterion is not met.
A criterion is met only when the evidence shows it. When the evidence cannot show it, it is not met, and the reason says what is missing.
For each criterion answer: met (true/false), where (the file and the region you mean, short) and reason (one sentence).
Return JSON: {"verdicts": [{"criterion": "...", "met": true, "where": "...", "reason": "..."}]} with one entry per criterion, in order.`;

function parseJson<T>(text: string): T | undefined {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        const m = trimmed.match(/\{[\s\S]*\}/);
        if (!m) return undefined;
        try { return JSON.parse(m[0]) as T; } catch { return undefined; }
    }
}

/** The bar, from the request alone (no result is shown). Throws when the model gives no criteria. */
export async function deriveCriteria(client: GateModelClient, request: string, model = QUALITY_GATE_MODEL): Promise<string[]> {
    const genai = await client.getGenAIClient();
    if (!genai) throw new Error('no Google Cloud service account or Gemini API key is configured');
    const response = await genai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `User request:\n${request}` }] }],
        config: {
            systemInstruction: CRITERIA_INSTRUCTION,
            temperature: 0.1,
            maxOutputTokens: 2048,
            thinkingConfig: thinkingConfigFor(model, GATE_THINKING_BUDGET),
            responseMimeType: 'application/json'
        }
    } as never);
    const parsed = parseJson<{ criteria?: unknown }>(response.text ?? '');
    const criteria = Array.isArray(parsed?.criteria) ? parsed!.criteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(c => c.trim()).slice(0, 6) : [];
    if (!criteria.length) throw new Error(`${model} gave no acceptance criteria`);
    return criteria;
}

/** The newest files first, at most MAX_REVIEWED_FILES. */
export function filesToReview(paths: string[]): string[] {
    return [...paths].reverse().slice(0, MAX_REVIEWED_FILES);
}

export interface ReviewInput {
    request: string;
    criteria: string[];
    deliverables: Deliverable[];
    /** The maker's draft reply: its claims, checked, never trusted. */
    claims: string;
}

/** One review: met or not met per criterion. Returns 'unavailable' with the reason instead of throwing. */
export async function reviewDeliverables(client: GateModelClient, input: ReviewInput, model = QUALITY_GATE_MODEL): Promise<GateReview> {
    const files = input.deliverables.map(d => d.path);
    const unavailable = (error: string): GateReview => ({ status: 'unavailable', criteria: input.criteria, error, modelUsed: model, files });
    let genai: Pick<GoogleGenAI, 'models'> | undefined;
    try {
        genai = await client.getGenAIClient();
    } catch (err) {
        return unavailable(`the reviewer's credentials could not be loaded: ${(err as Error).message}`);
    }
    if (!genai) return unavailable('no Google Cloud service account or Gemini API key is configured');

    const parts: Array<Record<string, unknown>> = [];
    let shown = 0;
    for (const d of input.deliverables) {
        parts.push({ text: `File: ${path.basename(d.path)} (${d.kind})\nMeasured: ${d.facts.join('; ') || 'nothing measurable'}` });
        for (const frame of d.frames) {
            if (shown >= MAX_REVIEW_IMAGES) break;
            try {
                const raw = fs.readFileSync(frame);
                const mime = frame.toLowerCase().endsWith('.png') ? 'image/png' : frame.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
                const small = await downscaleForVision(raw, mime);
                parts.push({ text: `Image: ${path.basename(frame)}` });
                parts.push({ inlineData: { mimeType: small.mimeType, data: small.data.toString('base64') } });
                shown++;
            } catch (err) {
                parts.push({ text: `Image ${path.basename(frame)} could not be read: ${(err as Error).message}` });
            }
        }
    }
    parts.push({ text: `User request:\n${input.request}\n\nAcceptance criteria:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nThe maker's claims (check them, do not trust them):\n${input.claims.slice(0, 4000) || '(none)'}` });

    let text = '';
    try {
        const response = await genai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
                systemInstruction: REVIEW_INSTRUCTION,
                temperature: 0.1,
                maxOutputTokens: 4096,
                thinkingConfig: thinkingConfigFor(model, GATE_THINKING_BUDGET),
                responseMimeType: 'application/json'
            }
        } as never);
        text = response.text ?? '';
    } catch (err) {
        return unavailable(`${model} could not review the result: ${(err as Error).message}`);
    }
    const parsed = parseJson<{ verdicts?: unknown }>(text);
    const raw = Array.isArray(parsed?.verdicts) ? parsed!.verdicts as Array<Record<string, unknown>> : [];
    if (!raw.length) return unavailable(`${model} returned no verdicts (${text.trim() ? 'the reply is not the verdict JSON' : 'empty reply'})`);
    const verdicts = input.criteria.map((criterion, i): GateVerdict => {
        const v = raw[i] ?? {};
        return {
            criterion,
            met: v.met === true,
            ...(typeof v.where === 'string' && v.where.trim() ? { where: v.where.trim() } : {}),
            reason: typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : (raw[i] ? 'no reason given' : 'the reviewer gave no verdict for this criterion')
        };
    });
    return { status: 'reviewed', criteria: input.criteria, verdicts, modelUsed: model, files };
}

// ----------------------------------------------------------------------
// What the chat shows and the agent is told
// ----------------------------------------------------------------------

export function unmetVerdicts(review: GateReview): GateVerdict[] {
    return review.status === 'reviewed' ? review.verdicts.filter(v => !v.met) : [];
}

/** The line the chat shows after a review. */
export function formatReviewNotice(review: GateReview, round: number): string {
    if (review.status === 'unavailable') return `\n\n---\nIndependent review unavailable: ${review.error}.`;
    const met = review.verdicts.filter(v => v.met).length;
    const lines = review.verdicts.map(v => `- ${v.met ? 'Met' : 'Not met'}: ${v.criterion}${v.met ? '' : ` (${v.where ? `${v.where}: ` : ''}${v.reason})`}`);
    return `\n\n---\nIndependent review (${review.modelUsed}, round ${round}): ${met} of ${review.verdicts.length} criteria met.\n${lines.join('\n')}`;
}

/** The feedback the agent gets when criteria are unmet. On the last round it must report, not revise. */
export function formatReviewFeedback(review: GateReview, lastRound: boolean): string {
    const unmet = unmetVerdicts(review);
    const list = unmet.map((v, i) => `${i + 1}. ${v.criterion}\n   Where: ${v.where || 'not given'}\n   Why: ${v.reason}`).join('\n');
    const head = `[INDEPENDENT REVIEW] A reviewer that did not make the result checked it against the request and found ${unmet.length} of ${review.status === 'reviewed' ? review.verdicts.length : unmet.length} criteria not met:\n${list}\n\n`;
    return head + (lastRound
        ? 'No revision rounds are left. Write your final reply now without calling tools: say plainly which of these criteria are not met and why, and do not claim them.'
        : 'Fix these with your tools, look at the new result yourself, then give your final reply. Do not claim a criterion the review found unmet unless you have changed the result.');
}

/** A folder for the frames a review extracts (deleted with the OS temp folder). */
export function gateScratchDir(): string {
    const dir = path.join(os.tmpdir(), 'scratchbox-quality-gate');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
