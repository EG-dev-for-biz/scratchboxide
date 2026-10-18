/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A Stop (or the tool's time limit) ends the MediaPipe director tools: the tool's ctx.signal reaches every sampled
 * frame, the ffmpeg and Python processes, and the visual critic's vision call. After a Stop no further frame is
 * tracked, no billed vision request is sent, no contact sheet is left next to the video and no reframed video is
 * written. The audit tracks at most VISUAL_CRITIC_MAX_TRACKED_FRAMES frames spread over the clip and reports progress
 * for each. Editors, pose detectors and the vision model are fakes (no model is called); the process tests spawn
 * stand-in executables that only sleep.
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    MediaPipeVideoDirectorService,
    VISUAL_CRITIC_DIMENSIONS,
    VISUAL_CRITIC_MAX_TRACKED_FRAMES
} from '../src/node/video/MediaPipeVideoDirectorService';
import { HeadlessVideoEditorService } from '../src/node/video/HeadlessVideoEditorService';
import { MediaPipePoseService } from '../src/node/spatial/MediaPipePoseService';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-director-stop-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

function video(name: string): string {
    const p = path.join(DIR, name);
    fs.writeFileSync(p, 'not decoded by the fake editor');
    return p;
}

const sheetsNextTo = (videoPath: string) => fs.readdirSync(path.dirname(videoPath))
    .filter(f => f.startsWith(path.basename(videoPath, path.extname(videoPath))) && f.includes('_audit_sheet_'));

function stopped(): AbortSignal {
    const c = new AbortController();
    c.abort();
    return c.signal;
}

/** A fake editor for a clip of `durationSec`: records what it was asked to do and writes the files it is asked for. */
function fakeEditor(durationSec = 0.5) {
    const calls = { sheet: 0, probe: 0, extracted: [] as number[][], extractSignals: [] as Array<AbortSignal | undefined>, quickEdit: [] as any[] };
    const editor: any = {
        generateStoryboardSheet: async ({ outputPath }: { outputPath: string }) => {
            calls.sheet++;
            fs.writeFileSync(outputPath, JPEG);
            return { success: true, outputPath };
        },
        probeMedia: async () => { calls.probe++; return { width: 1280, height: 720, durationSec }; },
        extractKeyframes: async ({ timestampsSec, outputDir, signal }: { timestampsSec: number[]; outputDir: string; signal?: AbortSignal }) => {
            calls.extracted.push(timestampsSec);
            calls.extractSignals.push(signal);
            return { outputPaths: timestampsSec.map((_, i) => { const f = path.join(outputDir, `f${i}.png`); fs.writeFileSync(f, `frame ${i}`); return f; }) };
        },
        quickEdit: async (opts: any) => {
            calls.quickEdit.push(opts);
            fs.writeFileSync(opts.outputPath, 'reframed');
            return { success: true, outputPath: opts.outputPath, ffmpegCommand: 'ffmpeg ...' };
        }
    };
    return { editor, calls };
}

function landmarks() {
    return Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: 0.2 + i * 0.01, z: 0, visibility: 0.9 }));
}

