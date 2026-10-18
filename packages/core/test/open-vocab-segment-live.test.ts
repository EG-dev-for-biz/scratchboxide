/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Live run of vfx_segment_subject's open-vocabulary path with the chat's real vision model (OPEN_SEGMENT_LIVE=1).
 *
 * - Records the vision model's answers for the synthetic scenes into fixtures/open-vocab-segment/recorded-answers.json,
 *   which open-vocab-segment.test.ts replays with no model call. A request already recorded is replayed here too.
 * - With OPEN_SEGMENT_SV_DIR (recorded Street View views of the Washington Square Arch, named live_<n>.jpg), cuts out the
 *   statues, a tree, a lamp post and a fence, and follows a statue through a short clip made with ffmpeg from one view;
 *   those answers are recorded too (the images themselves are not in the repo).
 *
 * Overlays (with and without GrabCut, and video frames) go to test-results/screenshots/open_vocab_segment/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ObjectSegmenterService, type ObjectSegmentResult } from '../src/node/video/ObjectSegmenterService';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { shutdownAllPythonWorkerPools } from '../src/node/process/persistent-python-worker';
import { replayOrRecordSource } from './fixtures/open-vocab-segment/replay-source';
import type { LocatorModelSource } from '../src/node/video/segment-target-locator';
import {
    DESCRIBED_CASES, NOT_FOUND_CASE, RECORDINGS, SHOTS, VIDEO_FPS, VIDEO_TARGET, loadRecordings, makeClip, makeScenes, maskIou, overlay
} from './fixtures/open-vocab-segment/cases';
import { SegmentTargetNotFoundError } from '../src/common/errors/pipeline-errors';

const LIVE = process.env.OPEN_SEGMENT_LIVE === '1';
const SV = process.env.OPEN_SEGMENT_SV_DIR;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-open-segment-live-'));
const records = loadRecordings();
let currentCase = 'setup';
const stats = { replayed: 0, recorded: 0, used: new Set<string>() };
const source = (): LocatorModelSource => replayOrRecordSource(new GeminiClient() as unknown as LocatorModelSource, records, () => currentCase, stats);
const service = new ObjectSegmenterService({ modelSource: source, frameTimeoutMs: 300_000 });
const lines: string[] = [];

afterAll(async () => {
    if (!LIVE) return;
    // keep only the answers this run asked for (a changed request leaves its old answer unused)
    fs.writeJsonSync(RECORDINGS, records.filter(r => stats.used.has(r.key)), { spaces: 2 });
    fs.ensureDirSync(SHOTS);
    fs.writeFileSync(path.join(SHOTS, 'live_summary.txt'), [...lines, `vision answers: ${stats.recorded} recorded live, ${stats.replayed} replayed`].join('\n') + '\n');
    shutdownAllPythonWorkerPools();
    await fs.remove(WORK);
});

function panels(res: ObjectSegmentResult, title: string, gt?: string) {
    const f = res.frames[0];
    return { mask: f.maskPath, title, positive: f.positiveUsed, negative: f.negativeUsed, ...(res.prompts.box ? { box: res.prompts.box } : {}), ...(gt ? { gt } : {}) };
}

async function both(name: string, image: string, target: string, gt?: string) {
    currentCase = name;
    const raw = await service.segment({ imagePath: image, outputDir: path.join(WORK, `${name}_raw`), target, refine: false });
    const refined = await service.segment({ imagePath: image, outputDir: path.join(WORK, `${name}_gc`), target, refine: true });
    const label = raw.prompts.visionModel?.label ?? '';
    const shot = overlay(path.join(SHOTS, `live_${name}.png`), image, [
        panels(raw, `${name}: segmenter only`, gt), panels(refined, `+ GrabCut  (${raw.prompts.visionModel?.model}: ${label})`.slice(0, 90), gt)
    ]);
    const m = gt ? { raw: maskIou(raw.maskPaths[0], gt).iou, gc: maskIou(refined.maskPaths[0], gt).iou } : undefined;
    lines.push(`${name}: "${target}" -> "${label}" by ${raw.prompts.visionModel?.model} (${raw.prompts.visionModel?.ms} ms, ${raw.prompts.visionModel?.calls} call(s)); area ${(raw.frames[0].areaFraction * 100).toFixed(2)}% / ${(refined.frames[0].areaFraction * 100).toFixed(2)}%; segment ${raw.frames[0].ms} ms / +GrabCut ${refined.frames[0].ms} ms${m ? `; IoU ${m.raw.toFixed(3)} / ${m.gc.toFixed(3)}` : ''}; ${shot}`);
    return { raw, refined, iou: m };
}

