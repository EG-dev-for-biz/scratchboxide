/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * vfx_visual_critic_audit is a quality gate: it passes only on scores a vision model gave from the contact sheet, and
 * it fails, with the reason, when the sheet, the motion tracking or the vision model fails. It never passes on
 * constants. The editor, pose detector and vision model are injected fakes (no model is called).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaPipeVideoDirectorService, VISUAL_CRITIC_DIMENSIONS } from '../src/node/video/MediaPipeVideoDirectorService';
import { HeadlessVideoEditorService } from '../src/node/video/HeadlessVideoEditorService';
import { GeneratorFailedError, MissingInputError, VisionUnavailableError } from '../src/common/errors/pipeline-errors';
import { directorHandlers } from '../src/node/gemini/tools/vfx-video-tools';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-visual-critic-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

function video(name: string): string {
    const p = path.join(DIR, name);
    fs.writeFileSync(p, 'not decoded by the fake editor');
    return p;
}

/** A fake editor: writes the sheet (or fails to), and extracts `frames` frame files. */
function fakeEditor(opts: { sheet?: 'ok' | 'throws' | 'empty'; frames?: number; probe?: 'ok' | 'throws' } = {}) {
    const calls = { sheet: 0 };
    const editor: any = {
        generateStoryboardSheet: async ({ outputPath }: { outputPath: string }) => {
            calls.sheet++;
            if (opts.sheet === 'throws') throw Object.assign(new Error('Command failed: ffmpeg'), { stderr: 'not_a_video.mp4: Invalid data found when processing input' });
            fs.writeFileSync(outputPath, opts.sheet === 'empty' ? Buffer.alloc(0) : JPEG);
            return { success: true, outputPath };
        },
        probeMedia: async () => {
            if (opts.probe === 'throws') throw new Error('spawn ffprobe ENOENT');
            return { width: 1280, height: 720, durationSec: (opts.frames ?? 4) / 8 };
        },
        extractKeyframes: async ({ timestampsSec, outputDir }: { timestampsSec: number[]; outputDir: string }) => ({
            outputPaths: timestampsSec.slice(0, opts.frames ?? 4).map((_, i) => { const f = path.join(outputDir, `f${i}.png`); fs.writeFileSync(f, `frame ${i}`); return f; })
        })
    };
    return { editor, calls };
}