/** A pose detector that finds a person in every frame; `onCall(n)` runs before it answers frame n (1-based). */
function fakePose(onCall: (n: number) => void = () => undefined) {
    const calls = { estimate: 0, run: 0, signals: [] as Array<AbortSignal | undefined> };
    const angles = Object.fromEntries(['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'spine', 'head'].map(k => [k, [0, 0, 0]]));
    const pose: any = {
        estimatePoseFromImage: async (_req: unknown, options?: { signal?: AbortSignal }) => {
            calls.estimate++;
            calls.signals.push(options?.signal);
            onCall(calls.estimate);
            return { success: true, personIndex: 0, angles, hipPositionMeters: [0, 0.9, 0], confidence: 0.8, worldLandmarks: landmarks(), imageLandmarks: landmarks() };
        },
        runPoseLandmarkerOnFile: async (_file: string, options?: { signal?: AbortSignal }) => {
            calls.run++;
            calls.signals.push(options?.signal);
            onCall(calls.run);
            return { detection: { worldLandmarks: [landmarks()], imageLandmarks: [landmarks()] } };
        }
    };
    return { pose, calls };
}

/** A fake vision model: records each request, and runs `during` while the request is in flight. */
function fakeVision(during: () => void = () => undefined) {
    const requests: any[] = [];
    const client = {
        models: {
            generateContent: async (req: any) => {
                requests.push(req);
                during();
                const dims = Object.fromEntries(Object.keys(VISUAL_CRITIC_DIMENSIONS).map(k => [k, { score: 9, notes: `seen: ${k}` }]));
                return { text: JSON.stringify({ dimensions: dims, actionDirectives: [], suggestedFfmpegFilters: [] }) };
            }
        }
    };
    return { client, requests };
}

/**
 * The tool's service is a module singleton that keeps the first vision client it gets, so the tool-level tests share
 * one fake and clear its record before each use.
 */
const toolVision = fakeVision();
function useToolVision() {
    toolVision.requests.length = 0;
    vi.spyOn(GeminiClient.prototype, 'getGenAIClient').mockResolvedValue(toolVision.client as any);
    return toolVision;
}

describe('vfx_visual_critic_audit stops when the chat stops it', () => {
    it('an audit stopped before it starts runs nothing: no sheet, no frame, no vision call (the review\'s probe)', async () => {
        const sheet = vi.spyOn(HeadlessVideoEditorService.prototype, 'generateStoryboardSheet');
        const probe = vi.spyOn(HeadlessVideoEditorService.prototype, 'probeMedia');
        const extract = vi.spyOn(HeadlessVideoEditorService.prototype, 'extractKeyframes');
        const estimate = vi.spyOn(MediaPipePoseService.prototype, 'estimatePoseFromImage');
        const vision = useToolVision();

        const videoPath = video('stopped_before.mp4');
        const res = await createDefaultToolRegistry().dispatch('vfx_visual_critic_audit', { videoPath }, { signal: stopped() } as any);

        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toMatch(/stopped/i);
        expect(res.exec.summaryResult).not.toMatch(/PASSED/);
        expect(sheet).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
        expect(extract).not.toHaveBeenCalled();
        expect(estimate).not.toHaveBeenCalled();
        expect(vision.requests).toHaveLength(0);
        expect(sheetsNextTo(videoPath)).toEqual([]);
    });

    it('a Stop during tracking ends it at that frame: no further frame, no vision call, and the sheet is removed', async () => {
        const stop = new AbortController();
        const { editor } = fakeEditor(30);
        const { pose, calls } = fakePose(n => { if (n === 3) stop.abort(); });
        const vision = fakeVision();
        const videoPath = video('stopped_tracking.mp4');

        const err = await new MediaPipeVideoDirectorService(editor, pose, { visionClient: vision.client })
            .auditVideoFidelity({ videoPath, signal: stop.signal }).catch(e => e);

        expect(err?.name).toBe('AbortError');
        expect(calls.estimate).toBe(3);
        // The pose detector got the signal, so a Stop also ends the Python process of the frame in flight.
        expect(calls.signals.every(s => s === stop.signal)).toBe(true);
        expect(vision.requests).toHaveLength(0);
        expect(sheetsNextTo(videoPath)).toEqual([]);
    });

    it('a Stop during the vision call: the request carries the signal, the late answer is dropped and the sheet removed', async () => {
        const stop = new AbortController();
        const { editor } = fakeEditor();
        const vision = fakeVision(() => stop.abort());
        const videoPath = video('stopped_vision.mp4');

        const err = await new MediaPipeVideoDirectorService(editor, fakePose().pose, { visionClient: vision.client })
            .auditVideoFidelity({ videoPath, signal: stop.signal }).catch(e => e);

        expect(err?.name).toBe('AbortError');
        expect(vision.requests).toHaveLength(1);
        expect(vision.requests[0].config.abortSignal).toBe(stop.signal);
        expect(sheetsNextTo(videoPath)).toEqual([]);
    });

    it(`tracks at most ${VISUAL_CRITIC_MAX_TRACKED_FRAMES} frames spread over a long clip, and reports progress for each`, async () => {
        const { editor, calls } = fakeEditor(60);
        const { pose, calls: poseCalls } = fakePose();
        const progress: Array<[string, number | undefined]> = [];
        const audit = await new MediaPipeVideoDirectorService(editor, pose, { visionClient: fakeVision().client })
            .auditVideoFidelity({ videoPath: video('long.mp4'), onProgress: (m, f) => progress.push([m, f]) });

        // 8 fps over 60 s would be 480 Python runs; the audit samples 24 evenly over the clip instead.
        const ts = calls.extracted[0];
        expect(ts).toHaveLength(VISUAL_CRITIC_MAX_TRACKED_FRAMES);
        expect(ts[0]).toBe(0);
        expect(ts[ts.length - 1]).toBeCloseTo(60 - 60 / VISUAL_CRITIC_MAX_TRACKED_FRAMES, 2);
        expect(poseCalls.estimate).toBe(VISUAL_CRITIC_MAX_TRACKED_FRAMES);
        expect(audit.anatomicalConsistency.framesSampled).toBe(VISUAL_CRITIC_MAX_TRACKED_FRAMES);

        const frameReports = progress.filter(([m]) => /frame \d+\/24/.test(m));
        expect(frameReports).toHaveLength(VISUAL_CRITIC_MAX_TRACKED_FRAMES);
        const fractions = progress.map(([, f]) => f).filter((f): f is number => typeof f === 'number');
        expect(fractions.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= fractions[i - 1]))).toBe(true);
        expect(progress.some(([m]) => /vision model/i.test(m))).toBe(true);
    });

    it('the tool passes ctx.signal and ctx.reportProgress down to the vision call', async () => {
        const { editor } = fakeEditor();
        for (const m of ['generateStoryboardSheet', 'probeMedia', 'extractKeyframes'] as const) {
            vi.spyOn(HeadlessVideoEditorService.prototype, m).mockImplementation(editor[m]);
        }
        vi.spyOn(MediaPipePoseService.prototype, 'estimatePoseFromImage').mockImplementation(fakePose().pose.estimatePoseFromImage);
        const vision = useToolVision();

        const signal = new AbortController().signal;
        const reportProgress = vi.fn();
        const res = await createDefaultToolRegistry().dispatch('vfx_visual_critic_audit', { videoPath: video('tool.mp4') }, { signal, reportProgress } as any);

        expect(res.exec.status).toBe('completed');
        expect(vision.requests).toHaveLength(1);
        expect(vision.requests[0].config.abortSignal).toBe(signal);
        expect(reportProgress).toHaveBeenCalled();
    });
});