describe.skipIf(!LIVE)('open-vocabulary segmentation with the live vision model', () => {
    it('records answers for the synthetic scenes and meets the IoU bar with them', async () => {
        makeScenes(WORK);
        for (const c of DESCRIBED_CASES) {
            const { iou } = await both(`synthetic_${c.name}`, path.join(WORK, c.image), c.target, path.join(WORK, c.gt!));
            expect(iou!.raw).toBeGreaterThan(0.85);
            expect(iou!.gc).toBeGreaterThan(0.85);
        }
        currentCase = NOT_FOUND_CASE.name;
        await expect(service.segment({ imagePath: path.join(WORK, NOT_FOUND_CASE.image), outputDir: path.join(WORK, 'absent'), target: NOT_FOUND_CASE.target }))
            .rejects.toBeInstanceOf(SegmentTargetNotFoundError);
        lines.push(`absent: "${NOT_FOUND_CASE.target}" -> SegmentTargetNotFoundError`);

        currentCase = 'synthetic_video';
        const clip = makeClip(WORK);
        const res = await service.segment({ videoPath: clip, outputDir: path.join(WORK, 'video'), target: VIDEO_TARGET, fps: VIDEO_FPS, recheckEveryFrames: 5 });
        const ious = res.frames.map((f, i) => maskIou(f.maskPath, path.join(WORK, `moving_gt_${String(i).padStart(2, '0')}.png`)).iou);
        lines.push(`synthetic_video: ${res.totalFrames} frames, IoU min ${Math.min(...ious).toFixed(3)} last ${ious[ious.length - 1].toFixed(3)}, rechecks ${JSON.stringify(res.rechecks.map(r => ({ frame: r.frame, iou: r.iouWithPropagated, reason: r.reason })))}, ${res.timingsMs.perFrameMean} ms/frame`);
        expect(Math.min(...ious)).toBeGreaterThan(0.8);
    }, 900_000);

    it.skipIf(!SV)('cuts out the arch statues, a tree, a lamp post and a fence in Street View views, and follows a statue through a clip', async () => {
        const view = (n: number) => path.join(SV!, `live_${n}.jpg`);
        const cases: Array<[string, number, string]> = [
            ['sv18_left_statue', 18, 'the statue on the left pier of the arch'],
            ['sv18_right_statue', 18, 'the statue on the right pier of the arch'],
            ['sv46_statue', 46, 'the statue'],
            ['sv65_statue', 65, 'the statue group on the right pier'],
            ['sv65_lamp', 65, 'the street lamp post in front of the arch'],
            ['sv15_statue', 15, 'the statue (only the parts not hidden by leaves)'],
            ['sv2_tree', 2, 'the leafy tree on the left in front of the buildings'],
            ['sv8_fence', 8, 'the black iron fence along the path']
        ];
        for (const [name, n, target] of cases) {
            if (!fs.existsSync(view(n))) continue;
            const { raw } = await both(name, view(n), target);
            expect(raw.frames[0].areaFraction).toBeGreaterThan(0.001);
        }

        // a short clip: a slow push-in on view 18, following the left statue
        currentCase = 'sv18_clip';
        const clip = path.join(WORK, 'sv18_push.mp4');
        const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-i', view(18), '-vf',
            "scale=1707:1280,zoompan=z='1+0.0045*on':x='iw/2-(iw/zoom/2)-on*1.2':y='ih/2-(ih/zoom/2)':d=24:s=854x640:fps=8", '-frames:v', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const res = await service.segment({ videoPath: clip, outputDir: path.join(WORK, 'sv18_clip'), target: 'the statue on the left pier of the arch', fps: 8, recheckEveryFrames: 8 });
        const sheet = [0, Math.floor(res.totalFrames / 2), res.totalFrames - 1].map(i => res.frames[i]);
        const frameDir = path.join(WORK, 'sv18_clip_frames');
        fs.ensureDirSync(frameDir);
        spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-vf', 'fps=8', path.join(frameDir, 'f_%04d.png')]);
        for (const f of sheet) {
            overlay(path.join(SHOTS, `live_sv18_clip_frame${String(f.frame).padStart(2, '0')}.png`), path.join(frameDir, `f_${String(f.frame).padStart(4, '0')}.png`),
                [{ mask: f.maskPath, title: `frame ${f.frame}: ${f.promptSource}`, positive: f.positiveUsed, negative: f.negativeUsed }]);
        }
        lines.push(`sv18_clip: ${res.totalFrames} frames, area ${res.frames.map(f => (f.areaFraction * 100).toFixed(2)).join(' ')}, rechecks ${JSON.stringify(res.rechecks.map(c => ({ frame: c.frame, iou: c.iouWithPropagated, reason: c.reason })))}, unrechecked jumps ${JSON.stringify(res.unrecheckedJumps)}, ${res.timingsMs.perFrameMean} ms/frame, vision ${res.timingsMs.vision} ms`);
        expect(res.totalFrames).toBe(24);
    }, 1_800_000);
});