/** Landmarks of a person whose arms and legs keep (or, with `stretch`, change) their length frame to frame. */
function personPose(stretch = 0) {
    return {
        estimatePoseFromImage: async ({ image }: { image: Buffer }) => {
            const i = Number(image.toString().replace('frame ', ''));
            const s = 1 + stretch * i;
            const lms = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
            for (const [a, b, c] of [[11, 13, 15], [12, 14, 16], [23, 25, 27], [24, 26, 28]]) {
                lms[a] = { x: 0, y: 0, z: 0, visibility: 0.9 };
                lms[b] = { x: 0, y: -0.3 * s, z: 0, visibility: 0.9 };
                lms[c] = { x: 0, y: -0.6 * s, z: 0, visibility: 0.9 };
            }
            const angles = Object.fromEntries(['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'spine', 'head'].map(k => [k, [0, 0, 0]]));
            return { success: true, personIndex: 0, angles, hipPositionMeters: [0, 0.9, 0], confidence: 0.8, worldLandmarks: lms, imageLandmarks: lms };
        }
    } as any;
}

/** A fake vision model that answers with these scores (and records what it was sent). */
function fakeVision(scores: Partial<Record<keyof typeof VISUAL_CRITIC_DIMENSIONS, number>> | 'throws' | 'incomplete', sent: any[] = []) {
    return {
        models: {
            generateContent: async (req: any) => {
                sent.push(req);
                if (scores === 'throws') throw Object.assign(new Error('PERMISSION_DENIED'), { status: 403 });
                const dims = Object.fromEntries(Object.keys(VISUAL_CRITIC_DIMENSIONS).map(k => [k, { score: (scores as any)[k] ?? 9, notes: `seen: ${k}` }]));
                if (scores === 'incomplete') delete (dims as any).photographicRealism;
                return { text: JSON.stringify({ dimensions: dims, actionDirectives: ['Warm the background plate to match the subject'], suggestedFfmpegFilters: ['colortemperature=temperature=5200'] }) };
            }
        }
    };
}

describe('vfx_visual_critic_audit measures every score and fails when a step fails', () => {
    it('scores come from the vision model; one dimension below the gate fails the audit even when the mean is above it', async () => {
        const sent: any[] = [];
        const { editor } = fakeEditor();
        const svc = new MediaPipeVideoDirectorService(editor, personPose(), { visionClient: fakeVision({ colorTemperature: 6.0, photographicRealism: 9.6 }, sent) });
        const audit = await svc.auditVideoFidelity({ videoPath: video('shot.mp4'), promptContext: 'a dancer on a rooftop at dusk' });

        expect(audit.dimensionAudits.colorTemperature).toEqual({ score: 6.0, passed: false, notes: 'seen: colorTemperature' });
        expect(audit.dimensionAudits.photographicRealism.score).toBe(9.6);
        // Mean (6.0 + 9.6 + 6 x 9) / 8 = 8.7 >= 8.5, but colour temperature fails the rubric.
        expect(audit.overallScore).toBeCloseTo(8.7, 6);
        expect(audit.passed).toBe(false);
        expect(audit.failedDimensions).toEqual(['colorTemperature']);
        expect(audit.remediationRecipe?.actionDirectives).toEqual(['Warm the background plate to match the subject']);
        expect(audit.visionModel).toBe('gemini-2.5-flash');

        // The model saw the sheet, the caller's context and the measured limb steadiness.
        expect(sent).toHaveLength(1);
        expect(sent[0].contents[0].inlineData).toEqual({ mimeType: 'image/jpeg', data: JPEG.toString('base64') });
        const prompt = sent[0].contents[sent[0].contents.length - 1] as string;
        expect(prompt).toContain('a dancer on a rooftop at dusk');
        expect(prompt).toContain('limb-length stability 1');
        expect(audit.anatomicalConsistency).toEqual({ framesSampled: 4, framesWithPerson: 4, limbLengthStabilityRatio: 1 });
        expect(fs.existsSync(audit.storyboardSheetPath)).toBe(true);
    });

    it('limb stability is measured from the landmarks, not assumed', async () => {
        const { editor } = fakeEditor({ frames: 4 });
        // Limbs grow 20% a frame: 1.0, 1.2, 1.4, 1.6 x their length.
        const audit = await new MediaPipeVideoDirectorService(editor, personPose(0.2), { visionClient: fakeVision({}) })
            .auditVideoFidelity({ videoPath: video('stretch.mp4') });
        const lengths = [1, 1.2, 1.4, 1.6];
        const mean = lengths.reduce((a, b) => a + b) / 4;
        const cv = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / 4) / mean;
        expect(audit.anatomicalConsistency.limbLengthStabilityRatio).toBeCloseTo(1 - cv, 2);
        expect(audit.passed).toBe(true);
    });

    it('a contact sheet that cannot be made fails the audit with the reason, before any model is asked', async () => {
        const sent: any[] = [];
        for (const sheet of ['throws', 'empty'] as const) {
            const { editor } = fakeEditor({ sheet });
            const err = await new MediaPipeVideoDirectorService(editor, personPose(), { visionClient: fakeVision({}, sent) })
                .auditVideoFidelity({ videoPath: video(`sheet_${sheet}.mp4`) }).catch(e => e);
            expect(err).toBeInstanceOf(GeneratorFailedError);
            expect(err.message).toMatch(sheet === 'throws' ? /contact sheet .*Invalid data found/ : /contact sheet .* is empty/);
        }
        expect(sent).toHaveLength(0);
    });

    it('motion tracking that cannot run fails the audit with the reason (no 0.92 limb stability)', async () => {
        const sent: any[] = [];
        const { editor } = fakeEditor({ probe: 'throws' });
        const err = await new MediaPipeVideoDirectorService(editor, personPose(), { visionClient: fakeVision({}, sent) })
            .auditVideoFidelity({ videoPath: video('no_probe.mp4') }).catch(e => e);
        expect(err).toBeInstanceOf(GeneratorFailedError);
        expect(err.message).toMatch(/could not track motion .*spawn ffprobe ENOENT/);

        const broken: any = { estimatePoseFromImage: async () => { throw new GeneratorFailedError('mediapipe', 'python3 could not be started'); } };
        const err2 = await new MediaPipeVideoDirectorService(fakeEditor().editor, broken, { visionClient: fakeVision({}, sent) })
            .auditVideoFidelity({ videoPath: video('no_detector.mp4') }).catch(e => e);
        expect(err2).toBeInstanceOf(GeneratorFailedError);
        expect(err2.message).toContain('python3 could not be started');
        expect(sent).toHaveLength(0);
    });

    it('a video with nobody in it reports body consistency as not measured, never as a default ratio', async () => {
        const nobody: any = { estimatePoseFromImage: async () => { throw new MissingInputError('pose detection', 'a visible person', 'MediaPipe found no person in the image'); } };
        const audit = await new MediaPipeVideoDirectorService(fakeEditor({ frames: 3 }).editor, nobody, { visionClient: fakeVision({}) })
            .auditVideoFidelity({ videoPath: video('landscape.mp4') });
        expect(audit.anatomicalConsistency.framesSampled).toBe(3);
        expect(audit.anatomicalConsistency.framesWithPerson).toBe(0);
        expect(audit.anatomicalConsistency.limbLengthStabilityRatio).toBeUndefined();
        expect(audit.anatomicalConsistency.notMeasuredReason).toMatch(/no person/);
    });

    it('a vision model that cannot score (unavailable or an incomplete answer) fails the audit', async () => {
        for (const answer of ['throws', 'incomplete'] as const) {
            const err = await new MediaPipeVideoDirectorService(fakeEditor().editor, personPose(), { visionClient: fakeVision(answer) })
                .auditVideoFidelity({ videoPath: video(`vision_${answer}.mp4`) }).catch(e => e);
            expect(err).toBeInstanceOf(VisionUnavailableError);
            expect(err.message).toMatch(answer === 'throws' ? /403.*PERMISSION_DENIED/ : /photographicRealism/);
        }
    });

    it('the review\'s probe: a text file named .mp4 fails the tool instead of PASSED 8.79', async () => {
        const notAVideo = path.join(DIR, 'not_a_video.mp4');
        fs.writeFileSync(notAVideo, 'this is a text file, not a video');
        // The real editor: ffmpeg either is missing or cannot decode it; both fail the sheet step.
        const err = await new MediaPipeVideoDirectorService(new HeadlessVideoEditorService(), personPose(), { visionClient: fakeVision({}) })
            .auditVideoFidelity({ videoPath: notAVideo }).catch(e => e);
        expect(err).toBeInstanceOf(GeneratorFailedError);
        expect(err.message).toContain('contact sheet');

        const res = await createDefaultToolRegistry().dispatch('vfx_visual_critic_audit', { videoPath: notAVideo }, {} as any);
        expect(res.exec.status).toBe('failed');
        expect(res.exec.summaryResult).not.toMatch(/PASSED/);
        expect((res.resultPayload as any).passed).not.toBe(true);
        expect((res.resultPayload as any).overallScore).toBeUndefined();
    });

    it('dry runs are refused with nothing analysed, for all three director tools', async () => {
        for (const [tool, args] of [
            ['vfx_visual_critic_audit', { videoPath: '/nonexistent/final.mp4' }],
            ['vfx_mediapipe_track_video_motion', { videoPath: '/nonexistent/clip.mp4' }],
            ['vfx_video_auto_reframe', { inputVideoPath: '/nonexistent/portrait.mp4', targetAspectRatio: '9:16' }]
        ] as const) {
            const res = await directorHandlers[tool]({ ...args, dryRun: true }, {} as any);
            expect(res.status).toBe('failed');
            expect(res.summaryResult).toContain('Dry run, nothing analysed');
            expect(Object.keys(res.resultPayload).sort()).toEqual(['dryRun', 'error', 'success']);
            expect(res.resultPayload.success).toBe(false);
        }
    });
});