describe('vfx_mediapipe_track_video_motion and vfx_video_auto_reframe stop when the chat stops them', () => {
    it('a stopped track runs nothing, and a Stop mid-track ends it at that frame without writing the JSON', async () => {
        const extract = vi.spyOn(HeadlessVideoEditorService.prototype, 'extractKeyframes');
        const estimate = vi.spyOn(MediaPipePoseService.prototype, 'estimatePoseFromImage');
        const res = await createDefaultToolRegistry().dispatch('vfx_mediapipe_track_video_motion', { videoPath: video('track_stopped.mp4') }, { signal: stopped() } as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toMatch(/stopped/i);
        expect(extract).not.toHaveBeenCalled();
        expect(estimate).not.toHaveBeenCalled();

        const stop = new AbortController();
        const { editor, calls: editorCalls } = fakeEditor(10);
        const { pose, calls } = fakePose(n => { if (n === 2) stop.abort(); });
        const outputJsonPath = path.join(DIR, 'track.json');
        const err = await new MediaPipeVideoDirectorService(editor, pose)
            .trackVideoMotion({ videoPath: video('track_mid.mp4'), fps: 15, outputJsonPath, signal: stop.signal }).catch(e => e);
        expect(err?.name).toBe('AbortError');
        expect(calls.estimate).toBe(2);
        expect(editorCalls.extractSignals[0]).toBe(stop.signal);
        expect(fs.existsSync(outputJsonPath)).toBe(false);
    });

    it('a stopped reframe never encodes; a Stop mid-sampling ends it without writing the output video', async () => {
        const quickEdit = vi.spyOn(HeadlessVideoEditorService.prototype, 'quickEdit');
        const res = await createDefaultToolRegistry().dispatch('vfx_video_auto_reframe', { inputVideoPath: video('reframe_stopped.mp4'), targetAspectRatio: '9:16' }, { signal: stopped() } as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).toMatch(/stopped/i);
        expect(quickEdit).not.toHaveBeenCalled();

        const stop = new AbortController();
        const { editor, calls: editorCalls } = fakeEditor(10);
        const { pose, calls } = fakePose(n => { if (n === 2) stop.abort(); });
        const outputVideoPath = path.join(DIR, 'reframed.mp4');
        const err = await new MediaPipeVideoDirectorService(editor, pose)
            .autoReframeVideo({ inputVideoPath: video('reframe_mid.mp4'), outputVideoPath, targetAspectRatio: '9:16', signal: stop.signal }).catch(e => e);
        expect(err?.name).toBe('AbortError');
        expect(calls.run).toBe(2);
        expect(calls.signals.every(s => s === stop.signal)).toBe(true);
        expect(editorCalls.quickEdit).toHaveLength(0);
        expect(fs.existsSync(outputVideoPath)).toBe(false);
    });

    it('a Stop during the reframe encode removes the partly written video', async () => {
        const stop = new AbortController();
        const { editor } = fakeEditor(2);
        const outputVideoPath = path.join(DIR, 'reframed_partial.mp4');
        let encodeSignal: AbortSignal | undefined;
        editor.quickEdit = async (opts: any) => {
            encodeSignal = opts.signal;
            fs.writeFileSync(opts.outputPath, 'half an mp4');
            stop.abort();
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        };
        const err = await new MediaPipeVideoDirectorService(editor, fakePose().pose)
            .autoReframeVideo({ inputVideoPath: video('reframe_encode.mp4'), outputVideoPath, targetAspectRatio: '1:1', signal: stop.signal }).catch(e => e);
        expect(err?.name).toBe('AbortError');
        expect(encodeSignal).toBe(stop.signal);
        expect(fs.existsSync(outputVideoPath)).toBe(false);
    });
});

describe('the signal ends the real child processes', () => {
    /** A stand-in executable that records its pid and each start, then sleeps. */
    function sleeper(name: string): { bin: string; log: string } {
        const log = path.join(DIR, `${name}.log`);
        const bin = path.join(DIR, `${name}.sh`);
        fs.writeFileSync(bin, `#!/bin/sh\necho $$ >> "${log}"\nexec sleep 30\n`, { mode: 0o755 });
        return { bin, log };
    }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    /** Presses Stop once the stand-in has started (macOS can take a while to launch a just-written executable). */
    async function stopOnceStarted(log: string, stop: AbortController): Promise<number> {
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(log) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        stop.abort();
        return Date.now();
    }

    it('MediaPipe: a Stop kills the Python bridge of the frame in flight and rejects with the abort', async () => {
        const { bin, log } = sleeper('python_bridge');
        const script = path.join(DIR, 'detect_pose.py');
        fs.writeFileSync(script, '# not run: the stand-in interpreter only sleeps');
        const svc = new MediaPipePoseService({ pythonBinary: bin, scriptPath: script, timeoutMs: 60_000 });
        const stop = new AbortController();
        const running = svc.runPoseLandmarker(JPEG, { signal: stop.signal }).catch(e => e);
        const stoppedAt = await stopOnceStarted(log, stop);
        const err = await running;
        expect(err?.name).toBe('AbortError');
        // Ended by the Stop, not by the 30 s sleep or the 60 s bridge timeout.
        expect(Date.now() - stoppedAt).toBeLessThan(5_000);
        const pid = Number(fs.readFileSync(log, 'utf8').trim());
        await new Promise(r => setTimeout(r, 200));
        expect(alive(pid)).toBe(false);
    });

    it('ffmpeg: a Stop ends frame extraction at the frame in flight', async () => {
        const { bin, log } = sleeper('ffmpeg');
        const editor = new HeadlessVideoEditorService(bin, bin);
        const stop = new AbortController();
        const running = editor.extractKeyframes({ inputPath: video('extract.mp4'), outputDir: path.join(DIR, 'frames'), timestampsSec: [0, 1, 2, 3, 4, 5], signal: stop.signal }).catch(e => e);
        const stoppedAt = await stopOnceStarted(log, stop);
        const err = await running;
        expect(err?.name).toBe('AbortError');
        expect(Date.now() - stoppedAt).toBeLessThan(5_000);
        // One ffmpeg was started; none for the five frames after the Stop.
        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    });
});
