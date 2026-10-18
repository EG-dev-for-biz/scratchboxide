/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * vfx_segment_subject's open-vocabulary path, with the real MediaPipe Interactive Segmenter and OpenCV on synthetic
 * scenes whose true masks are known (fixtures/open-vocab-segment/make_synthetic.py):
 *
 * - described targets, prompted by the live vision model's recorded answers (replayed; no model call), meet an IoU bar
 *   with and without GrabCut, and a neighbour that touches the target is left out;
 * - points alone (no model) cut out one of two touching objects;
 * - a moving object is followed through a video without drift, by points alone and with recorded re-checks;
 * - a target that is not in the image, an answer that cannot be used, and missing or malformed inputs are typed errors;
 * - nothing in the code paths branches on what the target is (ADA).
 *
 * Overlays go to test-results/screenshots/open_vocab_segment/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ObjectSegmenterService } from '../src/node/video/ObjectSegmenterService';
import { checkLocatorAnswer, segmentLocatorPrompt } from '../src/node/video/segment-target-locator';
import { SEGMENTATION_TOOL_DECLARATIONS, segmentationHandlers } from '../src/node/gemini/tools/vfx-video-tools';
import { GeneratorFailedError, InvalidInputError, MissingInputError, SegmentTargetNotFoundError } from '../src/common/errors/pipeline-errors';
import { shutdownAllPythonWorkerPools } from '../src/node/process/persistent-python-worker';
import { replaySource, scriptedSource } from './fixtures/open-vocab-segment/replay-source';
import {
    DESCRIBED_CASES, NOT_FOUND_CASE, PYTHON, SHOTS, VIDEO_FPS, VIDEO_FRAMES, VIDEO_TARGET, loadRecordings, makeClip, makeScenes, maskIou, overlay
} from './fixtures/open-vocab-segment/cases';

const probe = spawnSync(PYTHON, ['-c', 'import cv2, mediapipe'], { encoding: 'utf8' });
const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8' });
const READY = probe.status === 0 && ffmpeg.status === 0;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-open-segment-'));
const records = loadRecordings();
const replayed: string[] = [];
const replay = new ObjectSegmenterService({ modelSource: () => replaySource(records, replayed), pythonBinary: PYTHON });
const noModel = new ObjectSegmenterService({
    modelSource: () => { throw new Error('no model may be asked in this test'); },
    pythonBinary: PYTHON
});
const at = (f: string) => path.join(WORK, f);
let clip = '';

beforeAll(() => {
    if (!READY) return;
    makeScenes(WORK);
    clip = makeClip(WORK);
});

afterAll(async () => {
    shutdownAllPythonWorkerPools();
    await fs.remove(WORK);
});

