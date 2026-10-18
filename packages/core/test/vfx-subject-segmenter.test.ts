/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * vfx_segment_subject returns a complete matte sequence or fails: a frame the segmenter cannot do fails the call
 * (naming the frame and the segmenter's error) and leaves no partial, gapped sequence behind; the segmentation script
 * never substitutes a GrabCut guess or a centre rectangle for a MediaPipe mask; and the model that made the masks is
 * named. ffprobe, ffmpeg and the segmenter are small test executables here (no video tools or models are needed); the
 * last test runs the real script with the project's Python when it has OpenCV but not MediaPipe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { VfxSubjectSegmenterService } from '../src/node/video/VfxSubjectSegmenterService';
import { SEGMENTATION_TOOL_DECLARATIONS } from '../src/node/gemini/tools/vfx-video-tools';
import { GeneratorFailedError, MissingInputError } from '../src/common/errors/pipeline-errors';
import { encodePng } from '../src/node/texture-processing';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-segment-subject-'));
const BIN = path.join(WORK, 'bin');
const FRAME_PNG = path.join(WORK, 'frame.png');
const VIDEO = path.join(WORK, 'clip.mp4');
const FAKE_SEGMENTER = path.join(WORK, 'fake_segmenter.py');
const ENV_KEYS = ['PATH', 'FFMPEG_PATH', 'FFPROBE_PATH', 'FAKE_FRAME_PNG', 'FAKE_FAIL_FRAME', 'FAKE_MODEL_NOTE'];
let savedEnv: Record<string, string | undefined>;

function writeExecutable(file: string, source: string): string {
    fs.outputFileSync(file, `#!${process.execPath}\n${source}`);
    fs.chmodSync(file, 0o755);
    return file;
}

beforeAll(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    const rgba = Buffer.alloc(16 * 12 * 4, 200);
    fs.writeFileSync(FRAME_PNG, encodePng(16, 12, rgba));
    fs.writeFileSync(VIDEO, 'not decoded by the test executables');
    // ffprobe: a 1 s, 64x48 clip, answered in whichever output format was asked for.
    writeExecutable(path.join(BIN, 'ffprobe'), `
const args = process.argv.slice(2);
if (args.some(a => a === 'json' || a.startsWith('json'))) {
    process.stdout.write(JSON.stringify({ streams: [{ width: 64, height: 48, duration: '1.000000' }], format: { duration: '1.000000' } }));
} else {
    process.stdout.write('64,48,1.000000\\n');
}`);
    // ffmpeg: writes five frames to the output pattern, numbered from 1 as the image2 muxer does.
    writeExecutable(path.join(BIN, 'ffmpeg'), `
const fs = require('fs');
const pattern = process.argv[process.argv.length - 1];
for (let i = 1; i <= 5; i++) fs.copyFileSync(process.env.FAKE_FRAME_PNG, pattern.replace('%04d', String(i).padStart(4, '0')));`);
    // Segmenter: copies the frame as its mask, or fails on the frame named in FAKE_FAIL_FRAME.
    // It runs in a persistent worker (worker_host.py calls its main() once per frame), so it is Python.
    fs.writeFileSync(FAKE_SEGMENTER, `
import json, os, shutil, sys
def main():
    inp, out = sys.argv[1], sys.argv[2]
    if os.environ.get("FAKE_FAIL_FRAME") and os.path.basename(inp) == os.environ["FAKE_FAIL_FRAME"]:
        print(json.dumps({"success": False, "error": "segmenter crashed on this frame"}))
        sys.exit(4)
    shutil.copyfile(inp, out)
    answer = {"success": True, "inputPath": inp, "outputPath": out, "width": 16, "height": 12, "model": "fake-selfie-segmenter"}
    if os.environ.get("FAKE_MODEL_NOTE"):
        answer["modelNote"] = os.environ["FAKE_MODEL_NOTE"]
    print(json.dumps(answer))
`);
    process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.FFMPEG_PATH = path.join(BIN, 'ffmpeg');
    process.env.FFPROBE_PATH = path.join(BIN, 'ffprobe');
    process.env.FAKE_FRAME_PNG = FRAME_PNG;
});

afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.removeSync(WORK);
});

const service = () => new VfxSubjectSegmenterService({ pythonBinary: process.env.SCRATCHBOX_PYTHON || 'python3', scriptPath: FAKE_SEGMENTER, maxWorkers: 3 });
const masksIn = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^mask_\d{4}\.png$/.test(f)).sort() : [];

describe('vfx_segment_subject: a complete matte sequence, or a failure that says which frame', () => {
    it('fails naming the frame the segmenter could not do, and leaves no gapped sequence behind', async () => {
        const outputDir = path.join(WORK, 'out_fail');
        process.env.FAKE_FAIL_FRAME = 'frame_0003.png';
        try {
            const run = service().segmentSubject({ videoPath: VIDEO, outputDir, fps: 5 });
            await expect(run).rejects.toBeInstanceOf(GeneratorFailedError);
            await expect(run).rejects.toThrow(/frame 3 of 5.*segmenter crashed on this frame/);
        } finally {
            delete process.env.FAKE_FAIL_FRAME;
        }
        expect(masksIn(outputDir)).toEqual([]);
        expect(fs.existsSync(path.join(outputDir, '.raw_frames'))).toBe(false);
    });

    it('writes one mask per frame, numbered without gaps, and names the model that made them', async () => {
        const outputDir = path.join(WORK, 'out_ok');
        process.env.FAKE_MODEL_NOTE = 'The MediaPipe Tasks selfie segmenter was not used: no model file';
        let result;
        try {
            result = await service().segmentSubject({ videoPath: VIDEO, outputDir, fps: 5 });
        } finally {
            delete process.env.FAKE_MODEL_NOTE;
        }
        expect(result.success).toBe(true);
        expect(result.totalFrames).toBe(5);
        expect(result.maskPaths.map(p => path.basename(p))).toEqual(['mask_0000.png', 'mask_0001.png', 'mask_0002.png', 'mask_0003.png', 'mask_0004.png']);
        expect(masksIn(outputDir)).toHaveLength(5);
        expect(result.models).toEqual(['fake-selfie-segmenter']);
        expect(result.modelNotes).toEqual(['The MediaPipe Tasks selfie segmenter was not used: no model file']);
        expect([result.width, result.height]).toEqual([64, 48]);
    });

    it('fails with a typed error for a video that does not exist', async () => {
        await expect(service().segmentSubject({ videoPath: path.join(WORK, 'missing.mp4'), outputDir: path.join(WORK, 'out_missing') }))
            .rejects.toBeInstanceOf(MissingInputError);
    });

    it('declares no parameter that does nothing', () => {
        const decl = SEGMENTATION_TOOL_DECLARATIONS.find(d => d.name === 'vfx_segment_subject')!;
        expect(Object.keys(decl.parameters.properties)).not.toContain('subjectHint');
        expect(decl.description).not.toMatch(/future/i);
    });

    // The real script, with the project's Python: OpenCV present and MediaPipe absent is exactly the case where the
    // old script painted a GrabCut guess (or a centre rectangle) and reported success.
    const python = process.env.SCRATCHBOX_PYTHON || 'python3';
    const probe = spawnSync(python, ['-c', 'import cv2\ntry:\n    import mediapipe\n    print("has-mediapipe")\nexcept ImportError:\n    print("no-mediapipe")'], { encoding: 'utf8' });
    const cvWithoutMediaPipe = probe.status === 0 && probe.stdout.trim() === 'no-mediapipe';
    it.skipIf(!cvWithoutMediaPipe)('the segmentation script fails without MediaPipe instead of writing a GrabCut or rectangle mask', () => {
        const out = path.join(WORK, 'script_mask.png');
        const script = path.resolve(__dirname, '../../../scripts/segment_subject.py');
        const res = spawnSync(python, [script, FRAME_PNG, out], { encoding: 'utf8', cwd: WORK });
        expect(res.status).not.toBe(0);
        const answer = JSON.parse(res.stdout.trim().split('\n').pop()!);
        expect(answer.success).toBe(false);
        expect(answer.error).toMatch(/mediapipe/i);
        expect(fs.existsSync(out)).toBe(false);
    });
});
