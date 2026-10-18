import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerformerPoseTrackService } from '../src/node/spatial/PerformerPoseTrackService';
import { GvhmrBodyService } from '../src/node/spatial/GvhmrBodyService';
import { VideoTo4DPerformerPipelineService } from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

// A stand-in executable that just takes a while: the services must wait for it without blocking the event loop.
let dir: string;
let slow: string;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-child-loop-'));
    slow = path.join(dir, 'slow-child');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 1.5\nexit 3\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'hmr4d'));
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'not really a video');
    fs.writeFileSync(path.join(dir, 'mask.png'), 'x');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** Runs `work` while counting 20 ms timer ticks; a blocked event loop gets (almost) none. */
async function ticksDuring(work: () => Promise<unknown>): Promise<{ ticks: number; ms: number; error: unknown }> {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    let error: unknown;
    try {
        await work();
    } catch (err) {
        error = err;
    } finally {
        clearInterval(timer);
    }
    return { ticks, ms: Date.now() - t0, error };
}

describe('long child processes never freeze the server', () => {
    it('MediaPipe pose tracking waits asynchronously and reports the failure', async () => {
        const r = await ticksDuring(() => new PerformerPoseTrackService().trackVideo(path.join(dir, 'clip.mp4'), { pythonBinary: slow }));
        expect(r.ms).toBeGreaterThan(1200);
        expect(r.ticks).toBeGreaterThan(30);
        expect(String((r.error as Error)?.message)).toContain('MediaPipe pose tracking failed');
    });

    it('GVHMR waits asynchronously and is killed by its abort signal', async () => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 150);
        const r = await ticksDuring(() =>
            new GvhmrBodyService().run(path.join(dir, 'clip.mp4'), dir, { pythonBinary: slow, gvhmrRoot: dir, signal: ctrl.signal })
        );
        expect(r.ms).toBeLessThan(1000);
        expect(r.ticks).toBeGreaterThan(3);
        expect((r.error as Error)?.name).toBe('AbortError');
    });

    it('the 4D performer pipeline reads frames through ffmpeg asynchronously and abortably', async () => {
        vi.stubEnv('FFMPEG_PATH', slow);
        const pipeline = new VideoTo4DPerformerPipelineService();
        const waited = await ticksDuring(() => pipeline.readGrayMask(path.join(dir, 'mask.png'), 64, 128));
        expect(waited.ms).toBeGreaterThan(1200);
        expect(waited.ticks).toBeGreaterThan(30);

        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 150);
        const aborted = await ticksDuring(() => pipeline.readGrayMask(path.join(dir, 'mask.png'), 64, 128, ctrl.signal));
        expect(aborted.ms).toBeLessThan(1000);
        expect((aborted.error as Error)?.name).toBe('AbortError');
    });

    it('the Python runner has no synchronous entry points', () => {
        const proto = NativePythonRunnerService.prototype as any;
        expect(proto.runScriptSync).toBeUndefined();
        expect(proto.runScriptFileSync).toBeUndefined();
        expect(typeof proto.runScript).toBe('function');
    });
});
