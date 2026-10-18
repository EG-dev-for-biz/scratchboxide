/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The batched ffmpeg paths against the real ffmpeg (skipped when it is not installed): one ffprobe for the probe,
 * one ffmpeg per 24 keyframes (the same frames, byte for byte, as one ffmpeg per frame), the storyboard sheet from
 * seeks, the faster VP9 flags, and the H.264 encoder chosen by the capability check. A stand-in ffmpeg counts the
 * processes started. The storyboard sheet is saved to test-results/screenshots for inspection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeadlessVideoEditorService, resolveBinary } from '../src/node/video/HeadlessVideoEditorService';
import { HeadlessVideoCompositorService } from '../src/node/video/HeadlessVideoCompositorService';
import { getFfmpegCapabilities, VP9_SPEED_ARGS } from '../src/node/video/ffmpeg-capabilities';
import { decodePng } from '../src/node/texture-processing';

const FFMPEG = resolveBinary('ffmpeg');
const FFPROBE = resolveBinary('ffprobe');
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0 && spawnSync(FFPROBE, ['-version']).status === 0;
const SCREENSHOTS = path.resolve(__dirname, '../../../test-results/screenshots');
let DIR = '';
let VIDEO = '';

describe('ffmpeg process counts (stand-in ffmpeg)', () => {
    it('extracts 50 keyframes with 3 ffmpeg processes (24 per batch), each frame its own seek', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-ffcount-'));
        try {
            const logDir = path.join(dir, 'calls');
            fs.mkdirSync(logDir);
            const bin = path.join(dir, 'ffmpeg');
            // Records its argv (one file per process), then writes every output named after a -frames:v 1 -q:v 2.
            fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${logDir}/$$"\nprev=""\nfor a in "$@"; do\n  case "$prev" in 2) [ "$pp" = "-q:v" ] && : > "$a";; esac\n  pp="$prev"; prev="$a"\ndone\n`, { mode: 0o755 });
            const input = path.join(dir, 'in.mp4');
            fs.writeFileSync(input, 'x');
            const editor = new HeadlessVideoEditorService(bin, bin);
            const ts = Array.from({ length: 50 }, (_, i) => i * 0.1);
            const res = await editor.extractKeyframes({ inputPath: input, outputDir: path.join(dir, 'out'), timestampsSec: ts });
            const calls = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8'));
            expect(calls).toHaveLength(3);
            expect(calls.map(c => (c.match(/-ss /g) || []).length).sort((a, b) => a - b)).toEqual([2, 24, 24]);
            expect(res.outputPaths).toHaveLength(50);
            expect(res.outputPaths.every(p => fs.existsSync(p))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails, naming the timestamp, when ffmpeg writes no frame for one of them', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-ffmissing-'));
        try {
            const bin = path.join(dir, 'ffmpeg');
            fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            const input = path.join(dir, 'in.mp4');
            fs.writeFileSync(input, 'x');
            const editor = new HeadlessVideoEditorService(bin, bin);
            await expect(editor.extractKeyframes({ inputPath: input, outputDir: path.join(dir, 'out'), timestampsSec: [0, 9] }))
                .rejects.toThrow(/wrote no frame for 2 of 2 timestamp\(s\) \(first: 0 s/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(!hasFfmpeg)('batched ffmpeg operations on a real video', () => {
    const editor = new HeadlessVideoEditorService(FFMPEG, FFPROBE);

    beforeAll(() => {
        DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-ffbatch-'));
        VIDEO = path.join(DIR, 'clip.mp4');
        // 6 s, 320x180 at 25 fps with a stereo tone: a moving test pattern, so every frame differs.
        execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
    });
    afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

    it('probes duration, size, frame rate and audio in one ffprobe call', async () => {
        const meta = await editor.probeMedia(VIDEO);
        expect([meta.width, meta.height, meta.fps, meta.hasAudio]).toEqual([320, 180, 25, true]);
        expect(meta.durationSec).toBeGreaterThan(5.9);
        expect(meta.durationSec).toBeLessThan(6.2);
        const audioOnly = path.join(DIR, 'tone.m4a');
        execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:a', 'aac', audioOnly]);
        await expect(editor.probeMedia(audioOnly)).rejects.toThrow(/no video stream/);
    });

    it('a batched extraction writes the same frames, byte for byte, as one ffmpeg per timestamp', async () => {
        const ts = [0, 0.52, 1.0, 2.36, 3.04, 4.5, 5.9];
        const res = await editor.extractKeyframes({ inputPath: VIDEO, outputDir: path.join(DIR, 'batched'), timestampsSec: ts, format: 'png' });
        expect(res.commands).toHaveLength(1);
        for (let i = 0; i < ts.length; i++) {
            const single = path.join(DIR, `single_${i}.png`);
            execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(ts[i]), '-i', VIDEO, '-frames:v', '1', '-q:v', '2', single]);
            expect(fs.readFileSync(res.outputPaths[i]).equals(fs.readFileSync(single))).toBe(true);
        }
        // Frames at different times differ (the seeks are real).
        expect(fs.readFileSync(res.outputPaths[0]).equals(fs.readFileSync(res.outputPaths[1]))).toBe(false);
    });

    it('builds the storyboard sheet from seeks: a 3x3 grid of 160x90 cells', async () => {
        const out = path.join(DIR, 'sheet.png');
        const res = await editor.generateStoryboardSheet({ inputPath: VIDEO, outputPath: out, columns: 3, rows: 3, cellWidth: 160, cellHeight: 90, padding: 4, margin: 4 });
        expect(res.commandString.match(/-ss /g)).toHaveLength(9);
        expect(res.cellTimesSec).toEqual([0, 0.667, 1.333, 2, 2.667, 3.333, 4, 4.667, 5.333]);
        // Timecodes when this ffmpeg has drawtext; otherwise the sheet says it has none.
        const caps = await getFfmpegCapabilities(FFMPEG);
        expect(res.timecodeBurnedIn).toBe(caps.filters.has('drawtext'));
        if (!caps.filters.has('drawtext')) expect((res.notes as string[])[0]).toMatch(/no drawtext filter/);
        expect(res.commandString.includes('drawtext')).toBe(caps.filters.has('drawtext'));
        const img = decodePng(fs.readFileSync(out));
        expect([img.width, img.height]).toEqual([3 * 160 + 2 * 4 + 2 * 4, 3 * 90 + 2 * 4 + 2 * 4]);
        // Every cell has picture in it (the test pattern is not black).
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                const x = 4 + c * 164 + 80;
                const y = 4 + r * 94 + 30;
                const i = (y * img.width + x) * 4;
                expect(img.data[i] + img.data[i + 1] + img.data[i + 2]).toBeGreaterThan(30);
            }
        }
        fs.mkdirSync(SCREENSHOTS, { recursive: true });
        fs.copyFileSync(out, path.join(SCREENSHOTS, 'ffmpeg_batched_video_ops_storyboard_sheet.png'));
    });

    it('encodes VP9 with row multithreading and the good deadline', async () => {
        const out = path.join(DIR, 'out.webm');
        const res = await editor.quickEdit({ inputPath: VIDEO, outputPath: out, format: 'webm', trim: { startSec: 0, durationSec: 1 } });
        expect(res.commandString).toContain(['-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', ...VP9_SPEED_ARGS].join(' '));
        const meta = await editor.probeMedia(out);
        expect(meta.width).toBe(320);
    });

    it('chooses the H.264 encoder by the capability check and names it in the command', async () => {
        const caps = await getFfmpegCapabilities(FFMPEG);
        expect(caps.version).toMatch(/^ffmpeg version/);
        expect(caps.encoders.has('libx264')).toBe(true);
        // Cached: the same measurement object is returned.
        expect(await getFfmpegCapabilities(FFMPEG)).toBe(caps);
        const out = path.join(DIR, 'out.mp4');
        const res = await editor.quickEdit({ inputPath: VIDEO, outputPath: out, trim: { startSec: 0, durationSec: 1 } });
        expect(res.commandString).toContain(caps.h264VideoToolbox ? '-c:v h264_videotoolbox' : '-c:v libx264 -preset veryfast');
        const pinned = await editor.quickEdit({ inputPath: VIDEO, outputPath: path.join(DIR, 'pinned.mp4'), preset: 'fast', trim: { startSec: 0, durationSec: 1 } });
        expect(pinned.commandString).toContain('-c:v libx264 -preset fast');
        for (const f of [out, path.join(DIR, 'pinned.mp4')]) {
            const meta = await editor.probeMedia(f);
            expect([meta.width, meta.height]).toEqual([320, 180]);
        }
        expect(await new HeadlessVideoCompositorService(FFMPEG).isFfmpegAvailable()).toBe(true);
        expect(await new HeadlessVideoCompositorService(path.join(DIR, 'no_such_ffmpeg')).isFfmpegAvailable()).toBe(false);
    });
});
