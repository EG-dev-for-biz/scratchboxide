/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Open-vocabulary object masks for vfx_segment_subject: any object, in an image or a video, from a description, points
 * or a box.
 *
 * - Prompts: the user's points / box as given; a description with no positive point is turned into a box, positive
 *   points and negative points by the chat's vision model (segment-target-locator, LOW thinking, visible fallback).
 * - Mask: the MediaPipe Interactive Segmenter (MagicTouch) per prompt point, combined in scripts/segment_object.py on
 *   the persistent Python worker, optionally refined by OpenCV GrabCut; a binary mask and a soft matte per frame.
 * - Video: frame 1 from the prompts; each later frame from the previous mask carried by the object's own motion (scale
 *   and translation from masked template matching; dense optical flow follows the background inside weakly textured
 *   objects and was measured to drift), its interior points becoming the positive prompts and a ring just outside it
 *   the negative ones. With a description, the vision model looks again every `recheckEveryFrames` frames and
 *   whenever the mask's area or centroid jumps past the thresholds, and the frame is re-anchored on its answer; every
 *   re-check is reported with why it ran and how far the propagated mask had drifted from the re-anchored one.
 *
 * Failures are typed: a missing input is a MissingInputError, a description the model cannot find (or prompts that give
 * no mask) a SegmentTargetNotFoundError, a failed tool a GeneratorFailedError. No other segmenter (the person segmenter
 * included) stands in for a target that was not found, and a failed video leaves no partial sequence.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { GeneratorFailedError, InvalidInputError, MissingInputError, SegmentTargetNotFoundError } from '../../common/errors/pipeline-errors';
import { getPythonWorkerPool, PythonWorkerError } from '../process/persistent-python-worker';
import { repoPath, resolveRepoPython } from '../process/repo-python';
import { VfxSubjectSegmenterService } from './VfxSubjectSegmenterService';
import { GeminiClient } from '../gemini/gemini-client';
import { SegmentTargetLocator, type LocatedTarget, type LocatorModelSource, type NormBox, type NormPoint } from './segment-target-locator';

const TOOL = 'vfx_segment_subject';

export interface ObjectSegmentOptions {
    /** One image to segment (PNG / JPEG). Exactly one of imagePath and videoPath. */
    imagePath?: string;
    /** A video to segment frame by frame. */
    videoPath?: string;
    outputDir: string;
    /** The thing to cut out, in words. Found by the chat's vision model unless positive points are given. */
    target?: string;
    /** Points on the object, normalised [x, y] (0..1 of width / height). */
    positivePoints?: NormPoint[];
    /** Points on things that are not the object, normalised [x, y]. */
    negativePoints?: NormPoint[];
    /** A box around the object, normalised [x0, y0, x1, y1]. */
    box?: NormBox;
    /** Refine the edge with GrabCut (default true). */
    refine?: boolean;
    /** Video sampling rate (default 5 fps, 1..30). */
    fps?: number;
    /** With a description, the vision model re-checks every this many frames (default 10; 0 = only on a jump). */
    recheckEveryFrames?: number;
    /** A frame whose mask area changes by more than this factor from the previous one is a jump (default 1.6). */
    jumpAreaRatio?: number;
    /** A frame whose mask centroid moves more than this fraction of the frame diagonal is a jump (default 0.08). */
    jumpCentroidFraction?: number;
    /** The chat's requested model, if any. */
    requestedModel?: string;
    /** A second image — a user photo or a generated reference — shown to the vision model alongside the frame, as what `target` should look like. Only used when the vision model is doing the finding (a description, no positive points given); it never replaces the frame as the thing actually marked. */
    hintImage?: { bytes: Buffer; mimeType: string };
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
}

/** Where a frame's prompts came from (a diagnostic label; nothing branches on its text). */
export type PromptSource = 'user' | 'vision-model' | 'user+vision-model' | 'propagation' | (string & {});

export interface FrameSegmentStats {
    frame: number;
    timeSec?: number;
    maskPath: string;
    mattePath: string;
    areaFraction: number;
    centroid: [number, number];
    bbox: NormBox;
    components: number;
    promptSource: PromptSource;
    positiveUsed: NormPoint[];
    negativeUsed: NormPoint[];
    positiveDropped: Array<{ point: NormPoint; reason: string }>;
    refinement: string;
    matte: string;
    /** Set when the area or centroid jumped past a threshold relative to the previous frame. */
    jump?: { areaRatio: number; centroidShift: number };
    ms: number;
}