describe.skipIf(!READY)('open-vocabulary object masks (real MediaPipe Interactive Segmenter + OpenCV)', () => {
    for (const c of DESCRIBED_CASES) {
        it(`cuts out ${JSON.stringify(c.target)} from the vision model's recorded prompts, with and without GrabCut`, async () => {
            const raw = await replay.segment({ imagePath: at(c.image), outputDir: at(`${c.name}_raw`), target: c.target, refine: false });
            const gc = await replay.segment({ imagePath: at(c.image), outputDir: at(`${c.name}_gc`), target: c.target, refine: true });
            const iouRaw = maskIou(raw.maskPaths[0], at(c.gt!)).iou;
            const iouGc = maskIou(gc.maskPaths[0], at(c.gt!)).iou;
            overlay(path.join(SHOTS, `synthetic_${c.name}_before_after_grabcut.png`), at(c.image), [
                { mask: raw.maskPaths[0], title: `segmenter only IoU ${iouRaw.toFixed(3)}`, positive: raw.frames[0].positiveUsed, negative: raw.frames[0].negativeUsed, box: raw.prompts.box, gt: at(c.gt!) },
                { mask: gc.maskPaths[0], title: `+ GrabCut IoU ${iouGc.toFixed(3)}`, positive: gc.frames[0].positiveUsed, negative: gc.frames[0].negativeUsed, box: gc.prompts.box, gt: at(c.gt!) }
            ]);
            expect(iouRaw).toBeGreaterThan(0.9);
            expect(iouGc).toBeGreaterThan(0.9);
            if (c.avoid) expect(maskIou(gc.maskPaths[0], at(c.avoid)).covered).toBeLessThan(0.03);
            // provenance: the prompts came from the vision model, named; the refinement and the segmenter are named
            expect(raw.prompts.source).toBe('vision-model');
            expect(raw.prompts.visionModel?.model).toBe(records[0].model);
            expect(raw.frames[0].refinement).toBe('none');
            expect(gc.frames[0].refinement).toBe('grabcut');
            expect(gc.models.some(m => m.includes('magic_touch.tflite'))).toBe(true);
            // a soft matte with intermediate values at the edge, the size of the image
            const matte = spawnSync(PYTHON, ['-I', '-c', 'import sys,cv2,numpy as n;m=cv2.imread(sys.argv[1],0);print(m.shape[1],m.shape[0],int(((m>0)&(m<255)).sum()))', gc.mattePaths[0]], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number);
            expect(matte.slice(0, 2)).toEqual([gc.width, gc.height]);
            expect(matte[2]).toBeGreaterThan(50);
            expect(fs.readJsonSync(gc.reportPath).frames[0].maskPath).toBe(gc.maskPaths[0]);
        }, 120_000);
    }

    it('cuts out one of two touching objects from a positive and a negative point, with no model asked', async () => {
        const positivePoints: Array<[number, number]> = [[200 / 560, 250 / 420], [200 / 560, 150 / 420]];
        const negativePoints: Array<[number, number]> = [[350 / 560, 260 / 420]];
        for (const refine of [false, true]) {
            const res = await noModel.segment({ imagePath: at('touching.png'), outputDir: at(`points_${refine}`), positivePoints, negativePoints, refine });
            const { iou } = maskIou(res.maskPaths[0], at('touching_gt_urn.png'));
            const crate = maskIou(res.maskPaths[0], at('touching_gt_crate.png')).covered;
            overlay(path.join(SHOTS, `points_touching_${refine ? 'grabcut' : 'raw'}.png`), at('touching.png'),
                [{ mask: res.maskPaths[0], title: `points only${refine ? ' + GrabCut' : ''}: IoU ${iou.toFixed(3)}, crate ${(crate * 100).toFixed(1)}%`, positive: res.frames[0].positiveUsed, negative: res.frames[0].negativeUsed, gt: at('touching_gt_urn.png') }]);
            expect(iou).toBeGreaterThan(0.9);
            expect(crate).toBeLessThan(0.03);
            expect(res.prompts.source).toBe('user');
            expect(res.prompts.visionModel).toBeUndefined();
        }
    }, 120_000);

    it('follows a moving object through a video from points, without drift', async () => {
        // points on frame 1's object (its body and its top), nothing else
        const res = await noModel.segment({ videoPath: clip, outputDir: at('video_points'), positivePoints: [[110 / 480, 190 / 320], [100 / 480, 150 / 320]], fps: VIDEO_FPS });
        expect(res.totalFrames).toBe(VIDEO_FRAMES);
        const ious = res.frames.map((f, i) => maskIou(f.maskPath, at(`moving_gt_${String(i).padStart(2, '0')}.png`)).iou);
        for (const i of [0, 7, 15]) {
            overlay(path.join(SHOTS, `video_points_frame${String(i + 1).padStart(2, '0')}.png`), at(`moving_${String(i).padStart(2, '0')}.png`),
                [{ mask: res.frames[i].maskPath, title: `frame ${i + 1} (${res.frames[i].promptSource}) IoU ${ious[i].toFixed(3)}`, positive: res.frames[i].positiveUsed, negative: res.frames[i].negativeUsed, gt: at(`moving_gt_${String(i).padStart(2, '0')}.png`) }]);
        }
        expect(Math.min(...ious)).toBeGreaterThan(0.9);
        expect(ious[ious.length - 1]).toBeGreaterThan(ious[0] - 0.05); // no drift
        expect(res.frames.slice(1).every(f => f.promptSource === 'propagation')).toBe(true);
        expect(res.rechecks).toEqual([]);
        expect(res.unrecheckedJumps).toEqual([]);
        expect(res.mattePaths).toHaveLength(VIDEO_FRAMES);
    }, 300_000);

    it('follows a described object through a video, re-checking with the vision model every 5 frames and reporting each re-check', async () => {
        const res = await replay.segment({ videoPath: clip, outputDir: at('video_target'), target: VIDEO_TARGET, fps: VIDEO_FPS, recheckEveryFrames: 5 });
        const ious = res.frames.map((f, i) => maskIou(f.maskPath, at(`moving_gt_${String(i).padStart(2, '0')}.png`)).iou);
        expect(Math.min(...ious)).toBeGreaterThan(0.9);
        expect(res.rechecks.map(r => r.frame)).toEqual([6, 11, 16]);
        for (const r of res.rechecks) {
            expect(r.reason).toMatch(/every 5 frames/);
            expect(r.model).toBe(res.prompts.visionModel?.model);
            expect(r.iouWithPropagated).toBeGreaterThan(0.9); // propagation had not drifted from what the model re-anchored
            expect(res.frames[r.frame - 1].promptSource).toBe('vision-model');
        }
    }, 300_000);

    it('fails with SegmentTargetNotFoundError when the described object is not in the image, writing nothing', async () => {
        const out = at('absent');
        await expect(replay.segment({ imagePath: at(NOT_FOUND_CASE.image), outputDir: out, target: NOT_FOUND_CASE.target }))
            .rejects.toBeInstanceOf(SegmentTargetNotFoundError);
        expect(fs.existsSync(out) ? fs.readdirSync(out).filter(f => f.endsWith('.png')) : []).toEqual([]);
    }, 60_000);

    it('fails with SegmentTargetNotFoundError when no positive point gives a mask, rather than cutting out something else', async () => {
        // the only positive point lies outside the box the user drew, so it is dropped and nothing is left to segment
        await expect(noModel.segment({ imagePath: at('touching.png'), outputDir: at('cancelled'), positivePoints: [[0.9, 0.9]], box: [0.0, 0.0, 0.2, 0.2] }))
            .rejects.toBeInstanceOf(SegmentTargetNotFoundError);
    }, 60_000);

    it('asks once more when an answer fails its checks, and fails typed when the second does too', async () => {
        const good = JSON.stringify({ found: true, label: 'x', box_2d: [250, 300, 950, 650], positive: [[600, 500], [350, 500]], negative: [] });
        const calls: any[] = [];
        const ok = new ObjectSegmenterService({ modelSource: scriptedSource(['{"found": true, "box_2d": [900, 0, 100, 10], "positive": []}', good], 'scripted-model', calls), pythonBinary: PYTHON });
        const res = await ok.segment({ imagePath: at('statue.png'), outputDir: at('retry'), target: 'whatever the user called it' });
        expect(res.prompts.visionModel?.calls).toBe(2);
        expect(calls).toHaveLength(2);
        const lastTurn = calls[1].contents[calls[1].contents.length - 1].parts[0].text as string;
        expect(lastTurn).toMatch(/not ordered/);
        expect(lastTurn).toMatch(/positive needs at least 1 point/);

        const bad = new ObjectSegmenterService({ modelSource: scriptedSource(['not json', '{"found": true}']), pythonBinary: PYTHON });
        await expect(bad.segment({ imagePath: at('statue.png'), outputDir: at('bad'), target: 'anything' })).rejects.toBeInstanceOf(GeneratorFailedError);
    }, 60_000);
});

