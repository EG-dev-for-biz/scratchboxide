/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The pose tools on the repo's MediaPipe model (assets/models/pose_landmarker_full.task) and the repo .venv, on the
 * repo's performer hero frame and a short clip ffmpeg pans across it: pose detection, video motion tracking, the 9:16
 * auto-reframe and the video-to-4D performer pipeline. No network, no billed calls. The reframed frame is written to
 * test-results/screenshots/ for inspection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { poseDepthHandlers } from '../src/node/gemini/tools/spatial-tools';
import { directorHandlers } from '../src/node/gemini/tools/vfx-video-tools';
import { VideoTo4DPerformerPipelineService } from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { shutdownAllPythonWorkerPools } from '../src/node/process/persistent-python-worker';
import { HOW_TO, REPO_ROOT, requireBinary, requireFile, requirePythonModules, withReason } from './helpers/requirements';

const HERO = path.join(REPO_ROOT, 'public/camera_demo_assets/person_hero_frame0.png');
const MODEL = path.join(REPO_ROOT, 'assets/models/pose_landmarker_full.task');
const SHOTS = path.join(REPO_ROOT, 'test-results/screenshots');
const reqs = [
    requirePythonModules(path.join(REPO_ROOT, '.venv/bin/python'), ['mediapipe', 'cv2']),
    requireFile(MODEL),
    requireFile(HERO),
    requireBinary('ffmpeg', HOW_TO.ffmpeg)
];
const unmet = reqs.find(r => !r.ok) ?? reqs[0];
const ready = reqs.every(r => r.ok);

describe.skipIf(!ready)(withReason('Pose tools on the MediaPipe model and a real clip', unmet), () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pose-real-'));
    const clip = path.join(work, 'hero_pan.mp4');
    const ctx = { workspaceRoot: REPO_ROOT } as any;
    const cwd = process.cwd();

    beforeAll(() => {
        process.chdir(REPO_ROOT);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', HERO, '-t', '2', '-r', '12',
            '-vf', "scale=1376:768,crop=960:720:x='(iw-960)*t/2':y=24,format=yuv420p", '-c:v', 'libx264', '-crf', '26', clip]);
    });
    afterAll(async () => {
        shutdownAllPythonWorkerPools();
        process.chdir(cwd);
        await fs.remove(work);
    });

    it('mediapipe_detect_pose finds the performer with 33 landmarks', async () => {
        const res = await poseDepthHandlers.mediapipe_detect_pose({ imagePath: HERO }, ctx);
        const payload = res.resultPayload as any;
        expect(payload.success).toBe(true);
        expect(payload.confidence).toBeGreaterThan(0.6);
        expect(res.summaryResult).toMatch(/Detected human pose/);
    }, 120_000);

    it('vfx_mediapipe_track_video_motion tracks the performer through every sampled frame', async () => {
        const res = await directorHandlers.vfx_mediapipe_track_video_motion({ videoPath: clip, fps: 6, outputJsonPath: path.join(work, 'motion.json') }, ctx);
        const payload = res.resultPayload as any;
        expect(payload.totalFramesAnalyzed).toBeGreaterThanOrEqual(10);
        expect(payload.averageConfidence).toBeGreaterThan(0.6);
        expect(fs.existsSync(path.join(work, 'motion.json'))).toBe(true);
    }, 180_000);

    it('vfx_video_auto_reframe writes a 9:16 clip framed on the tracked person', async () => {
        const out = path.join(work, 'reframed.mp4');
        const res = await directorHandlers.vfx_video_auto_reframe({ inputVideoPath: clip, targetAspectRatio: '9:16', outputVideoPath: out }, ctx);
        expect(res.summaryResult).toMatch(/framed on the person MediaPipe tracked/);
        const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim();
        const [w, h] = probe.split(',').map(Number);
        expect(Math.abs(w / h - 9 / 16)).toBeLessThan(0.02);
        await fs.ensureDir(SHOTS);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', out, '-frames:v', '1', path.join(SHOTS, 'pose_tools_real_auto_reframe_9x16.png')]);
    }, 180_000);

    it('the video-to-4D performer pipeline tracks the clip and writes splats, motion and a Nerfstudio dataset', async () => {
        const outDir = path.join(work, 'performer');
        const res: any = await new VideoTo4DPerformerPipelineService().executePipeline({ videoPath: clip, characterId: 'hero_pan', outputDir: outDir, numGaussians: 4000 } as any);
        expect(res.success).toBe(true);
        expect(res.landmarksDetected).toBe(33);
        expect(res.numFrames).toBeGreaterThanOrEqual(10);
        for (const p of [res.plyPath, res.motionPath, res.nerfstudioTransformsPath]) expect(fs.existsSync(p)).toBe(true);
        const motion = await fs.readJson(res.motionPath);
        expect(JSON.stringify(motion).length).toBeGreaterThan(1000);
    }, 300_000);
});