export interface RecheckRecord {
    frame: number;
    reason: string;
    model: string;
    label: string;
    /** IoU between the mask propagation made and the re-anchored mask (absent when propagation lost the object). */
    iouWithPropagated?: number;
    ms: number;
}

export interface ObjectSegmentResult {
    success: true;
    mode: 'image' | 'video';
    source: string;
    outputDir: string;
    width: number;
    height: number;
    totalFrames: number;
    sampleFps?: number;
    maskPaths: string[];
    mattePaths: string[];
    /** FFmpeg image2 patterns for the masks and mattes. */
    ffmpegPattern: string;
    matteFfmpegPattern: string;
    frames: FrameSegmentStats[];
    /** Provenance of the first frame's prompts. */
    prompts: {
        source: PromptSource;
        target?: string;
        visionModel?: { model: string; label: string; thinking?: LocatedTarget['thinking']; calls: number; ms: number; skippedModels: LocatedTarget['skippedModels'] };
        box?: NormBox;
        positive: NormPoint[];
        negative: NormPoint[];
    };
    rechecks: RecheckRecord[];
    /** Frames whose mask jumped and that no description could re-check (points-only video). */
    unrecheckedJumps: number[];
    refinement: 'grabcut' | 'none';
    models: string[];
    reportPath: string;
    timingsMs: { total: number; perFrameMean: number; vision: number };
    [key: string]: unknown;
}

interface ScriptAnswer {
    success: boolean;
    code?: string;
    error?: string;
    width: number;
    height: number;
    areaFraction: number;
    centroid: [number, number];
    bbox: NormBox;
    components: number;
    positiveUsed: NormPoint[];
    negativeUsed: NormPoint[];
    positiveDropped: Array<{ point: NormPoint; reason: string }>;
    refinement: string;
    matte: string;
    model: string;
    timingsMs: Record<string, number>;
    iouWithCompare?: number;
}

function mimeFor(file: string): string {
    return /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';
}

function checkNorm(name: string, values: unknown, size: 2 | 4): void {
    if (!Array.isArray(values) || values.length !== size || !values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
        throw new InvalidInputError(TOOL, name, `${JSON.stringify(values)} must be ${size} numbers normalised to 0..1`);
    }
}

export class ObjectSegmenterService {
    private readonly scriptPath: string;
    private readonly frameTimeoutMs: number;
    private readonly video: VfxSubjectSegmenterService;
    private chatModels?: LocatorModelSource;

    /**
     * @param options.modelSource where the vision model and credentials come from (the chat's GeminiClient by default).
     */
    constructor(private readonly options: {
        modelSource?: LocatorModelSource | (() => LocatorModelSource);
        pythonBinary?: string;
        scriptPath?: string;
        frameTimeoutMs?: number;
    } = {}) {
        this.scriptPath = options.scriptPath ?? repoPath('scripts', 'segment_object.py');
        this.frameTimeoutMs = options.frameTimeoutMs ?? 120_000;
        this.video = new VfxSubjectSegmenterService({ ...(options.pythonBinary ? { pythonBinary: options.pythonBinary } : {}) });
    }

    /** The interpreter (the caller's, else the project's, resolved and checked at first use: PythonEnvironmentError). */
    private get pythonBinary(): string {
        return this.options.pythonBinary ?? resolveRepoPython({ modules: ['numpy', 'cv2', 'mediapipe'], purpose: 'The object segmenter (scripts/segment_object.py)' });
    }

    private modelSource(): LocatorModelSource {
        const src = this.options.modelSource;
        if (typeof src === 'function') return src();
        if (src) return src;
        this.chatModels ??= new GeminiClient() as unknown as LocatorModelSource;
        return this.chatModels;
    }