describe('open-vocabulary segmentation: inputs, answers and ADA', () => {
    const svc = new ObjectSegmenterService({ modelSource: scriptedSource(['{}']), pythonBinary: PYTHON });

    it('says what is missing or malformed with typed errors', async () => {
        const img = path.join(WORK, 'exists.png');
        fs.writeFileSync(img, 'x');
        await expect(svc.segment({ imagePath: img, outputDir: path.join(WORK, 'o') })).rejects.toBeInstanceOf(MissingInputError);
        await expect(svc.segment({ outputDir: path.join(WORK, 'o'), target: 't' })).rejects.toBeInstanceOf(MissingInputError);
        await expect(svc.segment({ imagePath: path.join(WORK, 'nope.png'), outputDir: path.join(WORK, 'o'), target: 't' })).rejects.toBeInstanceOf(MissingInputError);
        await expect(svc.segment({ imagePath: img, outputDir: path.join(WORK, 'o'), positivePoints: [[1.5, 0.2]] })).rejects.toBeInstanceOf(InvalidInputError);
        await expect(svc.segment({ imagePath: img, outputDir: path.join(WORK, 'o'), box: [0.6, 0.1, 0.2, 0.9] })).rejects.toBeInstanceOf(InvalidInputError);
        await expect(segmentationHandlers.vfx_segment_subject({ imagePath: img, outputDir: path.join(WORK, 'o'), target: 't', selfieSegmenter: true }, {} as any)).rejects.toBeInstanceOf(InvalidInputError);
        await expect(segmentationHandlers.vfx_segment_subject({ imagePath: img, outputDir: path.join(WORK, 'o') }, {} as any)).rejects.toBeInstanceOf(MissingInputError);
    });

    it('checks the vision answer: Gemini [y, x] 0..1000 in, normalised [x, y] out; found:false and broken answers are told apart', () => {
        const ok = checkLocatorAnswer('```json\n{"found": true, "label": "a", "box_2d": [100, 200, 500, 600], "positive": [[300, 400]], "negative": [[50, 700]]}\n```');
        expect(ok).toEqual({ kind: 'found', label: 'a', prompts: { box: [0.2, 0.1, 0.6, 0.5], positive: [[0.4, 0.3]], negative: [[0.7, 0.05]] } });
        expect(checkLocatorAnswer('{"found": false, "reason": "none here"}')).toEqual({ kind: 'not-found', reason: 'none here' });
        const bad = checkLocatorAnswer('{"found": true, "box_2d": [100, 200, 500, 600], "positive": [[900, 900]], "negative": [[1, 2, 3]]}');
        expect(bad.kind).toBe('invalid');
        expect((bad as { problems: string[] }).problems.join(' ')).toMatch(/outside box_2d.*|negative\[0\] is not/);
    });

    it('passes the description to the model as written and never branches on it (no class lists in the code paths)', () => {
        const alien = 'the bioluminescent mycelium spire venting methane, left of the geyser';
        expect(segmentLocatorPrompt(alien)).toContain(JSON.stringify(alien));
        const root = path.resolve(__dirname, '../../..');
        const sources = [
            'packages/core/src/node/video/ObjectSegmenterService.ts',
            'packages/core/src/node/video/segment-target-locator.ts',
            'scripts/segment_object.py'
        ].map(f => fs.readFileSync(path.join(root, f), 'utf8'));
        for (const src of sources) {
            // the target text is only ever passed on: no comparison, matching or regex test of it
            expect(src).not.toMatch(/target\s*(===|!==|==)\s*['"]/);
            expect(src).not.toMatch(/target\??\.(includes|match|startsWith|endsWith|search|toLowerCase)\(/);
            expect(src).not.toMatch(/\.test\(\s*(options\.)?target/);
            expect(src).not.toMatch(/\b(person|car|tree|statue|fence|dog|cat|building)s?\b['"]\s*[:,|]/i); // no class-name lists
        }
        const decl = SEGMENTATION_TOOL_DECLARATIONS.find(d => d.name === 'vfx_segment_subject')!;
        expect(Object.keys(decl.parameters.properties!)).toEqual(expect.arrayContaining(['target', 'positivePoints', 'negativePoints', 'box', 'imagePath', 'videoPath', 'refine', 'recheckEveryFrames', 'selfieSegmenter']));
        expect(decl.description).toMatch(/open vocabulary/);
        expect(decl.parameters.properties!.target.enum).toBeUndefined();
    });
});