    async segment(options: ObjectSegmentOptions): Promise<ObjectSegmentResult> {
        const started = Date.now();
        const { imagePath, videoPath, outputDir } = options;
        if (!!imagePath === !!videoPath) throw new MissingInputError(TOOL, 'imagePath or videoPath', 'give exactly one of them');
        const sourcePath = (imagePath ?? videoPath)!;
        if (!fs.existsSync(sourcePath)) throw new MissingInputError(TOOL, imagePath ? 'imagePath' : 'videoPath', `${sourcePath} does not exist`);
        if (!outputDir) throw new MissingInputError(TOOL, 'outputDir');
        const target = options.target?.trim() || undefined;
        const positive = options.positivePoints ?? [];
        const negative = options.negativePoints ?? [];
        positive.forEach((p, i) => checkNorm(`positivePoints[${i}]`, p, 2));
        negative.forEach((p, i) => checkNorm(`negativePoints[${i}]`, p, 2));
        if (options.box) {
            checkNorm('box', options.box, 4);
            if (!(options.box[0] < options.box[2] && options.box[1] < options.box[3])) throw new InvalidInputError(TOOL, 'box', `${JSON.stringify(options.box)} is not [x0, y0, x1, y1] with x0 < x1 and y0 < y1`);
        }
        if (!target && positive.length === 0 && !options.box) {
            throw new MissingInputError(TOOL, 'target, positivePoints or box', 'say what to cut out: a description, points on it, or a box around it');
        }
        if (!fs.existsSync(this.scriptPath)) throw new GeneratorFailedError('python', `${TOOL}: the segmentation script ${this.scriptPath} does not exist`);

        const refine = options.refine !== false;
        const progress = options.reportProgress ?? (() => undefined);
        const locator = target && positive.length === 0 ? new SegmentTargetLocator(this.modelSource(), options.requestedModel) : undefined;
        let visionMs = 0;

        await fs.ensureDir(outputDir);
        const workDir = path.join(outputDir, '.frames');
        const written: string[] = [];
        let complete = false;
        try {
            let framePaths: string[];
            let sampleFps: number | undefined;
            if (videoPath) {
                await this.video.probeVideo(videoPath);
                sampleFps = Math.max(1, Math.min(options.fps ?? 5, 30));
                await fs.emptyDir(workDir);
                await this.video.extractFrames(videoPath, path.join(workDir, 'frame_%04d.png'), sampleFps);
                framePaths = (await fs.readdir(workDir)).filter(f => f.endsWith('.png')).sort().map(f => path.join(workDir, f));
                if (framePaths.length === 0) throw new GeneratorFailedError('ffmpeg', `${TOOL}: FFmpeg extracted no frames from ${videoPath}`);
            } else {
                framePaths = [imagePath!];
            }

            const maskPath = (i: number) => path.join(outputDir, `mask_${String(i).padStart(4, '0')}.png`);
            const mattePath = (i: number) => path.join(outputDir, `matte_${String(i).padStart(4, '0')}.png`);

            // Frame 1's prompts.
            let firstPrompts = { positive, negative, box: options.box };
            let promptSource: PromptSource = 'user';
            let vision: ObjectSegmentResult['prompts']['visionModel'];
            if (locator) {
                progress(`Finding ${JSON.stringify(target)} with the vision model`, 0.02);
                const t = Date.now();
                const found = await locator.locate({ imageBytes: await fs.readFile(framePaths[0]), mimeType: mimeFor(framePaths[0]), target: target!, hintBox: options.box, hintKind: options.box ? 'user-box' : undefined, ...(options.hintImage ? { hintImage: options.hintImage } : {}), signal: options.signal });
                visionMs += Date.now() - t;
                firstPrompts = { positive: found.positive, negative: [...found.negative, ...negative], box: found.box };
                promptSource = negative.length || options.box ? 'user+vision-model' : 'vision-model';
                vision = { model: found.model, label: found.label, ...(found.thinking ? { thinking: found.thinking } : {}), calls: found.calls, ms: found.ms, skippedModels: found.skippedModels };
            }

            const frames: FrameSegmentStats[] = [];
            const rechecks: RecheckRecord[] = [];
            const unrecheckedJumps: number[] = [];
            const recheckEvery = Math.max(0, Math.floor(options.recheckEveryFrames ?? 10));
            const jumpArea = options.jumpAreaRatio ?? 1.6;
            const jumpCentroid = options.jumpCentroidFraction ?? 0.08;
            let models = new Set<string>();
            let width = 0, height = 0;

            const describe = (i: number) => videoPath ? `frame ${i + 1} of ${framePaths.length} (${(i / sampleFps!).toFixed(2)} s)` : 'the image';
            const run = async (i: number, request: Record<string, unknown>): Promise<ScriptAnswer> => {
                const answer = await this.runScript({ image: framePaths[i], outMask: maskPath(i), outMatte: mattePath(i), refine, ...request });
                written.push(maskPath(i), mattePath(i));
                return answer;
            };

            for (let i = 0; i < framePaths.length; i++) {
                if (options.signal?.aborted) throw new GeneratorFailedError('python', `${TOOL}: stopped by the user`);
                const t = Date.now();
                let answer: ScriptAnswer;
                let source: PromptSource;
                if (i === 0) {
                    answer = await run(0, { positive: firstPrompts.positive, negative: firstPrompts.negative, box: firstPrompts.box ?? null });
                    source = promptSource;
                    if (!answer.success) {
                        throw new SegmentTargetNotFoundError(TOOL, target ? JSON.stringify(target) : 'the prompted object', `${answer.code}: ${answer.error}`, videoPath ? 1 : undefined);
                    }
                } else {
                    const prev = frames[i - 1];
                    answer = await run(i, { propagateFrom: { image: framePaths[i - 1], mask: prev.maskPath }, negative: [] });
                    source = 'propagation';
                    let reason: string | undefined;
                    let jump: FrameSegmentStats['jump'];
                    if (answer.success) {
                        const areaRatio = answer.areaFraction / Math.max(prev.areaFraction, 1e-9);
                        const shift = Math.hypot((answer.centroid[0] - prev.centroid[0]) * width, (answer.centroid[1] - prev.centroid[1]) * height) / Math.hypot(width, height);
                        if (areaRatio > jumpArea || areaRatio < 1 / jumpArea || shift > jumpCentroid) {
                            jump = { areaRatio: +areaRatio.toFixed(3), centroidShift: +shift.toFixed(4) };
                            reason = `the mask jumped (area x${areaRatio.toFixed(2)}, centroid moved ${(shift * 100).toFixed(1)}% of the diagonal)`;
                        } else if (recheckEvery > 0 && i % recheckEvery === 0) {
                            reason = `scheduled re-check every ${recheckEvery} frames`;
                        }
                    } else {
                        reason = `propagation lost the object (${answer.code}: ${answer.error})`;
                    }
                    if (reason && locator) {
                        const propagatedCopy = answer.success ? path.join(outputDir, `.propagated_${String(i).padStart(4, '0')}.png`) : undefined;
                        if (propagatedCopy) await fs.copy(maskPath(i), propagatedCopy);
                        const tv = Date.now();
                        const found = await locator.locate({ imageBytes: await fs.readFile(framePaths[i]), mimeType: mimeFor(framePaths[i]), target: target!, hintBox: prev.bbox, hintKind: 'previous-frame', signal: options.signal })
                            .catch(err => { throw err instanceof SegmentTargetNotFoundError ? new SegmentTargetNotFoundError(TOOL, JSON.stringify(target), err.reason, i + 1) : err; });
                        visionMs += Date.now() - tv;
                        answer = await run(i, { positive: found.positive, negative: [...found.negative, ...negative], box: found.box, ...(propagatedCopy ? { compareMask: propagatedCopy } : {}) });
                        if (propagatedCopy) await fs.remove(propagatedCopy);
                        if (!answer.success) throw new SegmentTargetNotFoundError(TOOL, JSON.stringify(target), `the re-check's prompts gave no mask (${answer.code}: ${answer.error})`, i + 1);
                        rechecks.push({
                            frame: i + 1, reason, model: found.model, label: found.label,
                            ...(answer.iouWithCompare !== undefined ? { iouWithPropagated: answer.iouWithCompare } : {}),
                            ms: Date.now() - tv
                        });
                        source = 'vision-model';
                        jump = undefined;
                    } else if (!answer.success) {
                        throw new SegmentTargetNotFoundError(TOOL, 'the prompted object', `${describe(i)}: ${reason} and there is no description to look for it again`, i + 1);
                    } else if (jump) {
                        unrecheckedJumps.push(i + 1);
                    }
                    if (jump) (answer as ScriptAnswer & { jump?: FrameSegmentStats['jump'] }).jump = jump;
                }
                width = answer.width; height = answer.height;
                models.add(answer.model);
                frames.push({
                    frame: i + 1,
                    ...(sampleFps ? { timeSec: +(i / sampleFps).toFixed(3) } : {}),
                    maskPath: maskPath(i), mattePath: mattePath(i),
                    areaFraction: answer.areaFraction, centroid: answer.centroid, bbox: answer.bbox, components: answer.components,
                    promptSource: source, positiveUsed: answer.positiveUsed, negativeUsed: answer.negativeUsed, positiveDropped: answer.positiveDropped,
                    refinement: answer.refinement, matte: answer.matte,
                    ...((answer as { jump?: FrameSegmentStats['jump'] }).jump ? { jump: (answer as { jump?: FrameSegmentStats['jump'] }).jump } : {}),
                    ms: Date.now() - t
                });
                progress(`Segmented ${describe(i)}`, 0.05 + 0.9 * (i + 1) / framePaths.length);
            }
            if (vision) models.add(vision.model);
            for (const r of rechecks) models.add(r.model);
            models = new Set(Array.from(models));

            const reportPath = path.join(outputDir, 'segment_report.json');
            const total = Date.now() - started;
            const result: ObjectSegmentResult = {
                success: true,
                mode: videoPath ? 'video' : 'image',
                source: sourcePath,
                outputDir, width, height,
                totalFrames: frames.length,
                ...(sampleFps ? { sampleFps } : {}),
                maskPaths: frames.map(f => f.maskPath),
                mattePaths: frames.map(f => f.mattePath),
                ffmpegPattern: path.join(outputDir, 'mask_%04d.png'),
                matteFfmpegPattern: path.join(outputDir, 'matte_%04d.png'),
                frames,
                prompts: {
                    source: promptSource, ...(target ? { target } : {}), ...(vision ? { visionModel: vision } : {}),
                    ...(firstPrompts.box ? { box: firstPrompts.box } : {}), positive: firstPrompts.positive, negative: firstPrompts.negative
                },
                rechecks, unrecheckedJumps,
                refinement: refine ? 'grabcut' : 'none',
                models: Array.from(models),
                reportPath,
                timingsMs: { total, perFrameMean: Math.round(frames.reduce((s, f) => s + f.ms, 0) / frames.length), vision: visionMs }
            };
            await fs.writeJson(reportPath, result, { spaces: 2 });
            complete = true;
            return result;
        } finally {
            if (videoPath) await fs.remove(workDir);
            if (!complete) await Promise.all(written.map(p => fs.remove(p)));
        }
    }

    private async runScript(request: Record<string, unknown>): Promise<ScriptAnswer> {
        const pool = getPythonWorkerPool({ pythonBinary: this.pythonBinary, scriptPath: this.scriptPath, label: 'the object segmenter', maxWorkers: 1 });
        let res;
        try {
            res = await pool.run({ argv: [], stdin: JSON.stringify(request), timeoutMs: this.frameTimeoutMs });
        } catch (err: any) {
            throw new GeneratorFailedError('python', `${TOOL}: ${err instanceof PythonWorkerError ? err.message : `${this.pythonBinary} could not run the object segmenter: ${err?.message || err}`}`);
        }
        const line = res.stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
        let answer: ScriptAnswer | undefined;
        try { answer = line ? JSON.parse(line) : undefined; } catch { answer = undefined; }
        const tail = res.stderr.trim() ? `: ${res.stderr.trim().slice(-400)}` : '';
        if (!answer) throw new GeneratorFailedError('python', `${TOOL}: the object segmenter exited ${res.exitCode} without an answer${tail}`);
        if (answer.success && res.exitCode !== 0) throw new GeneratorFailedError('python', `${TOOL}: the object segmenter answered success but exited ${res.exitCode}${tail}`);
        // a prompt that gives no mask is the caller's to report (not found); any other failure is the tool's
        if (!answer.success && answer.code !== 'empty_mask') throw new GeneratorFailedError('python', `${TOOL}: the object segmenter failed (${answer.code}): ${answer.error}`);
        return answer;
    }
}
